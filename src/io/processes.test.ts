import { describe, expect, it } from 'vitest';
import { ProcessScheduler, type JobControl, type JobSpec } from './processes';

/** A job whose body the test steps through by hand. */
function manual(project: string, node: string, opts: { gpu?: boolean; steps?: number } = {}) {
  const log: string[] = [];
  const gates: (() => void)[] = [];
  let ctlRef: JobControl | null = null;
  const spec: JobSpec<string> = {
    project,
    node,
    title: 'Test',
    gpu: opts.gpu ?? true,
    async run(ctl) {
      ctlRef = ctl;
      log.push(`start ${node}`);
      for (let i = 0; i < (opts.steps ?? 1); i++) {
        await ctl.yield();
        ctl.progress((i + 1) / (opts.steps ?? 1), `step ${i + 1}`);
        log.push(`step ${node}${i + 1}`);
        await new Promise<void>((r) => gates.push(r)); // wait for the test to release the step
      }
      return `done ${node}`;
    },
  };
  return {
    spec,
    log,
    /** Let the job run its current step and go on to the next. */
    release: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      gates.shift()?.();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    ctl: () => ctlRef,
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const make = (o: ConstructorParameters<typeof ProcessScheduler>[0] = {}) => new ProcessScheduler({ macroYield: async () => undefined, yieldEveryMs: 0, ...o });

describe('ProcessScheduler', () => {
  it('runs GPU jobs one at a time, in the order they were queued', async () => {
    const s = make();
    const a = manual('p', 'a');
    const b = manual('p', 'b');
    const c = manual('p', 'c');
    const ra = s.enqueue(a.spec);
    const rb = s.enqueue(b.spec);
    const rc = s.enqueue(c.spec);
    await flush();
    expect(s.list().map((j) => j.state)).toEqual(['running', 'queued', 'queued']);
    expect(b.log).toEqual([]);
    await a.release();
    await a.release();
    expect(await ra.done).toBe('done a');
    await flush();
    expect(s.list().map((j) => j.state)).toEqual(['done', 'running', 'queued']);
    expect(c.log).toEqual([]);
    await b.release();
    await b.release();
    await rb.done;
    await flush();
    await c.release();
    await c.release();
    expect(await rc.done).toBe('done c');
    expect([...a.log, ...b.log, ...c.log].filter((l) => l.startsWith('start'))).toEqual(['start a', 'start b', 'start c']);
  });

  it('lets a CPU job run beside the single GPU job', async () => {
    const s = make();
    const g = manual('p', 'gpu');
    const l = manual('p', 'light', { gpu: false });
    s.enqueue(g.spec);
    s.enqueue(l.spec);
    await flush();
    expect(s.list().map((j) => j.state)).toEqual(['running', 'running']);
  });

  it('honours a configured number of GPU jobs', async () => {
    const s = make({ maxGpu: 2 });
    for (const n of ['a', 'b', 'c']) s.enqueue(manual('p', n).spec);
    await flush();
    expect(s.list().map((j) => j.state)).toEqual(['running', 'running', 'queued']);
    s.setConcurrency(3);
    await flush();
    expect(s.list().map((j) => j.state)).toEqual(['running', 'running', 'running']);
  });

  it('one job per node: queueing a node again returns the job it already has', async () => {
    const s = make();
    const a = manual('p', 'a');
    const first = s.enqueue(a.spec);
    const again = s.enqueue(manual('p', 'a').spec);
    expect(again.id).toBe(first.id);
    expect(again.done).toBe(first.done);
    expect(s.list()).toHaveLength(1);
  });

  it('cancels a queued job at once and a running one at its next yield', async () => {
    const s = make();
    const a = manual('p', 'a', { steps: 3 });
    const b = manual('p', 'b');
    const ra = s.enqueue(a.spec);
    const rb = s.enqueue(b.spec);
    await flush();
    s.cancel(rb.id);
    await expect(rb.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.find('p', 'b')?.state).toBe('cancelled');
    expect(b.log).toEqual([]); // never started
    s.cancel(ra.id); // a is waiting at the end of step 1
    await a.release(); // it goes on to the yield of step 2 and finds itself cancelled
    await expect(ra.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.find('p', 'a')?.state).toBe('cancelled');
    expect(a.log).toEqual(['start a', 'step a1']); // stopped at the next yield: step 2 never ran
  });

  it('a failing job is reported, frees its slot, and can be retried from zero', async () => {
    const s = make();
    let attempts = 0;
    const bad: JobSpec<string> = {
      project: 'p',
      node: 'bad',
      title: 'Bad',
      gpu: true,
      async run() {
        attempts++;
        if (attempts === 1) throw new Error('detector exploded');
        return 'ok';
      },
    };
    const next = manual('p', 'next');
    const r = s.enqueue(bad);
    s.enqueue(next.spec);
    await expect(r.done).rejects.toThrow('detector exploded');
    await flush();
    expect(s.find('p', 'bad')).toMatchObject({ state: 'failed', error: 'detector exploded' });
    expect(next.log).toEqual(['start next', 'step next1']); // the failure did not block the queue
    await next.release(); // the other job finishes and frees the slot
    const again = s.retry(r.id)!;
    expect(await again.done).toBe('ok');
    expect(attempts).toBe(2);
    expect(s.find('p', 'bad')?.state).toBe('done');
  });

  it('holds queued jobs and pauses running ones while the user plays back, and continues afterwards', async () => {
    let playing = false;
    const s = make({ hold: () => (playing ? 'playback' : null) });
    const a = manual('p', 'a', { steps: 2 });
    const r = s.enqueue(a.spec);
    await flush();
    expect(s.find('p', 'a')?.state).toBe('running');
    expect(a.log).toEqual(['start a', 'step a1']); // waiting at the end of step 1
    playing = true; // the user presses play
    await a.release(); // step 1 ends, the job reaches the yield of step 2 and finds itself held
    await flush();
    expect(s.find('p', 'a')).toMatchObject({ state: 'paused', pausedFor: 'playback' });
    expect(a.log).toEqual(['start a', 'step a1']); // step 2 has not started
    // a job queued during playback does not start either
    const b = manual('p', 'b');
    s.enqueue(b.spec);
    await flush();
    expect(s.find('p', 'b')).toMatchObject({ state: 'queued', pausedFor: 'playback' });
    playing = false;
    s.poke();
    await flush();
    expect(s.find('p', 'a')?.state).toBe('running');
    await a.release();
    await a.release();
    expect(await r.done).toBe('done a');
    await flush();
    expect(b.log).toEqual(['start b', 'step b1']);
  });

  it('a paused job gives its GPU slot to another project\'s job; a project switch pauses and resumes', async () => {
    let active: string | null = 'A';
    const s = make({ activeProject: () => active });
    const a = manual('A', 'a', { steps: 2 });
    const b = manual('B', 'b');
    const ra = s.enqueue(a.spec);
    const rb = s.enqueue(b.spec);
    await flush();
    expect(s.find('A', 'a')?.state).toBe('running');
    expect(s.find('B', 'b')).toMatchObject({ state: 'queued', pausedFor: 'another project is open' }); // not this project: does not start
    active = 'B'; // the user opens project B while a waits at the end of step 1
    s.poke();
    await a.release(); // a reaches the yield of step 2 and finds its project closed
    await flush();
    expect(s.find('A', 'a')).toMatchObject({ state: 'paused', pausedFor: 'another project is open' });
    expect(s.find('B', 'b')?.state).toBe('running'); // B's job takes the slot
    await b.release();
    expect(await rb.done).toBe('done b');
    active = 'A'; // back to A: its job continues where it was
    s.poke();
    await flush();
    expect(s.find('A', 'a')?.state).toBe('running');
    await a.release();
    await a.release();
    expect(await ra.done).toBe('done a');
    expect(a.log).toEqual(['start a', 'step a1', 'step a2']); // not restarted
  });

  it('reports progress as UI state and emits events', async () => {
    const s = make();
    const events: string[] = [];
    s.subscribe((e) => events.push(`${e.type}${e.type === 'progress' ? `:${e.job.progress}` : ''}`));
    const a = manual('p', 'a', { steps: 2 });
    const r = s.enqueue(a.spec);
    await flush();
    await a.release();
    await a.release();
    await r.done;
    expect(events).toEqual(['added', 'started', 'progress:0.5', 'progress:1', 'done']);
    expect(s.find('p', 'a')).toMatchObject({ state: 'done', progress: 1 });
  });

  it('dismiss forgets a finished job, never an active one', async () => {
    const s = make();
    const a = manual('p', 'a');
    const r = s.enqueue(a.spec);
    await flush();
    s.dismiss(r.id);
    expect(s.list()).toHaveLength(1);
    await a.release();
    await r.done;
    s.dismiss(r.id);
    expect(s.list()).toHaveLength(0);
  });
});
