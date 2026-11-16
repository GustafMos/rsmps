/**
 * A small pool of reusable workers that runs scan jobs in parallel. Pure scheduling: it never creates a Worker itself (the
 * caller passes `createWorker`), so everything here runs and is tested with fake workers.
 *
 * Rules:
 *  - Jobs start in submission order (no overtaking, so a big photo cannot starve).
 *  - At most `maxWorkers` run at once, and a job only starts when the estimated bytes of the running jobs plus its own fit the
 *    memory budget. One job always runs, however big, so a huge photo still gets scanned (alone).
 *  - Workers are created on demand, reused for the next job and terminated after `idleMs` without work, so an idle tab holds
 *    no worker memory.
 *  - A job that fails (error reply or worker crash) rejects only itself; its worker is replaced if it crashed.
 *  - Aborting a queued job removes it; aborting a running one terminates its worker (the scan is synchronous CPU work and cannot
 *    be interrupted any other way), frees its slot and starts the next job.
 *  - If no worker can be created at all, every waiting and later job rejects with `PoolUnavailableError`: the caller then runs
 *    the sequential main-thread path.
 */

/** The part of `Worker` the pool uses. */
export interface PoolWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: any }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export class PoolUnavailableError extends Error {
  constructor(message = 'Workers are not available.') {
    super(message);
    this.name = 'PoolUnavailableError';
  }
}

export class PoolAbortError extends Error {
  constructor(message = 'The scan was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

/** An error reply of the worker itself (the job threw), as opposed to a crash. `code` is whatever the worker put in `error.code`. */
export class PoolJobError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'PoolJobError';
  }
}

export interface PoolOptions {
  createWorker: () => PoolWorker;
  /** Most workers (and so most jobs) at once. */
  maxWorkers: number;
  /** Bytes the running jobs may use together; read at every scheduling decision, so a changed budget applies to the next job. */
  memoryBudget: () => number;
  /** A worker that has had nothing to do for this long is terminated (default 30 s). */
  idleMs?: number;
}

export interface JobSpec {
  /** Sent to the worker as `{ id, ...message }`. */
  message: Record<string, unknown>;
  transfer?: Transferable[];
  /** Estimated peak bytes while running (`estimateJobBytes`). */
  cost: number;
  signal?: AbortSignal;
  /** Called when the job leaves the queue and is handed to a worker. */
  onStart?: () => void;
}

interface Slot {
  worker: PoolWorker;
  job: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Job {
  id: number;
  spec: JobSpec;
  resolve: (reply: any) => void;
  reject: (error: Error) => void;
  slot: Slot | null;
  onAbort: (() => void) | null;
}

export const DEFAULT_IDLE_MS = 30_000;

export class ScanPool {
  private queue: Job[] = [];
  private slots: Slot[] = [];
  private running = new Set<Job>();
  private runningBytes = 0;
  private nextId = 1;
  private limit: number;
  private unavailable = false;
  private disposed = false;

  constructor(private opts: PoolOptions) {
    this.limit = Math.max(1, Math.floor(opts.maxWorkers));
  }

  get stats(): { workers: number; running: number; queued: number; limit: number; unavailable: boolean } {
    return { workers: this.slots.length, running: this.running.size, queued: this.queue.length, limit: this.limit, unavailable: this.unavailable };
  }

