import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT, type GraphDoc } from '../engine/types';
import { JobQueue, QUEUE_MAX_JOBS, etaSeconds, formatEta, safePathParts, type JobRunner, type QueueJob, type QueueStorage, type StoredQueue } from './queue';

const graph = (name = 'p'): GraphDoc => ({ schema: 'rsmps/graph', version: 2, name, project: { ...DEFAULT_PROJECT }, nodes: [], edges: [] });
const input = (name: string) => ({ name, source: { kind: 'current' } as const, graph: graph(name), outputs: [{ id: 'o1', label: 'Out 1', enabled: true }, { id: 'o2', label: 'Out 2', enabled: false }] });

/** A fake exporter: records what ran; a job fails or waits when its name says so. */
class FakeRunner implements JobRunner {
  ran: { name: string; outputs: string[] }[] = [];
  betweenCalls = 0;
  finishedWith: string[] = [];
  gates = new Map<string, () => void>();
  async run(job: QueueJob, onProgress: (f: number, l: string) => void, signal: AbortSignal) {
    this.ran.push({ name: job.name, outputs: job.outputs.filter((o) => o.enabled).map((o) => o.id) });
    onProgress(0.5, 'halfway');
    if (job.name.startsWith('fail')) throw new Error('boom');
    if (job.name.startsWith('wait')) {
      await new Promise<void>((resolve, reject) => {
        this.gates.set(job.name, resolve);
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    return { files: [`${job.name}.png`] };
  }
  async between() {
    this.betweenCalls++;
  }
  async finished(w: string) {
    this.finishedWith.push(w);
  }
}

class MemStorage implements QueueStorage {
  saved: StoredQueue | null = null;
  async load() {
    return this.saved ? structuredClone(this.saved) : null;
  }
  async save(q: StoredQueue) {
    this.saved = structuredClone(q);
  }
}

const statuses = (q: JobQueue) => q.get().jobs.map((j) => j.status);

describe('JobQueue', () => {
  it('runs pending jobs in order, one at a time, with only the enabled outputs, and frees memory between jobs', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    q.add(input('a'));
    q.add(input('b'));
    await q.start();
    expect(r.ran).toEqual([{ name: 'a', outputs: ['o1'] }, { name: 'b', outputs: ['o1'] }]);
    expect(statuses(q)).toEqual(['done', 'done']);
    expect(q.get().jobs[0].files).toEqual(['a.png']);
    expect(r.betweenCalls).toBe(2);
    expect(r.finishedWith).toEqual(['nothing']);
    expect(q.get().running).toBe(false);
  });

  it('a failing job is marked failed with its message and the queue goes on; retry runs it again', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    q.add(input('fail1'));
    q.add(input('ok'));
    await q.start();
    expect(statuses(q)).toEqual(['failed', 'done']);
    expect(q.get().jobs[0].message).toBe('boom');
    q.retry(q.get().jobs[0].id);
    expect(q.get().jobs[0].status).toBe('pending');
    r.ran = [];
    await q.start();
    expect(r.ran.map((x) => x.name)).toEqual(['fail1']);
  });

  it('reorders pending jobs, duplicates with different outputs, removes', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    const a = q.add(input('a'));
    q.add(input('b'));
    q.move(a.id, 1);
    expect(q.get().jobs.map((j) => j.name)).toEqual(['b', 'a']);
    q.move(a.id, 5); // already last: no change
    expect(q.get().jobs.map((j) => j.name)).toEqual(['b', 'a']);
    const copy = q.duplicate(a.id)!;
    expect(q.get().jobs.map((j) => j.name)).toEqual(['b', 'a', 'a (copy)']);
    q.setOutputEnabled(copy.id, 'o2', true);
    q.setOutputEnabled(copy.id, 'o1', false);
    q.remove(q.get().jobs[0].id);
    await q.start();
    expect(r.ran).toEqual([{ name: 'a', outputs: ['o1'] }, { name: 'a (copy)', outputs: ['o2'] }]);
  });

  it('skipping a pending job leaves it out', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    q.add(input('a'));
    const b = q.add(input('b'));
    q.skip(b.id);
    await q.start();
    expect(r.ran.map((x) => x.name)).toEqual(['a']);
    expect(statuses(q)).toEqual(['done', 'skipped']);
  });

