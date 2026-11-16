import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolAbortError, PoolJobError, PoolUnavailableError, ScanPool, concurrencyFor, defaultWorkerCount, estimateJobBytes, type PoolWorker } from './pool';

class FakeWorker implements PoolWorker {
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  posted: { id: number; msg: any; transfer?: Transferable[] }[] = [];
  postMessage(message: any, transfer?: Transferable[]): void {
    this.posted.push({ id: message.id, msg: message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  /** What the real worker would send back. Ignored after terminate, like a real terminated worker. */
  reply(id: number, data: object = {}): void {
    if (!this.terminated) this.onmessage?.({ data: { id, ...data } });
  }
  get lastId(): number {
    return this.posted[this.posted.length - 1].id;
  }
}

function setup(o: { max?: number; budget?: number; idleMs?: number; failAfter?: number } = {}) {
  const workers: FakeWorker[] = [];
  const pool = new ScanPool({
    maxWorkers: o.max ?? 2,
    memoryBudget: () => o.budget ?? Number.POSITIVE_INFINITY,
    idleMs: o.idleMs,
    createWorker: () => {
      if (o.failAfter !== undefined && workers.length >= o.failAfter) throw new Error('no more workers');
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  const started: number[] = [];
  const job = (n: number, cost = 1, signal?: AbortSignal) =>
    pool.submit<{ id: number; value?: number }>({ message: { n }, cost, signal, onStart: () => started.push(n) });
  /** The worker currently running job n. */
  const runner = (n: number) => workers.find((w) => w.posted.some((p) => p.msg.n === n))!;
  const idOf = (n: number) => runner(n).posted.find((p) => p.msg.n === n)!.id;
  return { pool, workers, started, job, runner, idOf };
}

afterEach(() => vi.useRealTimers());

describe('ScanPool scheduling', () => {
  it('never runs more jobs than the worker cap and reuses workers', async () => {
    const { pool, workers, started, job, runner, idOf } = setup({ max: 2 });
    const done: number[] = [];
    const ps = [1, 2, 3, 4, 5].map((n) => job(n).then(() => done.push(n)));
    expect(started).toEqual([1, 2]);
    expect(pool.stats).toMatchObject({ running: 2, queued: 3, workers: 2 });
    runner(1).reply(idOf(1));
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    runner(3).reply(idOf(3));
    runner(2).reply(idOf(2));
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3, 4, 5]);
    runner(4).reply(idOf(4));
    runner(5).reply(idOf(5));
    await Promise.all(ps);
    expect(workers).toHaveLength(2); // reused, never a third
    expect(pool.stats.running).toBe(0);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the running bytes under the budget with mixed photo sizes, in submission order', async () => {
    const { pool, started, job, runner, idOf } = setup({ max: 4, budget: 1000 });
    const ps = [job(1, 600), job(2, 600), job(3, 300), job(4, 300), job(5, 300)];
    expect(started).toEqual([1]); // 600 + 600 > 1000, and 3 does not overtake 2
    runner(1).reply(idOf(1));
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]); // 600 + 300 = 900; a 4th would make 1200
    expect(pool.stats.running).toBe(2);
    runner(3).reply(idOf(3));
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3, 4]);
    runner(2).reply(idOf(2));
    runner(4).reply(idOf(4));
    await Promise.resolve();
    runner(5).reply(idOf(5));
    await Promise.all(ps);
  });

  it('runs a photo that is bigger than the whole budget, alone', async () => {
    const { pool, started, job, runner, idOf } = setup({ max: 4, budget: 100 });
    const ps = [job(1, 5000), job(2, 10)];
    expect(started).toEqual([1]);
    expect(pool.stats.running).toBe(1);
    runner(1).reply(idOf(1));
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    runner(2).reply(idOf(2));
    await Promise.all(ps);
  });

  it('a smaller budget read later applies to the next job', async () => {
    let budget = 10_000;
    const workers: FakeWorker[] = [];
    const pool = new ScanPool({ maxWorkers: 4, memoryBudget: () => budget, createWorker: () => (workers[workers.push(new FakeWorker()) - 1]) });
    const a = pool.submit({ message: { n: 1 }, cost: 400 });
    budget = 500;
    const b = pool.submit({ message: { n: 2 }, cost: 400 });
    expect(pool.stats).toMatchObject({ running: 1, queued: 1 });
    workers[0].reply(workers[0].lastId);
    await a;
    await Promise.resolve();
    workers[0].reply(workers[0].lastId);
    await b;
  });

  it('delivers each reply to its own job whatever order they finish in', async () => {
    const { workers, job, idOf } = setup({ max: 4 });
    const ps = [1, 2, 3, 4].map((n) => job(n));
    for (const n of [4, 3, 2, 1]) workers[n - 1].reply(idOf(n), { value: n * 10 });
    const out = await Promise.all(ps);
    expect(out.map((r) => r.value)).toEqual([10, 20, 30, 40]);
  });
});

