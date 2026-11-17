/**
 * Render queue: the pure state machine (add / reorder / start / pause / skip / fail / retry / persist). It knows nothing about the GPU,
 * the exporter or the DOM: a `JobRunner` does the work, a `QueueStorage` keeps the jobs across reloads. The UI wires both
 * (ui/store/queue.ts). One job runs at a time (the engine is single-flight); "pause" lets the running job finish and then holds.
 */
import type { GraphDoc } from '../engine/types';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted';

export interface JobOutput {
  id: string;
  label: string;
  enabled: boolean;
}

export interface QueueJob {
  id: string;
  /** Shown in the list. */
  name: string;
  /** Where the snapshot came from. */
  source: { kind: 'tab'; projectId: string } | { kind: 'file'; fileName: string } | { kind: 'current' };
  /** The project as it was when added (assets stay in the library and are referenced by id). */
  graph: GraphDoc;
  outputs: JobOutput[];
  /** Overrides every Output node's name pattern when not empty (tokens as in the Output node). */
  namePattern: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  /** What is happening now ("sprite_03.png, frame 12/96"). */
  label: string;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Names of the files the job produced. */
  files: string[];
}

export type WhenFinished = 'nothing' | 'sleep';

export interface QueueState {
  jobs: QueueJob[];
  running: boolean;
  /** Hold after the running job (or before the first). */
  paused: boolean;
  currentId: string | null;
  whenFinished: WhenFinished;
}

export interface RunResult {
  files: string[];
}

export interface JobRunner {
  run(job: QueueJob, onProgress: (fraction: number, label: string) => void, signal: AbortSignal): Promise<RunResult>;
  /** Free caches between jobs. */
  between?(): Promise<void>;
  /** Everything finished: a desktop "sleep" hook. */
  finished?(when: WhenFinished): Promise<void>;
}

export interface QueueStorage {
  load(): Promise<StoredQueue | null>;
  save(q: StoredQueue): Promise<void>;
}

export interface StoredQueue {
  v: 1;
  jobs: QueueJob[];
  whenFinished: WhenFinished;
}

export const QUEUE_MAX_JOBS = 200;

export function describeJob(j: QueueJob): string {
  const on = j.outputs.filter((o) => o.enabled).length;
  return `${j.name}: ${on} of ${j.outputs.length} output${j.outputs.length === 1 ? '' : 's'}`;
}

/** Seconds left from progress and elapsed time, or null while it cannot be told yet. */
export function etaSeconds(progress: number, startedAt: number | undefined, now: number): number | null {
  if (!startedAt || progress < 0.02 || progress >= 1) return null;
  const elapsed = (now - startedAt) / 1000;
  return Math.max(0, Math.round((elapsed / progress) * (1 - progress)));
}