  /** Run a job; resolves with the worker's reply message (`{ id, ... }`). */
  submit<R = any>(spec: JobSpec): Promise<R> {
    if (this.disposed) return Promise.reject(new PoolAbortError('The scan pool was shut down.'));
    if (this.unavailable) return Promise.reject(new PoolUnavailableError());
    if (spec.signal?.aborted) return Promise.reject(new PoolAbortError());
    return new Promise<R>((resolve, reject) => {
      const job: Job = { id: this.nextId++, spec, resolve, reject, slot: null, onAbort: null };
      if (spec.signal) {
        job.onAbort = () => this.abort(job);
        spec.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  /** Terminate every worker and reject everything waiting or running. */
  dispose(): void {
    this.disposed = true;
    for (const job of [...this.queue, ...this.running]) this.settle(job, new PoolAbortError('The scan pool was shut down.'));
    this.queue = [];
    this.running.clear();
    this.runningBytes = 0;
    for (const slot of this.slots) this.kill(slot);
    this.slots = [];
  }

  private budget(): number {
    const b = this.opts.memoryBudget();
    return Number.isFinite(b) && b > 0 ? b : Number.POSITIVE_INFINITY;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const job = this.queue[0];
      if (this.running.size >= this.limit) return;
      if (this.running.size > 0 && this.runningBytes + job.spec.cost > this.budget()) return;
      const slot = this.slots.find((s) => s.job === null) ?? this.grow();
      if (!slot) {
        if (this.slots.length === 0) {
          // not a single worker could be created: everyone falls back to the main thread
          this.unavailable = true;
          const waiting = this.queue;
          this.queue = [];
          for (const j of waiting) this.settle(j, new PoolUnavailableError());
        } else {
          // some worker exists but no more can be made: work with what there is
          this.limit = Math.max(1, this.slots.length);
        }
        return;
      }
      this.queue.shift();
      this.start(job, slot);
    }
  }

  private grow(): Slot | null {
    let worker: PoolWorker;
    try {
      worker = this.opts.createWorker();
    } catch {
      return null;
    }
    const slot: Slot = { worker, job: null, idleTimer: null };
    worker.onmessage = (e) => this.onReply(slot, e.data);
    worker.onerror = () => this.onCrash(slot);
    this.slots.push(slot);
    return slot;
  }

  private start(job: Job, slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.job = job;
    job.slot = slot;
    this.running.add(job);
    this.runningBytes += job.spec.cost;
    try {
      job.spec.onStart?.();
      slot.worker.postMessage({ id: job.id, ...job.spec.message }, job.spec.transfer ?? []);
    } catch (err) {
      // e.g. the message could not be cloned: this job fails, the worker is fine
      this.release(job);
      this.settle(job, err instanceof Error ? err : new Error(String(err)));
      this.pump();
    }
  }

  private onReply(slot: Slot, data: any): void {
    const job = slot.job;
    if (!job || !data || data.id !== job.id) return; // a reply of a job that was aborted, or noise
    this.release(job);
    if (typeof data.error === 'string') this.settle(job, new PoolJobError(data.error, typeof data.code === 'string' ? data.code : undefined));
    else this.settle(job, null, data);
    this.pump();
  }

  private onCrash(slot: Slot): void {
    const job = slot.job;
    this.drop(slot);
    if (job) {
      this.release(job);
      this.settle(job, new Error('The scan worker stopped unexpectedly.'));
    }
    this.pump();
  }

  private abort(job: Job): void {
    const q = this.queue.indexOf(job);
    if (q >= 0) {
      this.queue.splice(q, 1);
      this.settle(job, new PoolAbortError());
      this.pump();
      return;
    }
    if (!this.running.has(job)) return;
    const slot = job.slot;
    this.release(job);
    if (slot) this.drop(slot);
    this.settle(job, new PoolAbortError());
    this.pump();
  }

  /** The job no longer occupies its worker; the worker goes idle (and is reaped after `idleMs`). */
  private release(job: Job): void {
    if (!this.running.delete(job)) return;
    this.runningBytes = Math.max(0, this.runningBytes - job.spec.cost);
    const slot = job.slot;
    job.slot = null;
    if (slot && slot.job === job) {
      slot.job = null;
      if (this.slots.includes(slot)) this.armIdle(slot);
    }
  }

  private armIdle(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    const t = setTimeout(() => {
      if (slot.job === null) this.drop(slot);
    }, this.opts.idleMs ?? DEFAULT_IDLE_MS);
    (t as { unref?: () => void }).unref?.();
    slot.idleTimer = t;
  }

  /** Remove a worker from the pool and terminate it. */
  private drop(slot: Slot): void {
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    this.kill(slot);
  }

  private kill(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    try {
      slot.worker.terminate();
    } catch {
      /* already gone */
    }
  }

  private settle(job: Job, error: Error | null, reply?: unknown): void {
    if (job.onAbort) job.spec.signal?.removeEventListener('abort', job.onAbort);
    job.onAbort = null;
    if (error) job.reject(error);
    else job.resolve(reply);
  }
}

/* ------------------------------------------------------------------------------------------------------------------- */
/* How many jobs, and how much memory one needs                                                                         */
/* ------------------------------------------------------------------------------------------------------------------- */

const MB = 1024 * 1024;

/**
 * Peak bytes of one scan job per decoded photo pixel. Measured: one 3000 x 4000 synthetic photo scanned in a worker thread
 * raised the process RSS by 161 MB (13.4 bytes per pixel), four at once by 645 MB. That is the decoded RGBA photo (4), its grey
 * copy (1), the rectified page as RGBA (about 1.7 at 9 px/mm for A4 from 12 MP) with its float grey (1.7) and the integral image
 * of the mark search (3.3), plus frames, thumbnail and allocator slack. In the browser the decode adds an ImageBitmap and a
 * canvas copy (8 more, transient, gone before the scan allocates its working set), which is the same order, so 14 covers both.
 */
export const JOB_BYTES_PER_PIXEL = 14;
/** Fixed cost of a job: the worker's own JS heap, code and the encoded file. */
export const JOB_FIXED_BYTES = 48 * MB;
/** Used when a photo's size cannot be read from its header (HEIC, TIFF...): the biggest photo the scanner accepts. */
export const UNKNOWN_PIXELS = 25_000_000;
/** Budget used when the host exposes no RAM budget. */
export const FALLBACK_BUDGET_BYTES = 1536 * MB;
/** Hard upper bound on parallel scans: more than this only adds memory pressure and contention with the UI and the GPU. */
export const MAX_PARALLEL_SCANS = 4;

export function estimateJobBytes(pixels: number): number {
  return Math.round(Math.max(1, pixels) * JOB_BYTES_PER_PIXEL + JOB_FIXED_BYTES);
}

/** N = clamp(cores - 1, 1, 4): one core stays free for the UI. */
export function defaultWorkerCount(hardwareConcurrency: number | undefined): number {
  const n = Number.isFinite(hardwareConcurrency) && (hardwareConcurrency as number) > 0 ? Math.floor(hardwareConcurrency as number) : 2;
  return Math.min(MAX_PARALLEL_SCANS, Math.max(1, n - 1));
}

/**
 * How many of these jobs the pool is guaranteed to run at once: never more than `maxWorkers`, and few enough that even the
 * biggest ones together fit the budget (at least 1). The pool itself decides per job in order, so it can exceed this when
 * the biggest photos happen to be queued apart.
 */
export function concurrencyFor(costs: number[], maxWorkers: number, budget: number): number {
  if (costs.length === 0) return 1;
  const sorted = [...costs].sort((a, b) => b - a);
  let sum = 0;
  let k = 0;
  for (const c of sorted) {
    if (k >= maxWorkers) break;
    if (k > 0 && sum + c > budget) break;
    sum += c;
    k++;
  }
  return Math.max(1, Math.min(k, costs.length));
}