describe('ScanPool failures', () => {
  it('a job error rejects only that job; the worker keeps working', async () => {
    const { workers, job, runner, idOf } = setup({ max: 1 });
    const a = job(1);
    const b = job(2);
    const c = job(3);
    const assertA = expect(a).rejects.toMatchObject({ name: 'PoolJobError', message: 'boom', code: 'x' });
    runner(1).reply(idOf(1), { error: 'boom', code: 'x' });
    await assertA;
    await Promise.resolve();
    runner(2).reply(idOf(2), { value: 2 });
    expect((await b).value).toBe(2);
    await Promise.resolve();
    runner(3).reply(idOf(3), { value: 3 });
    expect((await c).value).toBe(3);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
  });

  it('a crashed worker fails its job, is replaced, and the others go on', async () => {
    const { pool, workers, job, runner, idOf } = setup({ max: 2 });
    const a = job(1);
    const b = job(2);
    const c = job(3);
    const assertA = expect(a).rejects.toThrow(/stopped/);
    workers[0].onerror?.(new Error('oom'));
    await assertA;
    expect(workers[0].terminated).toBe(true);
    await Promise.resolve();
    expect(workers).toHaveLength(3); // job 3 got a fresh worker
    expect(pool.stats.running).toBe(2);
    runner(2).reply(idOf(2), { value: 2 });
    runner(3).reply(idOf(3), { value: 3 });
    expect([(await b).value, (await c).value]).toEqual([2, 3]);
  });

  it('a message that cannot be sent fails that job only', async () => {
    const { workers, job } = setup({ max: 1 });
    const first = job(1);
    workers[0].postMessage = () => {
      throw new Error('DataCloneError');
    };
    // the first job is already running; make the NEXT start throw
    const second = job(2);
    workers[0].reply(workers[0].lastId, { value: 1 });
    await first;
    await expect(second).rejects.toThrow(/DataCloneError/);
  });

  it('falls back (rejects with PoolUnavailableError) when no worker can be created, now and later', async () => {
    const { pool, job } = setup({ failAfter: 0 });
    const a = job(1);
    const b = job(2);
    await expect(a).rejects.toBeInstanceOf(PoolUnavailableError);
    await expect(b).rejects.toBeInstanceOf(PoolUnavailableError);
    expect(pool.stats.unavailable).toBe(true);
    await expect(job(3)).rejects.toBeInstanceOf(PoolUnavailableError);
  });

  it('works with the workers it has when a further one cannot be created', async () => {
    const { pool, workers, started, job, runner, idOf } = setup({ max: 4, failAfter: 1 });
    const ps = [job(1), job(2), job(3)];
    expect(started).toEqual([1]);
    expect(pool.stats.limit).toBe(1);
    runner(1).reply(idOf(1));
    await Promise.resolve();
    runner(2).reply(idOf(2));
    await Promise.resolve();
    runner(3).reply(idOf(3));
    await Promise.all(ps);
    expect(workers).toHaveLength(1);
  });
});