export function formatEta(s: number | null): string {
  if (s === null) return '';
  if (s < 60) return `${s} s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
}

/** Path parts of an exported file name that are safe to create inside a chosen folder (no "..", no absolute parts, no empty parts). */
export function safePathParts(name: string): string[] | null {
  const parts = name.split(/[\\/]+/).filter((p) => p.length > 0);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    // eslint-disable-next-line no-control-regex
    const clean = p.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
    if (!clean || clean === '.' || clean === '..' || /^[A-Za-z]:$/.test(p)) return null;
    out.push(clean.slice(0, 120));
  }
  return out;
}

export class JobQueue {
  private state: QueueState = { jobs: [], running: false, paused: false, currentId: null, whenFinished: 'nothing' };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private skipCurrent = false;
  private n = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private runner: JobRunner,
    private storage: QueueStorage | null = null,
    private now: () => number = Date.now,
  ) {}

  get(): QueueState {
    return this.state;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: Partial<QueueState>): void {
    this.state = { ...this.state, ...next };
    for (const l of [...this.listeners]) l();
    this.scheduleSave();
  }
  private patchJob(id: string, patch: Partial<QueueJob>): void {
    this.set({ jobs: this.state.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) });
  }
  private scheduleSave(): void {
    if (!this.storage) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 250);
  }
  /** Write the jobs now (also called before the page goes away). */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.storage) return;
    const jobs = this.state.jobs.map((j) => ({ ...j }));
    await this.storage.save({ v: 1, jobs, whenFinished: this.state.whenFinished }).catch(() => undefined);
  }

  /** Load the saved queue. A job that was running when the page went away is marked "interrupted" (retry it). The queue starts paused. */
  async restore(): Promise<void> {
    if (!this.storage) return;
    const saved = await this.storage.load().catch(() => null);
    if (!saved || saved.v !== 1 || !Array.isArray(saved.jobs)) return;
    const jobs = saved.jobs.slice(0, QUEUE_MAX_JOBS).map((j): QueueJob => (j.status === 'running' ? { ...j, status: 'interrupted', message: 'Interrupted: the app was closed or reloaded while this ran. Retry it.', progress: 0 } : j));
    this.set({ jobs, whenFinished: saved.whenFinished === 'sleep' ? 'sleep' : 'nothing', paused: true });
  }

  /* ------------------------------ editing ------------------------------ */

  add(input: { name: string; source: QueueJob['source']; graph: GraphDoc; outputs: JobOutput[]; namePattern?: string }): QueueJob {
    if (this.state.jobs.length >= QUEUE_MAX_JOBS) throw new Error(`The queue is full (${QUEUE_MAX_JOBS} jobs).`);
    const job: QueueJob = {
      id: `job${this.now().toString(36)}${(++this.n).toString(36)}`,
      name: input.name.trim() || 'Untitled',
      source: input.source,
      graph: structuredClone(input.graph),
      outputs: input.outputs.map((o) => ({ ...o })),
      namePattern: input.namePattern ?? '',
      status: 'pending',
      progress: 0,
      label: '',
      files: [],
    };
    this.set({ jobs: [...this.state.jobs, job] });
    return job;
  }

  remove(id: string): void {
    if (id === this.state.currentId) return; // cancel it first
    this.set({ jobs: this.state.jobs.filter((j) => j.id !== id) });
  }

  clearFinished(): void {
    this.set({ jobs: this.state.jobs.filter((j) => j.status === 'pending' || j.status === 'running' || j.status === 'interrupted') });
  }

  /** Move a job by `delta` places among the jobs that are not finished (the running one stays where it is). */
  move(id: string, delta: number): void {
    const jobs = [...this.state.jobs];
    const i = jobs.findIndex((j) => j.id === id);
    const j = i + Math.sign(delta);
    if (i < 0 || j < 0 || j >= jobs.length || jobs[i].status === 'running' || jobs[j].status === 'running') return;
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
    this.set({ jobs });
  }

  /** A copy right after the original, pending, with the same outputs (change them in the copy). */
  duplicate(id: string): QueueJob | null {
    const i = this.state.jobs.findIndex((j) => j.id === id);
    if (i < 0) return null;
    const src = this.state.jobs[i];
    const copy: QueueJob = { ...structuredClone(src), id: `job${this.now().toString(36)}${(++this.n).toString(36)}`, name: `${src.name} (copy)`, status: 'pending', progress: 0, label: '', message: undefined, startedAt: undefined, finishedAt: undefined, files: [] };
    const jobs = [...this.state.jobs];
    jobs.splice(i + 1, 0, copy);
    this.set({ jobs });
    return copy;
  }

  setOutputEnabled(id: string, outputId: string, enabled: boolean): void {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job || job.status === 'running') return;
    this.patchJob(id, { outputs: job.outputs.map((o) => (o.id === outputId ? { ...o, enabled } : o)) });
  }
  setNamePattern(id: string, namePattern: string): void {
    const job = this.state.jobs.find((j) => j.id === id);
    if (job && job.status !== 'running') this.patchJob(id, { namePattern });
  }
  rename(id: string, name: string): void {
    this.patchJob(id, { name: name.trim() || 'Untitled' });
  }
  setWhenFinished(w: WhenFinished): void {
    this.set({ whenFinished: w });
  }

  /** Back to pending (a failed, skipped or interrupted job). */
  retry(id: string): void {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job || job.status === 'running' || job.status === 'pending') return;
    this.patchJob(id, { status: 'pending', progress: 0, label: '', message: undefined, startedAt: undefined, finishedAt: undefined, files: [] });
  }

  /** Skip a pending job, or stop the running one (it is marked skipped). */
  skip(id: string): void {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.status === 'running') return this.cancelCurrent();
    if (job.status === 'pending' || job.status === 'interrupted') this.patchJob(id, { status: 'skipped', message: 'Skipped.' });
  }

  /* ------------------------------ running ------------------------------ */

  /** Run every pending job in order. Resolves when the queue is empty, paused or stopped. */
  start(): Promise<void> {
    if (this.loop) return this.loop;
    this.set({ paused: false });
    this.loop = this.drain().finally(() => {
      this.loop = null;
    });
    return this.loop;
  }

  pause(): void {
    this.set({ paused: true });
  }
  resume(): void {
    if (this.state.paused) void this.start();
  }

  /** Stop the running job now; it is marked skipped and the queue goes on with the next (use pause too to stop everything). */
  cancelCurrent(): void {
    if (!this.abort) return;
    this.skipCurrent = true;
    this.abort.abort();
  }

  private next(): QueueJob | undefined {
    return this.state.jobs.find((j) => j.status === 'pending');
  }

  private async drain(): Promise<void> {
    this.set({ running: true });
    let ranAny = false;
    try {
      for (let job = this.next(); job && !this.state.paused; job = this.next()) {
        ranAny = true;
        await this.runOne(job);
        await this.runner.between?.().catch(() => undefined);
      }
    } finally {
      this.set({ running: false, currentId: null });
    }
    if (ranAny && !this.state.paused && !this.next()) await this.runner.finished?.(this.state.whenFinished).catch(() => undefined);
  }

  private async runOne(job: QueueJob): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    this.skipCurrent = false;
    this.set({ currentId: job.id });
    this.patchJob(job.id, { status: 'running', progress: 0, label: 'Starting…', message: undefined, startedAt: this.now(), finishedAt: undefined, files: [] });
    try {
      const fresh = this.state.jobs.find((j) => j.id === job.id)!;
      const res = await this.runner.run(fresh, (fraction, label) => this.patchJob(job.id, { progress: Math.min(1, Math.max(0, fraction)), label }), ac.signal);
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.patchJob(job.id, { status: 'done', progress: 1, label: 'Done', files: res.files, finishedAt: this.now() });
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        this.patchJob(job.id, { status: 'skipped', message: this.skipCurrent ? 'Stopped.' : 'Cancelled.', finishedAt: this.now() });
      } else {
        this.patchJob(job.id, { status: 'failed', message: err instanceof Error ? err.message : String(err), finishedAt: this.now() });
      }
    } finally {
      this.abort = null;
      this.skipCurrent = false;
    }
  }
}

/* ------------------------------ from a project to a job ------------------------------ */

/** The Output nodes of a project as job outputs: switched on when the node is enabled and not bypassed (what "export everything" renders). */
export function jobOutputs(graph: GraphDoc, registry: { get(id: string): { category?: string; title?: string } | undefined }): JobOutput[] {
  const isOut = (n: { type: string }) => registry.get(n.type)?.category === 'output';
  return graph.nodes.filter(isOut).map((n) => ({
    id: n.id,
    label: n.label || (typeof n.params.name === 'string' && n.params.name !== '{name}' ? n.params.name : registry.get(n.type)?.title ?? n.type),
    enabled: !n.bypass && n.params.enabled !== false,
  }));
}

/** The graph a job renders: the snapshot with the job's file name pattern on every Output node (when it has one). */
export function jobGraph(job: QueueJob): GraphDoc {
  const pattern = job.namePattern.trim();
  if (!pattern) return job.graph;
  const ids = new Set(job.outputs.map((o) => o.id));
  return { ...job.graph, nodes: job.graph.nodes.map((n) => (ids.has(n.id) ? { ...n, params: { ...n.params, name: pattern } } : n)) };
}
