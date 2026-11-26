/**
 * The buttons of the Stop Motion node: Take picture, Undo last, Retake, Record snippet and Auto shoot (a timer that takes pictures).
 *
 * Capture is a UI action and the node stays a pure function of its params: a picture is rendered from the node wired into Stop Motion's
 * Picture input (`io.player.grabNode`: full resolution, live sources refreshed), added to Media as an image file and appended to the
 * node's `shots` param. A snippet is a clip of the live input recorded by `io.liveRecorder` (the Webcam's Record) and becomes one shot.
 * All edits of the sequence are ordinary param edits, so editor undo / redo covers them.
 *
 * Auto shoot is drift free (picture k is due at start + k * every, not "last picture + every") and never queues: a tick that finds the
 * previous grab still running is skipped. While it runs a screen wake lock is held where the browser has one.
 */
import { defaultParams } from '../../engine/engine';
import type { Io } from '../../io/api';
import {
  STOP_MOTION_ID,
  addShot,
  duplicateShot,
  moveShot,
  normalizeShots,
  removeLast,
  removeShot,
  replaceShot,
  setHold,
  shotMaxSide,
  type Shot,
} from '../../engine/lib/stop-motion';
import { isLivePictureType, liveOrientOfNode, liveSourceOfNode } from '../../engine/lib/live-source';
import type { Editor } from './editor';
import { createStore, type Store } from './createStore';

export interface AutoShoot {
  running: boolean;
  /** Seconds between pictures, and the number to stop after (0 = no limit). */
  every: number;
  limit: number;
  /** Pictures taken since Start. */
  count: number;
  /** `env.now()` (ms) when the next picture is due. */
  nextAt: number;
}

export interface StopMotionUi {
  /** Stop Motion node (id) a take / auto run / snippet belongs to, or null. */
  nodeId: string | null;
  /** A picture is being grabbed and saved right now. */
  busy: boolean;
  snippet: 'idle' | 'recording' | 'saving';
  auto: AutoShoot;
}

const NO_AUTO: AutoShoot = { running: false, every: 2, limit: 0, count: 0, nextAt: 0 };
const IDLE: StopMotionUi = { nodeId: null, busy: false, snippet: 'idle', auto: NO_AUTO };

export interface StopMotionEnv {
  /** `performance.now()`. */
  now(): number;
  /** Run `fn` after `ms`; returns a canceller. */
  later(ms: number, fn: () => void): () => void;
  /** Ask for a screen wake lock; resolves a release function, or null where the browser has none. */
  wakeLock(): Promise<(() => void) | null>;
}

export const browserStopMotionEnv: StopMotionEnv = {
  now: () => performance.now(),
  later(ms, fn) {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  },
  async wakeLock() {
    const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener?: unknown }> } });
    if (!nav?.wakeLock) return null;
    let sentinel: { release(): Promise<void> } | null = null;
    let released = false;
    const get = async () => {
      try {
        sentinel = await nav.wakeLock!.request('screen');
      } catch {
        sentinel = null;
      }
    };
    await get();
    // the browser drops the lock when the page is hidden: ask again when it is back
    const back = () => {
      if (!released && document.visibilityState === 'visible') void get();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', back);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  },
};

/** Seconds until the next automatic picture, rounded up ("3"), for the countdown. 0 when none is running. */
export function countdown(auto: AutoShoot, now: number): number {
  return auto.running ? Math.max(0, Math.ceil((auto.nextAt - now) / 1000 - 1e-6)) : 0;
}

/** Settings of a Stop Motion node with defaults for anything missing or odd. */
export function stopMotionSettings(params: Readonly<Record<string, unknown>>): { every: number; limit: number; maxSide: number } {
  const every = Number(params.interval);
  const limit = Number(params.stopAfter);
  return {
    every: Number.isFinite(every) ? Math.min(600, Math.max(0.2, every)) : 2,
    limit: Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0,
    maxSide: shotMaxSide(params.shotSize),
  };
}

/** The Stop Motion the viewer's buttons work: the one being viewed, else the first one in the project. */
export function stopMotionForViewer(nodes: readonly { id: string; type: string; params: Readonly<Record<string, unknown>> }[], viewedId: string | null): { id: string; params: Readonly<Record<string, unknown>> } | null {
  const all = nodes.filter((n) => n.type === STOP_MOTION_ID);
  return all.find((n) => n.id === viewedId) ?? all[0] ?? null;
}

/** Hard cap so a forgotten time-lapse cannot fill the device. */
export const MAX_SHOTS = 5000;

type EditorLike = Pick<Editor, 'state' | 'setParam' | 'toast'>;
type IoLike = Pick<Io, 'player' | 'library' | 'liveRecorder'> & Partial<Pick<Io, 'registry'>>;

export class StopMotionController {
  readonly store: Store<StopMotionUi> = createStore<StopMotionUi>({ ...IDLE });
  private stopTick: (() => void) | null = null;
  private releaseLock: (() => void) | null = null;
  private autoStart = 0;
  private tickIndex = 0;
  private fails = 0;
  private offFinished: () => void;
  /** The live node a running snippet records, and the Stop Motion it belongs to. */
  private snippet: { live: string; node: string } | null = null;