describe('ScanPool cancel', () => {
  it('a queued job is removed and never started', async () => {
    const { pool, started, job, runner, idOf } = setup({ max: 1 });
    const ac = new AbortController();
    const a = job(1);
    const b = job(2, 1, ac.signal);
    const c = job(3);
    const assertB = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    ac.abort();
    await assertB;
    expect(pool.stats.queued).toBe(1);
    runner(1).reply(idOf(1));
    await a;
    await Promise.resolve();
    expect(started).toEqual([1, 3]);
    runner(3).reply(idOf(3));
    await c;
  });

  it('a running job terminates its worker, frees the slot and the memory, and the next job starts on a fresh worker', async () => {
    const { pool, workers, started, job, runner, idOf } = setup({ max: 1, budget: 500 });
    const ac = new AbortController();
    const a = job(1, 400, ac.signal);
    const b = job(2, 400);
    expect(started).toEqual([1]);
    const assertA = expect(a).rejects.toBeInstanceOf(PoolAbortError);
    const dead = workers[0];
    const deadId = idOf(1);
    ac.abort();
    await assertA;
    expect(dead.terminated).toBe(true);
    expect(started).toEqual([1, 2]);
    expect(workers).toHaveLength(2);
    expect(pool.stats.running).toBe(1);
    dead.reply(deadId, { value: 99 }); // a late reply from the terminated worker is ignored
    runner(2).reply(idOf(2), { value: 2 });
    expect((await b).value).toBe(2);
  });

  it('an already aborted signal never queues the job', async () => {
    const { pool, job } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(job(1, 1, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.stats).toMatchObject({ queued: 0, running: 0, workers: 0 });
  });

  it('dispose terminates everything and rejects what waits', async () => {
    const { pool, workers, job } = setup({ max: 1 });
    const a = job(1);
    const b = job(2);
    const assertions = [expect(a).rejects.toBeInstanceOf(PoolAbortError), expect(b).rejects.toBeInstanceOf(PoolAbortError)];
    pool.dispose();
    await Promise.all(assertions);
    expect(workers.every((w) => w.terminated)).toBe(true);
    await expect(job(3)).rejects.toBeInstanceOf(PoolAbortError);
  });
});

describe('ScanPool idle', () => {
  it('terminates idle workers after the timeout and creates a new one for the next job', async () => {
    vi.useFakeTimers();
    const { pool, workers, job, runner, idOf } = setup({ max: 2, idleMs: 5000 });
    const a = job(1);
    runner(1).reply(idOf(1));
    await a;
    vi.advanceTimersByTime(4000);
    expect(workers[0].terminated).toBe(false);
    // reused within the window, and the timer restarts when it is done again
    const b = job(2);
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(10_000); // busy workers are never reaped
    expect(workers[0].terminated).toBe(false);
    runner(2).reply(idOf(2));
    await b;
    vi.advanceTimersByTime(5001);
    expect(workers[0].terminated).toBe(true);
    expect(pool.stats.workers).toBe(0);
    const c = job(3);
    expect(workers).toHaveLength(2);
    runner(3).reply(idOf(3));
    await c;
  });
});

describe('concurrency and memory planning', () => {
  const MB = 1024 * 1024;
  it('uses cores - 1, between 1 and 4', () => {
    expect(defaultWorkerCount(1)).toBe(1);
    expect(defaultWorkerCount(2)).toBe(1);
    expect(defaultWorkerCount(4)).toBe(3);
    expect(defaultWorkerCount(16)).toBe(4);
    expect(defaultWorkerCount(undefined)).toBe(1);
    expect(defaultWorkerCount(0)).toBe(1);
  });

  it('big photos run fewer at a time than small ones', () => {
    const small = estimateJobBytes(12e6);
    const big = estimateJobBytes(25e6);
    expect(big).toBeGreaterThan(small);
    expect(concurrencyFor(Array(10).fill(small), 4, 1536 * MB)).toBe(4);
    expect(concurrencyFor(Array(10).fill(big), 4, 1000 * MB)).toBe(2);
    expect(concurrencyFor(Array(10).fill(big), 4, 256 * MB)).toBe(1);
    expect(concurrencyFor([small], 4, 1536 * MB)).toBe(1);
    expect(concurrencyFor([], 4, 1)).toBe(1);
  });

  it('is limited by the largest photos in the set', () => {
    const costs = [estimateJobBytes(4e6), estimateJobBytes(4e6), estimateJobBytes(25e6), estimateJobBytes(25e6)];
    expect(concurrencyFor(costs, 4, 800 * MB)).toBe(2);
  });
});

describe('PoolJobError', () => {
  it('carries the worker error code', () => {
    expect(new PoolJobError('x', 'no-decode').code).toBe('no-decode');
  });
});