  it('pause lets the running job finish and holds; resume continues', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    q.add(input('wait1'));
    q.add(input('b'));
    const run = q.start();
    await Promise.resolve();
    expect(q.get().jobs[0].status).toBe('running');
    q.pause();
    r.gates.get('wait1')!();
    await run;
    expect(statuses(q)).toEqual(['done', 'pending']);
    expect(q.get().running).toBe(false);
    expect(r.finishedWith).toEqual([]); // not finished: a job is waiting
    q.resume();
    await new Promise((res) => setTimeout(res, 0));
    await q.start();
    expect(statuses(q)).toEqual(['done', 'done']);
    expect(r.finishedWith).toEqual(['nothing']);
  });

  it('cancel stops the running job (skipped) and the next one runs', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    q.add(input('wait1'));
    q.add(input('b'));
    const run = q.start();
    await Promise.resolve();
    q.cancelCurrent();
    await run;
    expect(statuses(q)).toEqual(['skipped', 'done']);
    expect(q.get().jobs[0].message).toBe('Stopped.');
  });

  it('the running job cannot be removed or reordered', async () => {
    const r = new FakeRunner();
    const q = new JobQueue(r);
    const a = q.add(input('wait1'));
    q.add(input('b'));
    const run = q.start();
    await Promise.resolve();
    q.remove(a.id);
    q.move(a.id, 1);
    expect(q.get().jobs.map((j) => j.name)).toEqual(['wait1', 'b']);
    q.setOutputEnabled(a.id, 'o2', true);
    expect(q.get().jobs[0].outputs[1].enabled).toBe(false);
    q.cancelCurrent();
    await run;
  });

  it('persists, and a job that was running comes back as interrupted (and the queue starts paused)', async () => {
    const storage = new MemStorage();
    const r = new FakeRunner();
    const q = new JobQueue(r, storage);
    q.add(input('wait1'));
    q.add(input('b'));
    q.setWhenFinished('sleep');
    void q.start();
    await Promise.resolve();
    await q.flush();
    expect(storage.saved!.jobs[0].status).toBe('running');

    const q2 = new JobQueue(new FakeRunner(), storage);
    await q2.restore();
    expect(statuses(q2)).toEqual(['interrupted', 'pending']);
    expect(q2.get().jobs[0].message).toMatch(/Interrupted/);
    expect(q2.get().paused).toBe(true);
    expect(q2.get().whenFinished).toBe('sleep');
    q2.retry(q2.get().jobs[0].id);
    expect(q2.get().jobs[0].status).toBe('pending');
    r.gates.get('wait1')?.();
  });

  it('keeps the graph as a snapshot (later edits to the source do not change the job)', () => {
    const q = new JobQueue(new FakeRunner());
    const g = graph('x');
    const job = q.add({ ...input('x'), graph: g });
    g.name = 'changed';
    expect(job.graph.name).toBe('x');
  });

  it('refuses more jobs than the cap', () => {
    const q = new JobQueue(new FakeRunner());
    for (let i = 0; i < QUEUE_MAX_JOBS; i++) q.add(input(`j${i}`));
    expect(() => q.add(input('one more'))).toThrow(/full/);
  });

  it('clearFinished keeps what still has to run', async () => {
    const q = new JobQueue(new FakeRunner());
    q.add(input('a'));
    q.add(input('fail'));
    await q.start();
    q.add(input('c'));
    q.clearFinished();
    expect(q.get().jobs.map((j) => j.name)).toEqual(['c']);
  });
});

describe('queue helpers', () => {
  it('eta needs some progress, then extrapolates', () => {
    expect(etaSeconds(0, 0, 1000)).toBeNull();
    expect(etaSeconds(0.5, 0, 10_000 + 0)).toBeNull(); // no start time given as 0 is falsy: unknown
    expect(etaSeconds(0.5, 1, 10_001)).toBe(10);
    expect(etaSeconds(1, 1, 10_000)).toBeNull();
    expect(formatEta(null)).toBe('');
    expect(formatEta(30)).toBe('30 s left');
    expect(formatEta(600)).toBe('10 min left');
    expect(formatEta(7260)).toBe('2 h 1 min left');
  });
  it('safePathParts keeps files inside the chosen folder', () => {
    expect(safePathParts('a.png')).toEqual(['a.png']);
    expect(safePathParts('seq/frame_0001.png')).toEqual(['seq', 'frame_0001.png']);
    expect(safePathParts('../evil.png')).toBeNull();
    expect(safePathParts('a/../../evil.png')).toBeNull();
    expect(safePathParts('/etc/passwd')).toEqual(['etc', 'passwd']); // the leading slash is dropped: it lands inside the folder
    expect(safePathParts('C:\\Windows\\x.png')).toBeNull();
    expect(safePathParts('')).toBeNull();
    expect(safePathParts('bad:name?.png')).toEqual(['bad_name_.png']);
    expect(safePathParts('..')).toBeNull();
  });
});

describe('jobOutputs and jobGraph', () => {
  const reg = { get: (id: string) => (id === 'image-out' ? { category: 'output', title: 'Output' } : { category: 'filter', title: 'Blur' }) };
  const g: GraphDoc = {
    ...graph('p'),
    nodes: [
      { id: 'b', type: 'blur', x: 0, y: 0, params: {} },
      { id: 'o1', type: 'image-out', x: 0, y: 0, params: { name: '{name}' } },
      { id: 'o2', type: 'image-out', x: 0, y: 0, params: { enabled: false, name: 'sprite' } },
      { id: 'o3', type: 'image-out', x: 0, y: 0, params: {}, bypass: true, label: 'Hidden' },
    ],
  };
  it('lists outputs with their enabled state', async () => {
    const { jobOutputs } = await import('./queue');
    expect(jobOutputs(g, reg)).toEqual([
      { id: 'o1', label: 'Output', enabled: true },
      { id: 'o2', label: 'sprite', enabled: false },
      { id: 'o3', label: 'Hidden', enabled: false },
    ]);
  });
  it('applies the name pattern to output nodes only', async () => {
    const { jobGraph, jobOutputs } = await import('./queue');
    const q = new JobQueue(new FakeRunner());
    const job = q.add({ name: 'x', source: { kind: 'current' }, graph: g, outputs: jobOutputs(g, reg), namePattern: ' night_{index} ' });
    const out = jobGraph(job);
    expect(out.nodes.find((n) => n.id === 'o1')!.params.name).toBe('night_{index}');
    expect(out.nodes.find((n) => n.id === 'b')!.params.name).toBeUndefined();
    expect(jobGraph({ ...job, namePattern: '' })).toBe(job.graph);
  });
});