  constructor(
    private ed: EditorLike,
    private io: IoLike,
    private env: StopMotionEnv = browserStopMotionEnv,
  ) {
    this.offFinished = io.liveRecorder.onFinished((f) => void this.snippetFinished(f.nodeId, f.result?.asset.id ?? null, f.result?.seconds ?? 0, f.error));
  }

  dispose(): void {
    this.stopAuto();
    this.offFinished();
  }

  /* ------------------------------------------------------------ reading the graph ------------------------------------------------------------ */

  private node(id: string) {
    return this.ed.state.graph.nodes.find((n) => n.id === id && n.type === STOP_MOTION_ID) ?? null;
  }

  private params(id: string): Record<string, unknown> {
    const n = this.node(id);
    if (!n) return {};
    const def = this.io.registry?.get(STOP_MOTION_ID);
    return { ...(def ? defaultParams(def) : {}), ...n.params };
  }

  shots(id: string): Shot[] {
    return normalizeShots(this.node(id)?.params.shots);
  }

  /** The node wired into the Picture input: where the pictures come from. */
  private source(id: string): { node: string; port: string } | null {
    const e = this.ed.state.graph.edges.find((x) => x.to.node === id && x.to.port === 'image');
    return e ? { node: e.from.node, port: e.from.port } : null;
  }

  private edit(id: string, fn: (s: Shot[]) => Shot[]): void {
    if (!this.node(id)) return;
    this.ed.setParam(id, 'shots', fn(this.shots(id)));
  }

  /* ------------------------------------------------------------ the sequence ------------------------------------------------------------ */

  /** Grab one picture of the input into Media. Null when it could not be done (a toast says why). Skips when a grab is running. */
  private async grab(id: string, quiet = false): Promise<string | null> {
    const src = this.source(id);
    if (!src) {
      if (!quiet) this.ed.toast('Wire a Webcam or any picture into the Picture input of Stop Motion first.', 'info');
      return null;
    }
    const { maxSide } = stopMotionSettings(this.params(id));
    const blob = await this.io.player.grabNode(src.node, undefined, maxSide, maxSide > 0 ? 'image/jpeg' : 'image/png');
    if (!blob) {
      if (!quiet) this.ed.toast('There is no picture to take yet. View this node and wait for the picture to appear.', 'info');
      return null;
    }
    const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
    const n = this.shots(id).length + 1;
    const file = new File([blob], `Stop motion shot ${n}.${ext}`, { type: blob.type || 'image/png' });
    const [asset] = await this.io.library.add([file]);
    return asset ? asset.id : null;
  }

