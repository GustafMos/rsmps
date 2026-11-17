/**
 * Process mode, IO side: a scheduler for long jobs (bake, clip analysis, anything a node declares in `NodeDef.process`) and the runner
 * that gives a job its `ProcessCtx` and stores what it produced.
 *
 *   ProcessScheduler   pure queue: single-flight GPU jobs, cancel, retry, pause while the user plays back / drags / rendering is paused
 *                      / another project is open. No DOM, no timers of its own (tests drive it with `poke()`).
 *   ProcessRuntime     the thin runtime: builds the job's context (pull through the EvalGate, staged store, encoder), commits staged items
 *                      to the media library under the node's owner (the SAME store bakes always used), reports state to the engine
 *                      (`Host.processLive`) and exposes `ProcessApi`.
 *   MemoryProcessLibrary  a library in RAM (tests and the CLI) that also answers the Host calls a process result is read through.
 *
 * Decisions (documented in docs/ENGINE.md, "Process mode"):
 *  - ONE GPU-heavy job runs at a time by default (`maxGpu`); jobs that declare `gpu: false` (CPU analysis) run beside it (`maxLight`).
 *  - Jobs belong to a project + node. A job of a project that is not the active one PAUSES at its next `yield()` (a project switch
 *    clears the engine cache, trims the GPU and drops decoded media, so running on would thrash all three) and resumes when the
 *    project is open again. Queued jobs of other projects do not start. Nothing is lost: the job keeps its state in memory.
 *  - Playback, dragging and "pause rendering" hold ALL jobs at their next `yield()`; they continue when that ends.
 *  - Nothing half-done is persisted. A job restarts from zero (no checkpoints: a job's results are staged in memory and committed
 *    atomically when it finishes, so a closed tab loses the job but never leaves a broken result).
 */
import type { Registry } from '../engine/define';
import { resolveNodeParams, type Engine, type EvalRequest, type EvalResult } from '../engine/engine';
import type { Gpu } from '../engine/gpu/gpu';
import { resolveParams } from '../engine/audio/params';
import { batchCount } from '../engine/graph';
import { pendingProcesses, processLabel, processOrder, processResultOf, withProcessResult, type PendingProcess, type ProcessStatus } from '../engine/process';
import { defOf, groupData, GROUP_MAX_DEPTH, GROUP_TYPE, hasGroups, localId, nodeAtPath, PATH_SEP } from '../engine/group';
import type {
  AnyNodeDef,
  AssetInfo,
  GraphDoc,
  Host,
  ImageValue,
  NodeInstance,
  ProcessArray,
  ProcessCtx,
  ProcessItemRef,
  ProcessLive,
  ProcessPull,
  ProcessResult,
} from '../engine/types';
import type { ProcessApi, ProcessEvent, ProcessJob, ProcessJobState, ProcessRunOptions, ProcessRunPendingHooks } from './api';
import { OffscreenPresenter, presentToBlob } from './encode';
import { totalFramesOf } from './util';