  /** Take picture: append the current input frame as a shot. True when a shot was added. */
  async take(id: string): Promise<boolean> {
    const ui = this.store.get();
    if (ui.busy || !this.node(id)) return false;
    if (this.shots(id).length >= MAX_SHOTS) {
      this.ed.toast(`That is the most shots one Stop Motion holds (${MAX_SHOTS}).`, 'info');
      return false;
    }
    this.store.set((s) => ({ ...s, busy: true, nodeId: id }));
    try {
      const asset = await this.grab(id, this.store.get().auto.running);
      if (!asset) return false;
      this.edit(id, (s) => addShot(s, { asset, kind: 'still' }));
      return true;
    } catch (err) {
      this.ed.toast(`The picture was not saved: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    } finally {
      this.store.set((s) => ({ ...s, busy: false }));
    }
  }

  /** Retake: replace shot `i` with the current input frame. */
  async retake(id: string, i: number): Promise<boolean> {
    if (this.store.get().busy || !this.shots(id)[i]) return false;
    this.store.set((s) => ({ ...s, busy: true, nodeId: id }));
    try {
      const asset = await this.grab(id);
      if (!asset) return false;
      this.edit(id, (s) => replaceShot(s, i, asset));
      return true;
    } catch (err) {
      this.ed.toast(`The picture was not saved: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    } finally {
      this.store.set((s) => ({ ...s, busy: false }));
    }
  }

  undoLast(id: string): void {
    this.edit(id, removeLast);
  }
  remove(id: string, i: number): void {
    this.edit(id, (s) => removeShot(s, i));
  }
  move(id: string, i: number, delta: -1 | 1): void {
    this.edit(id, (s) => moveShot(s, i, delta));
  }
  duplicate(id: string, i: number): void {
    this.edit(id, (s) => duplicateShot(s, i));
  }
  hold(id: string, i: number, hold: number): void {
    this.edit(id, (s) => setHold(s, i, hold));
  }
  clearAll(id: string): void {
    this.edit(id, () => []);
  }

  /* ------------------------------------------------------------ video snippets ------------------------------------------------------------ */

  /** Record snippet: press to start, press again to stop. The clip becomes one shot. */
  toggleSnippet(id: string): void {
    const rec = this.io.liveRecorder;
    const ui = this.store.get();
    if (ui.snippet === 'recording') {
      if (ui.nodeId === id) void rec.stop();
      return;
    }
    if (ui.snippet === 'saving') return;
    const src = this.source(id);
    const live = src ? this.ed.state.graph.nodes.find((n) => n.id === src.node) : null;
    if (!live || !isLivePictureType(live.type)) {
      this.ed.toast('Record snippet needs a Webcam, Phone Camera or Stream wired straight into Stop Motion.', 'info');
      return;
    }
    if (rec.state !== 'idle') return this.ed.toast('A camera recording is running. Stop that one first.', 'info');
    const liveId = live.id;
    try {
      rec.start({
        nodeId: liveId,
        fps: this.ed.state.graph.project.fps,
        label: 'Snippet',
        source: () => (this.ed.state.graph.nodes.some((n) => n.id === liveId) ? this.liveSource(liveId) : 'gone'),
        orient: () => this.liveOrient(liveId),
      });
    } catch (err) {
      return this.ed.toast(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    this.snippet = { live: liveId, node: id };
    this.store.set((s) => ({ ...s, nodeId: id, snippet: 'recording' }));
  }

  private liveSource(liveId: string) {
    const n = this.ed.state.graph.nodes.find((x) => x.id === liveId);
    return n ? liveSourceFor(this.io, n) : null;
  }
  private liveOrient(liveId: string) {
    const n = this.ed.state.graph.nodes.find((x) => x.id === liveId);
    return n ? liveOrientFor(this.io, n) : { mirror: false, turns: 0 };
  }

  private async snippetFinished(liveId: string, asset: string | null, seconds: number, error?: string): Promise<void> {
    const sn = this.snippet;
    if (!sn || sn.live !== liveId) return;
    this.snippet = null;
    this.store.set((s) => ({ ...s, snippet: 'idle' }));
    if (!asset || !(seconds > 0)) {
      if (error) this.ed.toast(`The snippet was not saved: ${error}`, 'error');
      return;
    }
    this.edit(sn.node, (s) => addShot(s, { asset, kind: 'clip', seconds }));
  }

  /* ------------------------------------------------------------ auto shoot (time-lapse / hyperlapse) ------------------------------------------------------------ */

  /** Start taking a picture every `interval` seconds (from the node's settings). */
  startAuto(id: string): void {
    if (this.store.get().auto.running || !this.node(id)) return;
    if (!this.source(id)) return this.ed.toast('Wire a Webcam or any picture into the Picture input of Stop Motion first.', 'info');
    const { every, limit } = stopMotionSettings(this.params(id));
    this.autoStart = this.env.now();
    this.tickIndex = 0;
    this.fails = 0;
    this.store.set((s) => ({ ...s, nodeId: id, auto: { running: true, every, limit, count: 0, nextAt: this.autoStart } }));
    void this.env.wakeLock().then((release) => {
      if (this.store.get().auto.running) this.releaseLock = release;
      else release?.(); // stopped before the lock arrived
    });
    this.schedule(id);
  }

  private schedule(id: string): void {
    const a = this.store.get().auto;
    const due = this.autoStart + this.tickIndex * a.every * 1000;
    this.store.set((s) => ({ ...s, auto: { ...s.auto, nextAt: due } }));
    this.stopTick = this.env.later(due - this.env.now(), () => void this.tick(id));
  }

  private async tick(id: string): Promise<void> {
    if (!this.store.get().auto.running) return;
    this.tickIndex++;
    let ok = false;
    if (this.store.get().busy) {
      // the last grab is still running: skip this picture, never queue
      ok = true;
    } else {
      ok = await this.take(id);
      if (ok) this.store.set((s) => ({ ...s, auto: { ...s.auto, count: s.auto.count + 1 } }));
      this.fails = ok ? 0 : this.fails + 1;
    }
    const a = this.store.get().auto;
    if (!a.running) return;
    if (this.fails >= 3) {
      this.ed.toast('Auto shoot stopped: no picture could be taken.', 'error');
      return this.stopAuto();
    }
    if (a.limit > 0 && a.count >= a.limit) {
      this.ed.toast(`Auto shoot finished: ${a.count} pictures.`, 'ok');
      return this.stopAuto();
    }
    if (!this.node(id)) return this.stopAuto();
    // a grab that took longer than the interval skips the ticks it covered
    const now = this.env.now();
    const every = a.every * 1000;
    while (this.autoStart + this.tickIndex * every < now - 1) this.tickIndex++;
    this.schedule(id);
  }

  stopAuto(): void {
    this.stopTick?.();
    this.stopTick = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.store.set((s) => ({ ...s, auto: { ...s.auto, running: false } }));
  }

  toggleAuto(id: string): void {
    if (this.store.get().auto.running) this.stopAuto();
    else this.startAuto(id);
  }
}

function paramsOf(io: IoLike, n: { type: string; params: Record<string, unknown> }): Record<string, unknown> {
  const def = io.registry?.get(n.type);
  return { ...(def ? defaultParams(def) : {}), ...n.params };
}
function liveSourceFor(io: IoLike, n: { type: string; params: Record<string, unknown> }) {
  return liveSourceOfNode(n.type, paramsOf(io, n));
}
function liveOrientFor(io: IoLike, n: { type: string; params: Record<string, unknown> }) {
  return liveOrientOfNode(n.type, paramsOf(io, n));
}