/** Hidden stored items of process nodes (and bakes before them) are owned by `bake:<project>:<node>`. The name is historical and kept. */
export const BAKE_OWNER = 'bake:';
export function processOwner(projectId: string, nodeId: string): string {
  return `${BAKE_OWNER}${projectId}:${nodeId}`;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Scheduler (pure)                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export interface JobControl {
  signal: AbortSignal;
  progress(fraction: number, note?: string, detail?: Record<string, number>): void;
  /** Resolves when the job may continue (immediately unless held); lets the UI breathe; throws AbortError when cancelled. */
  yield(): Promise<void>;
  /** Why `yield()` would wait right now, or null. */
  wouldWait(): string | null;
}

export interface JobSpec<T> {
  project: string;
  node: string;
  title: string;
  label?: string;
  /** GPU-heavy: counted against `maxGpu`. */
  gpu: boolean;
  run(ctl: JobControl): Promise<T>;
}

export interface SchedulerOptions {
  maxGpu?: number;
  maxLight?: number;
  /** A reason to hold every job ('playing', 'interacting', 'paused'), or null. Call `poke()` when the answer changes. */
  hold?: () => string | null;
  /** The project whose jobs may run; null = no restriction. */
  activeProject?: () => string | null;
  now?: () => number;
  /** How the job gives the event loop a turn (default: a macrotask). */
  macroYield?: () => Promise<void>;
  /** Minimum time between two macrotask yields of one job (default 12 ms). */
  yieldEveryMs?: number;
  /** Finished jobs kept for the lists (default 40). */
  keepFinished?: number;
}

interface Rec {
  info: ProcessJob;
  spec: JobSpec<unknown>;
  ctl: AbortController;
  promise: Promise<unknown>;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  wake?: () => void;
  lastYield: number;
}

const abortError = (msg = 'The process was canceled.') => new DOMException(msg, 'AbortError');
const isAbortLike = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ProcessScheduler {
  private recs = new Map<string, Rec>();
  private seq = 0;
  private listeners = new Set<(e: ProcessEvent) => void>();
  maxGpu: number;
  maxLight: number;
  private o: Required<Pick<SchedulerOptions, 'now' | 'macroYield' | 'yieldEveryMs' | 'keepFinished'>> & SchedulerOptions;

  constructor(opts: SchedulerOptions = {}) {
    this.maxGpu = Math.max(1, opts.maxGpu ?? 1);
    this.maxLight = Math.max(1, opts.maxLight ?? 2);
    this.o = {
      ...opts,
      now: opts.now ?? (() => Date.now()),
      macroYield: opts.macroYield ?? (() => new Promise<void>((r) => setTimeout(r, 0))),
      yieldEveryMs: opts.yieldEveryMs ?? 12,
      keepFinished: opts.keepFinished ?? 40,
    };
  }

  subscribe(fn: (e: ProcessEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: ProcessEvent['type'], rec: Rec): void {
    for (const l of this.listeners) l({ type, job: rec.info });
  }

  private patch(rec: Rec, p: Partial<ProcessJob>): void {
    rec.info = { ...rec.info, ...p };
  }

  list(): ProcessJob[] {
    return [...this.recs.values()].map((r) => r.info);
  }

  /** The newest job of a node (any state), or null. */
  find(project: string | null, node: string): ProcessJob | null {
    let found: ProcessJob | null = null;
    for (const r of this.recs.values()) if (r.spec.node === node && (project === null || r.spec.project === project)) found = r.info;
    return found;
  }

  private active(info: ProcessJob): boolean {
    return info.state === 'queued' || info.state === 'running' || info.state === 'paused';
  }

  /** Add a job. A node that already has a queued / running job gets that job back (one job per node at a time). */
  enqueue<T>(spec: JobSpec<T>): { id: string; done: Promise<T> } {
    for (const r of this.recs.values()) if (r.spec.project === spec.project && r.spec.node === spec.node && this.active(r.info)) return { id: r.info.id, done: r.promise as Promise<T> };
    // A new run replaces the node's old finished / failed record.
    for (const [id, r] of this.recs) if (r.spec.project === spec.project && r.spec.node === spec.node && !this.active(r.info)) this.recs.delete(id);
    const id = `job${++this.seq}`;
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined); // callers may not be listening (a job started from a button); never an unhandled rejection
    const rec: Rec = {
      info: { id, project: spec.project, node: spec.node, title: spec.title, label: spec.label ?? spec.title, state: 'queued', progress: 0, gpu: spec.gpu, queuedAt: this.o.now() },
      spec: spec as JobSpec<unknown>,
      ctl: new AbortController(),
      promise,
      resolve,
      reject,
      lastYield: 0,
    };
    this.recs.set(id, rec);
    this.emit('added', rec);
    this.poke();
    return { id, done: promise as Promise<T> };
  }

  /** Cancel a job by id (queued: gone at once; running: stops at its next `yield()`). */
  cancel(id: string): void {
    const rec = this.recs.get(id);
    if (!rec || !this.active(rec.info)) return;
    rec.ctl.abort();
    if (rec.info.state === 'queued') this.finish(rec, 'cancelled', undefined, abortError());
    else rec.wake?.(); // a paused job wakes up to find itself cancelled
  }

  cancelNode(project: string | null, node: string): void {
    for (const r of [...this.recs.values()]) if (r.spec.node === node && (project === null || r.spec.project === project)) this.cancel(r.info.id);
  }

  cancelAll(project?: string): void {
    for (const r of [...this.recs.values()]) if (!project || r.spec.project === project) this.cancel(r.info.id);
  }

  /** Run a failed or cancelled job again from zero. */
  retry(id: string): { id: string; done: Promise<unknown> } | null {
    const rec = this.recs.get(id);
    if (!rec || this.active(rec.info)) return null;
    return this.enqueue(rec.spec);
  }

  /** Forget a finished job. */
  dismiss(id: string): void {
    const rec = this.recs.get(id);
    if (!rec || this.active(rec.info)) return;
    this.recs.delete(id);
    this.emit('dismissed', rec);
  }

  setConcurrency(gpu: number, light?: number): void {
    this.maxGpu = Math.max(1, Math.round(gpu));
    if (light !== undefined) this.maxLight = Math.max(1, Math.round(light));
    this.poke();
  }

  /** Why this job may not run right now (null = it may). */
  private waitReason(rec: Rec): string | null {
    const active = this.o.activeProject?.() ?? null;
    if (active !== null && rec.spec.project !== active) return 'another project is open';
    return this.o.hold?.() ?? null;
  }

  private running(gpu: boolean): number {
    let n = 0;
    for (const r of this.recs.values()) if (r.info.state === 'running' && r.info.gpu === gpu) n++;
    return n;
  }

  /** Re-check holds and start (or resume) whatever may run now. Call when playback / dragging / the active project changes. */
  poke(): void {
    for (const rec of this.recs.values()) {
      const st = rec.info.state;
      if (st !== 'queued' && st !== 'paused') continue;
      const why = this.waitReason(rec);
      if (why) {
        if (rec.info.pausedFor !== why) this.patch(rec, { pausedFor: why });
        continue;
      }
      if (this.running(rec.info.gpu) >= (rec.info.gpu ? this.maxGpu : this.maxLight)) continue;
      this.patch(rec, { pausedFor: undefined });
      if (st === 'queued') this.start(rec);
      else this.resume(rec);
    }
  }

  private start(rec: Rec): void {
    this.patch(rec, { state: 'running', startedAt: this.o.now() });
    this.emit('started', rec);
    rec.lastYield = this.o.now();
    const ctl: JobControl = {
      signal: rec.ctl.signal,
      progress: (fraction, note, detail) => {
        this.patch(rec, { progress: Math.min(1, Math.max(0, fraction)), note, detail });
        this.emit('progress', rec);
      },
      wouldWait: () => this.waitReason(rec),
      yield: async () => {
        if (rec.ctl.signal.aborted) throw abortError();
        const why = this.waitReason(rec);
        if (why) {
          this.patch(rec, { state: 'paused', pausedFor: why });
          this.emit('paused', rec);
          this.poke(); // the slot is free: another job may start
          await new Promise<void>((res) => {
            rec.wake = res;
          });
          rec.wake = undefined;
          if (!rec.ctl.signal.aborted) this.emit('resumed', rec);
        } else if (this.o.now() - rec.lastYield >= this.o.yieldEveryMs) {
          await this.o.macroYield();
          rec.lastYield = this.o.now();
        }
        if (rec.ctl.signal.aborted) throw abortError();
      },
    };
    let run: Promise<unknown>;
    try {
      run = rec.spec.run(ctl);
    } catch (e) {
      run = Promise.reject(e);
    }
    run.then(
      (v) => this.finish(rec, 'done', v),
      (e) => this.finish(rec, rec.ctl.signal.aborted || isAbortLike(e) ? 'cancelled' : 'failed', undefined, e),
    );
  }

  private resume(rec: Rec): void {
    this.patch(rec, { state: 'running', pausedFor: undefined });
    rec.wake?.();
  }

  private finish(rec: Rec, state: 'done' | 'failed' | 'cancelled', value?: unknown, err?: unknown): void {
    if (!this.active(rec.info)) return;
    const looksLikeResult = state === 'done' && !!value && typeof value === 'object' && 'signature' in (value as object);
    this.patch(rec, {
      state,
      endedAt: this.o.now(),
      pausedFor: undefined,
      progress: state === 'done' ? 1 : rec.info.progress,
      error: state === 'failed' ? errText(err) : undefined,
      result: looksLikeResult ? (value as ProcessResult) : undefined,
    });
    if (state === 'done') rec.resolve(value);
    else rec.reject(state === 'cancelled' ? (isAbortLike(err) ? err : abortError()) : err);
    this.emit(state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'cancelled', rec);
    // Keep the lists short: forget the oldest finished records.
    const finished = [...this.recs.values()].filter((r) => !this.active(r.info));
    for (const r of finished.slice(0, Math.max(0, finished.length - this.o.keepFinished))) this.recs.delete(r.info.id);
    this.poke();
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Pure helpers                                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** True when the picture feeding `fromNode` can differ between batch items (a Media In with several files, an Item node). */
export function itemDependent(graph: GraphDoc, registry: Registry, fromNode: string): boolean {
  const seen = new Set<string>();
  const stack = [fromNode];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    const def = node && registry.get(node.type);
    if (node && def) {
      if (node.type === 'item') return true;
      try {
        if ((def.batchSize?.(resolveParams(def, node.params) as never) ?? 1) > 1) return true; // a node that hands out its own items (Sprite Sheet In)
      } catch {
        /* a throwing batchSize counts as none, like batchCount */
      }
      for (const [key, p] of Object.entries(def.params as Record<string, { type: string }>)) {
        const v = node.params[key];
        if (p.type === 'assets' && (p as { batch?: boolean }).batch !== false && Array.isArray(v) && v.length > 1) return true;
      }
    }
    for (const e of graph.edges) if (e.to.node === id) stack.push(e.from.node);
  }
  return false;
}

/** The export gate failed: these processes must run first. */
export class ProcessPendingError extends Error {
  readonly pending: PendingProcess[];
  constructor(pending: PendingProcess[]) {
    super(pendingMessage(pending));
    this.name = 'ProcessPendingError';
    this.pending = pending;
  }
}

export function pendingMessage(list: readonly PendingProcess[]): string {
  const lines = list.map((p) => `  ${p.label} (${p.title}, ${p.state})`);
  return `This graph has ${list.length === 1 ? 'a process' : `${list.length} processes`} that must be run before exporting, otherwise the export would contain a stand-in instead of the real result:\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Library seam and staged store                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** What process storage needs from the media library (a fake or a RAM library in tests / the CLI). */
export interface ProcessLibrary {
  attachSequence(owner: string, name: string, frames: Blob[], fps: number, meta?: Record<string, unknown>): Promise<AssetInfo>;
  /** Store opaque bytes as a hidden asset of `owner`, replacing the one with the same `slot`. */
  attachBlob?(owner: string, slot: string, name: string, blob: Blob, meta?: Record<string, unknown>): Promise<AssetInfo>;
  removeOwned(owner: string): Promise<void>;
  list(opts?: { includeHidden?: boolean }): AssetInfo[];
  /** Frame-exact decoding while a job runs (an export-like mode). */
  exact?: boolean;
}

type Staged =
  | { kind: 'sequence'; frames: Blob[]; fps: number; width: number; height: number; unit?: number; bytes: number }
  | { kind: 'blob'; blob: Blob; mime: string; bytes: number }
  | { kind: 'array'; blob: Blob; dtype: NonNullable<ProcessItemRef['dtype']>; length: number; bytes: number };

const DTYPES: [new (...a: never[]) => ProcessArray, NonNullable<ProcessItemRef['dtype']>][] = [
  [Float32Array, 'f32'],
  [Float64Array, 'f64'],
  [Int32Array, 'i32'],
  [Uint32Array, 'u32'],
  [Int16Array, 'i16'],
  [Uint16Array, 'u16'],
  [Int8Array, 'i8'],
  [Uint8Array, 'u8'],
];

class Stager {
  items = new Map<string, Staged>();
  bytes = 0;
  readonly api: ProcessCtx['store'];
  private put(name: string, s: Staged): void {
    const old = this.items.get(name);
    if (old) this.bytes -= old.bytes;
    this.items.set(name, s);
    this.bytes += s.bytes;
  }
  constructor() {
    const self = this;
    this.api = {
      sequence: (name, frames, o) => this.put(name, { kind: 'sequence', frames, fps: o.fps, width: o.width, height: o.height, unit: o.unit, bytes: frames.reduce((s, b) => s + b.size, 0) }),
      blob: (name, data, mime = 'application/octet-stream') => {
        const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : (data as BlobPart)], { type: mime });
        this.put(name, { kind: 'blob', blob, mime: blob.type || mime, bytes: blob.size });
      },
      json: (name, value) => {
        const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
        this.put(name, { kind: 'blob', blob, mime: 'application/json', bytes: blob.size });
      },
      array: (name, data) => {
        const dtype = DTYPES.find(([c]) => data instanceof (c as never))?.[1] ?? 'u8';
        const blob = new Blob([new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as BlobPart], { type: 'application/octet-stream' });
        this.put(name, { kind: 'array', blob, dtype, length: data.length, bytes: blob.size });
      },
      get bytes() {
        return self.bytes;
      },
    };
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Runtime                                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export interface ProcessRuntimeDeps {
  /** `flatView` (optional): how the engine sees a document with groups; needed for processes inside groups and for baking groups. */
  engine: Pick<Engine, 'processStatus' | 'processSignature'> & Partial<Pick<Engine, 'flatView'>>;
  gpu: Gpu;
  registry: Registry;
  gate: { evaluateHeld(req: EvalRequest): Promise<EvalResult>; drop(res: EvalResult): void; exclusive<T>(fn: () => T | Promise<T>): Promise<T> };
  library: ProcessLibrary;
  /** Host handed to jobs (`job.host`). Default: the library itself (it is the app's Host). */
  host?: Host;
  /** Draw a finished frame and encode it. Defaults to an OffscreenCanvas WebGPU presenter; tests inject their own. */
  encode?: (image: { texture: GPUTexture; width: number; height: number }, quality: 'lossless' | 'compressed') => Promise<Blob>;
  activeProject?: () => Promise<string | null>;
  player?: { hold(): () => void; readonly isPlaying?: boolean; invalidate?(): void };
  governor?: { enter(mode: 'export'): () => void };
  /** Extra "the user is busy" check (besides playback) for hosts that know more. */
  busy?: () => boolean;
  scheduler?: SchedulerOptions;
}

export class ProcessRuntime implements ProcessApi {
  readonly scheduler: ProcessScheduler;
  private presenter: OffscreenPresenter | null = null;
  private hints = new Set<string>();
  private active: string | null = null;
  private heavy = 0;
  private prevExact: boolean | undefined;
  private leaveMode: (() => void) | undefined;
  private playerHolds = 0;
  private unhold: (() => void) | null = null;
  private changed = new Set<(e: ProcessEvent) => void>();

  constructor(private d: ProcessRuntimeDeps) {
    this.scheduler = new ProcessScheduler({
      ...d.scheduler,
      hold: () => (d.player?.isPlaying ? 'playback' : d.busy?.() ? 'the app is busy' : this.hints.has('paused') ? 'rendering is paused' : this.hints.has('interacting') ? 'you are editing' : null),
      activeProject: () => this.active,
    });
    this.scheduler.subscribe((e) => {
      if (e.type !== 'progress') d.player?.invalidate?.(); // a node's stand-in / state changed: show it at the next frame
      for (const l of this.changed) l(e);
    });
  }

  /* ---- ProcessApi ---- */

  subscribe(listener: (e: ProcessEvent) => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }
  jobs(): ProcessJob[] {
    return this.scheduler.list();
  }
  job(nodeId: string, projectId?: string): ProcessJob | null {
    return this.scheduler.find(projectId ?? this.active, nodeId);
  }
  cancel(nodeId: string, projectId?: string): void {
    this.scheduler.cancelNode(projectId ?? this.active, nodeId);
  }
  cancelAll(projectId?: string): void {
    this.scheduler.cancelAll(projectId);
  }
  dismiss(nodeId: string, projectId?: string): void {
    const j = this.job(nodeId, projectId);
    if (j) this.scheduler.dismiss(j.id);
  }
  setActiveProject(projectId: string | null): void {
    this.active = projectId;
    this.scheduler.poke();
  }
  setHint(name: 'paused' | 'interacting', on: boolean): void {
    if (on) this.hints.add(name);
    else this.hints.delete(name);
    this.scheduler.poke();
  }
  /** Playback started or stopped (the player's state changed). */
  poke(): void {
    this.scheduler.poke();
  }
  setConcurrency(gpu: number): void {
    this.scheduler.setConcurrency(gpu);
  }
  status(graph: GraphDoc, nodeId: string): ProcessStatus | null {
    return this.d.engine.processStatus(graph, nodeId);
  }
  pending(graph: GraphDoc, outputs: string[] = []): PendingProcess[] {
    const flat = this.d.engine.flatView;
    return pendingProcesses(graph, this.d.registry, (id) => this.d.engine.processStatus(graph, id), outputs, flat && hasGroups(graph) ? (g) => flat.call(this.d.engine, g).graph : undefined);
  }

  live(nodeId: string): ProcessLive | null {
    const j = this.scheduler.find(this.active, nodeId);
    if (!j) return null;
    if (j.state === 'queued') return { state: 'queued', progress: 0 };
    if (j.state === 'running' || j.state === 'paused') return { state: 'running', progress: j.progress, note: j.note };
    if (j.state === 'failed') return { state: 'failed', progress: j.progress, error: j.error };
    return null;
  }

  private ownedAssets(nodeId: string, projectId?: string): (AssetInfo & { owner?: string })[] {
    const own = projectId ? processOwner(projectId, nodeId) : null;
    const suffix = `:${nodeId}`;
    return (this.d.library.list({ includeHidden: true }) as (AssetInfo & { owner?: string })[]).filter((a) => a.owner?.startsWith(BAKE_OWNER) && (own ? a.owner === own : a.owner.endsWith(suffix)));
  }

  async clear(nodeId: string, projectId?: string): Promise<void> {
    this.cancel(nodeId, projectId);
    const owners = new Set(this.ownedAssets(nodeId, projectId).map((a) => a.owner!));
    for (const o of owners) await this.d.library.removeOwned(o);
  }

  /**
   * Remove stored data of a project whose process nodes no longer exist (at any depth inside groups). Returns how many owners were removed.
   * `unreferenced`: also remove data that no node's result handle points at any more (a duplicate never shares it, an undone bake left
   * it behind). Call that on project LOAD only, never right after a delete: undo must be able to bring the node and its result back.
   */
  async prune(projectId: string, graph: GraphDoc, opts: { unreferenced?: boolean } = {}): Promise<number> {
    const alive = new Set<string>();
    const referenced = new Set<string>();
    const walk = (nodes: NodeInstance[], prefix: string, depth: number) => {
      for (const n of nodes) {
        const def = defOf(this.d.registry, n);
        if (def?.process) {
          alive.add(prefix + n.id);
          alive.add(n.id);
          const h = processResultOf(n, def);
          if (h) for (const it of Object.values(h.items)) referenced.add(it.id);
        }
        if (n.type === GROUP_TYPE && depth < GROUP_MAX_DEPTH) walk(groupData(n).nodes, prefix + n.id + PATH_SEP, depth + 1);
      }
    };
    walk(graph.nodes, '', 0);
    const prefix = `${BAKE_OWNER}${projectId}:`;
    const assets = this.d.library.list({ includeHidden: true }) as (AssetInfo & { owner?: string })[];
    const used = new Set<string>();
    for (const a of assets) if (a.owner?.startsWith(prefix) && referenced.has(a.id)) used.add(a.owner);
    const dead = new Set<string>();
    for (const a of assets) {
      const o = a.owner;
      if (!o?.startsWith(prefix)) continue;
      const node = o.slice(prefix.length);
      if (!alive.has(node) && !alive.has(localId(node))) dead.add(o);
      else if (opts.unreferenced && !used.has(o) && !this.isBusy(projectId, node)) dead.add(o);
    }
    for (const o of dead) await this.d.library.removeOwned(o);
    return dead.size;
  }

  /** A job of this node is running, or finished in this session and its result may not be written into the graph yet (another tab was open). */
  private isBusy(projectId: string, nodeId: string): boolean {
    const j = this.scheduler.find(projectId, nodeId);
    return !!j && (j.state === 'queued' || j.state === 'running' || j.state === 'paused' || j.state === 'done');
  }

  async runPending(graph: GraphDoc, outputs: string[], hooks: ProcessRunPendingHooks = {}): Promise<GraphDoc> {
    let g = graph;
    const done = new Set<string>();
    for (let guard = 0; guard < 200; guard++) {
      const pend = this.pending(g, outputs).filter((p) => !done.has(p.node));
      if (!pend.length) break;
      // Pending ids are paths of the flattened document: order them there (an inner node's inputs may come from outside its group).
      const flatDoc = hasGroups(g) && this.d.engine.flatView ? this.d.engine.flatView(g).graph : g;
      const order = processOrder(flatDoc, this.d.registry, pend.map((p) => p.node)).filter((id) => pend.some((p) => p.node === id));
      const next = pend.find((p) => p.node === (order[0] ?? pend[0].node)) ?? pend[0];
      const total = done.size + pend.length;
      hooks.onProgress?.({ fraction: done.size / total, label: `${next.title}: ${next.label}` });
      const result = await this.run(g, next.node, {
        signal: hooks.signal,
        options: hooks.options?.(next.node),
        item: hooks.item,
        onProgress: (p) => hooks.onProgress?.({ fraction: (done.size + p.fraction) / total, label: `${next.title}: ${next.label}${p.note ? ` · ${p.note}` : ''}` }),
      });
      g = withProcessResult(g, this.d.registry, next.node, result);
      hooks.onResult?.(next.node, result);
      done.add(next.node);
    }
    return g;
  }

  async run(graph: GraphDoc, nodeId: string, opts: ProcessRunOptions = {}): Promise<ProcessResult> {
    // `nodeId` may be a path inside groups; a group's process is its bake.
    const node = nodeAtPath(graph, nodeId);
    const def = defOf(this.d.registry, node);
    if (!node || !def?.process) throw new Error('This node has no process to run.');
    const projectId = opts.projectId ?? this.active ?? (await this.d.activeProject?.()) ?? 'project';
    const { done } = this.scheduler.enqueue<ProcessResult>({
      project: projectId,
      node: nodeId,
      title: def.process.title,
      label: processLabel(graph, this.d.registry, nodeId),
      gpu: def.process.gpu !== false,
      run: (ctl) => this.execute(graph, { ...node, id: nodeId }, def, projectId, opts, ctl),
    });
    const onAbort = () => this.scheduler.cancelNode(projectId, nodeId);
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await done;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /* ---- the job ---- */

  private async beginHeavy(): Promise<void> {
    if (this.heavy++ > 0) return;
    this.prevExact = this.d.library.exact;
    this.d.library.exact = true; // frame-exact video decoding, as for an export
    this.leaveMode = this.d.governor?.enter('export');
    await this.d.gate.exclusive(() => this.d.gpu.trim());
  }

  private async endHeavy(): Promise<void> {
    if (--this.heavy > 0) return;
    this.presenter?.dispose();
    this.presenter = null;
    this.d.library.exact = this.prevExact ?? false;
    this.leaveMode?.();
    this.leaveMode = undefined;
    await this.d.gate.exclusive(() => this.d.gpu.trim());
  }

  private holdPlayer(): () => void {
    if (this.playerHolds++ === 0) this.unhold = this.d.player?.hold() ?? null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.playerHolds === 0) {
        this.unhold?.();
        this.unhold = null;
      }
    };
  }

  private async encode(img: { texture: GPUTexture; width: number; height: number }, quality: 'lossless' | 'compressed'): Promise<Blob> {
    if (this.d.encode) return this.d.encode(img, quality);
    this.presenter ??= new OffscreenPresenter(this.d.gpu, false);
    return quality === 'lossless' ? presentToBlob(this.presenter, img, 'image/png') : presentToBlob(this.presenter, img, 'image/webp', 0.92);
  }

  private async execute(graph: GraphDoc, node: NodeInstance, def: AnyNodeDef, projectId: string, opts: ProcessRunOptions, ctl: JobControl): Promise<ProcessResult> {
    const pdef = def.process!;
    const { gate, library, registry } = this.d;
    const nodeId = node.id;
    const project = graph.project;
    const frames = totalFramesOf(project);
    const itemCount = batchCount(graph, registry);
    const item = Math.min(Math.max(0, opts.item ?? 0), itemCount - 1);
    const signature = this.d.engine.processSignature(graph, nodeId) ?? '';
    // With groups, a node's wires are those of the flattened document (an inner node's inputs may come from outside its group).
    const flatGraph = hasGroups(graph) && this.d.engine.flatView ? this.d.engine.flatView(graph).graph : graph;
    const params = resolveNodeParams(def, node.params);
    const stager = new Stager();
    let live: GraphDoc | null = null;
    const liveGraph = () => (live ??= withProcessResult(graph, registry, nodeId, null));
    const open = new Set<ProcessPull>();
    const startedAt = Date.now();
    const heavy = pdef.gpu !== false;
    let releaseHold: (() => void) | null = null;
    if (heavy) {
      await this.beginHeavy();
      releaseHold = this.holdPlayer();
    }
    const gpu = this.d.gpu;
    const job: ProcessCtx = {
      params: params as never,
      options: opts.options ?? {},
      nodeId,
      fps: project.fps,
      frames,
      duration: project.duration,
      loop: project.loop,
      canvas: { width: project.width, height: project.height },
      item: { index: item, count: itemCount, dependent: itemCount > 1 && this.dependsOnItem(flatGraph, node, nodeId, liveGraph) },
      signature,
      host: this.d.host ?? (library as unknown as Host),
      gpu: { device: gpu.device, read: (img, straight) => gpu.read(img, straight) },
      signal: ctl.signal,
      progress: (fraction, note, detail) => {
        ctl.progress(fraction, note, detail);
        opts.onProgress?.({ fraction, note, detail });
      },
      yield: async () => {
        // While the job waits (playback, project closed...) the player must be free to render.
        const wait = !!ctl.wouldWait();
        if (wait && releaseHold) {
          releaseHold();
          releaseHold = null;
        }
        await ctl.yield();
        if (heavy && !releaseHold) releaseHold = this.holdPlayer();
      },
      pull: async (input, at) => {
        const edge = flatGraph.edges.filter((e) => e.to.node === nodeId && e.to.port === input)[at?.wire ?? 0];
        if (!edge) {
          const empty: ProcessPull = { value: null, errors: new Map(), release: () => undefined };
          return empty;
        }
        const seconds = at?.frame !== undefined ? at.frame / project.fps : (at?.seconds ?? 0);
        const res = await gate.evaluateHeld({
          graph,
          node: edge.from.node,
          port: edge.from.port,
          seconds,
          item: at?.item === undefined ? item : Math.min(Math.max(0, Math.floor(at.item)), itemCount - 1),
          itemCount,
          proxy: at?.proxy ?? 1,
          quality: at?.quality ?? 'final',
        });
        const handle: ProcessPull = {
          value: res.value,
          errors: res.errors,
          release: () => {
            if (open.delete(handle)) gate.drop(res);
          },
        };
        open.add(handle);
        return handle;
      },
      pullOutput: async (output, at) => {
        // Live, as if nothing were stored: the node's own result handle is cleared in the evaluated copy (a group then expands).
        const seconds = at?.frame !== undefined ? at.frame / project.fps : (at?.seconds ?? 0);
        const res = await gate.evaluateHeld({ graph: liveGraph(), node: nodeId, port: output, seconds, item: at?.item === undefined ? item : Math.min(Math.max(0, Math.floor(at.item)), itemCount - 1), itemCount, proxy: at?.proxy ?? 1, quality: at?.quality ?? 'final' });
        const handle: ProcessPull = {
          value: res.value,
          errors: res.errors,
          release: () => {
            if (open.delete(handle)) gate.drop(res);
          },
        };
        open.add(handle);
        return handle;
      },
      encodeImage: (image, quality) => this.encode(image, quality),
      store: stager.api,
    };

    try {
      const out = (await pdef.run(job)) ?? {};
      if (ctl.signal.aborted) throw abortError();
      const meta = out.meta ?? {};
      const items = await this.commit(projectId, nodeId, def.title, pdef.title, signature, stager, meta, project.fps);
      return {
        signature,
        items,
        meta,
        bytes: Object.values(items).reduce((s, i) => s + i.bytes, 0),
        createdAt: Date.now(),
        seconds: (Date.now() - startedAt) / 1000,
      };
    } finally {
      for (const p of [...open]) p.release();
      releaseHold?.();
      if (heavy) await this.endHeavy();
    }
  }

  /** Does what feeds this node (a group: what feeds its outputs) differ between batch items? */
  private dependsOnItem(flatGraph: GraphDoc, node: NodeInstance, nodeId: string, liveGraph: () => GraphDoc): boolean {
    const { registry, engine } = this.d;
    if (node.type !== GROUP_TYPE || !engine.flatView) return itemDependent(flatGraph, registry, nodeId);
    const view = engine.flatView(liveGraph());
    return groupData(node).outputs.some((o) => {
      const src = view.outputs.get(`${nodeId}:${o.id}`);
      return !!src && itemDependent(view.graph, registry, src.node);
    });
  }

  /** Write everything the job staged to the library, under the node's owner. Replaces the previous result in place (same asset ids). */
  private async commit(projectId: string, nodeId: string, nodeTitle: string, title: string, signature: string, stager: Stager, meta: Record<string, unknown>, fps: number): Promise<Record<string, ProcessItemRef>> {
    const owner = processOwner(projectId, nodeId);
    const items: Record<string, ProcessItemRef> = {};
    const names = [...stager.items.keys()].sort();
    let layer = 0;
    const createdAt = Date.now();
    for (const name of names) {
      const s = stager.items.get(name)!;
      if (s.kind === 'sequence') {
        const bakeMeta = {
          signature,
          quality: typeof meta.quality === 'string' ? meta.quality : 'lossless',
          bytes: s.bytes,
          frames: s.frames.length,
          item: typeof meta.item === 'number' ? meta.item : null,
          nodeId,
          createdAt,
          width: s.width,
          height: s.height,
          unit: s.unit ?? 1,
          canvas: typeof meta.canvas === 'string' ? meta.canvas : '',
        };
        const info = await this.d.library.attachSequence(owner, `${title}: ${nodeTitle}`, s.frames, s.fps || fps, { bake: bakeMeta, layer: layer++, process: { node: nodeId, item: name } });
        items[name] = { kind: 'sequence', id: info.id, bytes: s.bytes, frames: s.frames.length, fps: s.fps || fps, width: s.width, height: s.height };
      } else {
        if (!this.d.library.attachBlob) throw new Error('This media library cannot store process data (no attachBlob).');
        const info = await this.d.library.attachBlob(owner, name, `${title}: ${name}`, s.blob, { process: { node: nodeId, item: name } });
        items[name] = s.kind === 'blob' ? { kind: 'blob', id: info.id, bytes: s.bytes, mime: s.mime } : { kind: 'array', id: info.id, bytes: s.bytes, mime: 'application/octet-stream', dtype: s.dtype, length: s.length };
      }
    }
    return items;
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* A library in RAM (tests, CLI)                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------------------ */

type MemAsset = { info: AssetInfo & { owner?: string; hidden?: boolean; slot?: string; layer?: number; bake?: unknown }; raw: Uint8Array[] };

/**
 * A process store that lives in memory. It is a `ProcessLibrary` AND answers the Host calls (`assetInfo`, `assetBytes`, `assetFrame`)
 * a stored result is read through, so a Host can delegate to it. Sequence frames are assumed to be raw RGBA8 of the stated size
 * (inject `encode` accordingly); that is enough for tests and for CLI analysis processes, which store blobs.
 */
export class MemoryProcessLibrary implements ProcessLibrary {
  assets = new Map<string, MemAsset>();
  exact = false;
  gpu?: Gpu;
  private n = 0;
  /** Called when stored content changes (the caller clears its engine cache). */
  onChange: (() => void) | null = null;

  assetInfo(id: string): AssetInfo | null {
    return this.assets.get(id)?.info ?? null;
  }
  async assetBytes(id: string): Promise<ArrayBuffer | null> {
    const a = this.assets.get(id);
    if (!a || !a.raw[0]) return null;
    const b = a.raw[0];
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  async assetFrame(id: string, seconds: number): Promise<{ texture: GPUTexture; width: number; height: number } | null> {
    const a = this.assets.get(id);
    if (!a || !this.gpu || a.info.kind !== 'video') return null;
    const i = Math.min(a.raw.length - 1, Math.max(0, Math.floor(seconds * a.info.fps + 1e-6)));
    const img: ImageValue = this.gpu.upload(a.raw[i], a.info.width, a.info.height, 1, false);
    this.gpu.retain(img.texture);
    return { texture: img.texture, width: a.info.width, height: a.info.height };
  }
  private find(owner: string, pred: (a: MemAsset) => boolean): MemAsset | undefined {
    return [...this.assets.values()].find((a) => a.info.owner === owner && pred(a));
  }
  async attachSequence(owner: string, name: string, frames: Blob[], fps: number, meta?: Record<string, unknown>): Promise<AssetInfo> {
    const layer = typeof meta?.layer === 'number' ? meta.layer : 0;
    const existing = this.find(owner, (a) => (a.info.layer ?? 0) === layer && a.info.kind === 'video');
    const id = existing?.info.id ?? `seq${++this.n}`;
    const raw = await Promise.all(frames.map(async (b) => new Uint8Array(await b.arrayBuffer())));
    const bake = (meta as { bake?: { width: number; height: number } } | undefined)?.bake;
    const info = { id, name, kind: 'video' as const, width: bake?.width ?? 0, height: bake?.height ?? 0, duration: frames.length / fps, fps, hasAudio: false, owner, hidden: true, ...(meta ?? {}) };
    this.assets.set(id, { info, raw });
    if (existing) this.onChange?.(); // like Library: only replaced frames flush the caller's engine cache
    return info;
  }
  async attachBlob(owner: string, slot: string, name: string, blob: Blob, meta?: Record<string, unknown>): Promise<AssetInfo> {
    const existing = this.find(owner, (a) => a.info.slot === slot);
    const id = existing?.info.id ?? `blob${++this.n}`;
    const info = { id, name, kind: 'model' as const, width: 0, height: 0, duration: 0, fps: 0, hasAudio: false, owner, hidden: true, slot, ...(meta ?? {}) };
    this.assets.set(id, { info, raw: [new Uint8Array(await blob.arrayBuffer())] });
    return info;
  }
  async removeOwned(owner: string): Promise<void> {
    for (const [id, a] of [...this.assets]) if (a.info.owner === owner) this.assets.delete(id);
    this.onChange?.();
  }
  list(opts?: { includeHidden?: boolean }): AssetInfo[] {
    return [...this.assets.values()].map((a) => a.info).filter((i) => opts?.includeHidden || !i.hidden);
  }
}

export type { ProcessJobState };
