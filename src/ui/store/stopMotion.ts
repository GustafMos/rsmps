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
  clampFps,
  type Shot,
} from '../../engine/lib/stop-motion';
import { isLivePictureType, liveOrientOfNode, liveSourceOfNode } from '../../engine/lib/live-source';
import type { ReceivedShot, ReceiverTarget, SinkResult } from '../../phone/stopmotion-protocol';
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

/** A linked phone that shoots for a Stop Motion (see phone-stopmotion.ts). */
export interface PhoneShootUi {
  token: string | null;
  /** off: no phone chosen. waiting: chosen, not in stop motion mode yet. connected. dropped: it was connected and the link is gone. */
  state: 'off' | 'waiting' | 'connected' | 'dropped';
  /** Pictures stored from the phone since it was linked. */
  received: number;
  /** 0..1 of the picture arriving now, or null. */
  arriving: number | null;
  /** Pictures the phone has taken that are not on the computer yet. */
  unsent: number;
  /** What the phone says it is waiting for. */
  note: string;
  /** The shutter was pressed here and the picture has not arrived yet. */
  asked: boolean;
}

export interface StopMotionUi {
  /** Stop Motion node (id) a take / auto run / snippet belongs to, or null. */
  nodeId: string | null;
  /** A picture is being grabbed and saved right now. */
  busy: boolean;
  snippet: 'idle' | 'recording' | 'saving';
  auto: AutoShoot;
  phone: PhoneShootUi;
}

const NO_AUTO: AutoShoot = { running: false, every: 2, limit: 0, count: 0, nextAt: 0 };
const NO_PHONE: PhoneShootUi = { token: null, state: 'off', received: 0, arriving: null, unsent: 0, note: '', asked: false };
const IDLE: StopMotionUi = { nodeId: null, busy: false, snippet: 'idle', auto: NO_AUTO, phone: NO_PHONE };

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
type IoLike = Pick<Io, 'player' | 'library' | 'liveRecorder'> & Partial<Pick<Io, 'registry' | 'phone'>>;

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
    this.unlinkPhone();
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
    const before = this.shots(id);
    const after = fn(before);
    this.ed.setParam(id, 'shots', after);
    this.phoneShotsChanged(id, before, after);
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
    if (this.remote(id)) return this.remoteShutter();
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

  /* ------------------------------------------------------------ a linked phone as the capture rig ------------------------------------------------------------ */

  private link: { node: string; token: string } | null = null;
  private offPhone: (() => void)[] = [];
  private wasConnected = false;
  private remoteAuto = false;
  private askedReceived = 0;
  private askedTime = 0;

  private phoneSm() {
    return this.io.phone?.stopmotion ?? null;
  }

  /** Can a phone be linked here (the desktop app or LAN mode)? */
  phoneAvailable(): boolean {
    return !!this.io.phone?.available && !!this.phoneSm();
  }

  /** The phone is linked, in stop motion mode, and shooting for this node: the computer's buttons drive it. */
  private remote(id: string): boolean {
    return !!this.link && this.link.node === id && this.phoneReady();
  }

  private phoneReady(): boolean {
    const l = this.link;
    if (!l || !this.io.phone) return false;
    return this.io.phone.state(l.token) === 'connected' && !!this.phoneSm()?.info(l.token)?.active;
  }

  /** Make this phone the capture rig of Stop Motion `id`: its pictures land in this node. Switching the phone page to the mode is `io.phone.setMode`. */
  linkPhone(id: string, token: string): void {
    const sm = this.phoneSm();
    if (!sm || !this.node(id)) return;
    this.unlinkPhone();
    this.link = { node: id, token };
    this.wasConnected = false;
    const target: ReceiverTarget = {
      add: (shot) => this.receiveShot(id, shot),
      remove: (asset) => this.removeAsset(id, asset),
    };
    sm.setTarget(token, target);
    this.offPhone = [
      sm.subscribe(token, () => this.refreshPhone()),
      sm.onPatch(token, (patch) => this.phoneChangedSettings(id, patch)),
      this.io.phone!.onState((t) => t === token && this.refreshPhone()),
    ];
    this.store.set((s) => ({ ...s, nodeId: id }));
    this.refreshPhone();
  }

  unlinkPhone(): void {
    const l = this.link;
    if (!l) return;
    if (this.remoteAuto && this.phoneReady()) this.phoneSm()?.command(l.token, 'auto-stop');
    this.offPhone.forEach((f) => f());
    this.offPhone = [];
    this.phoneSm()?.setTarget(l.token, null);
    this.link = null;
    const wasRemoteAuto = this.remoteAuto;
    this.remoteAuto = false;
    this.store.set((s) => ({ ...s, phone: NO_PHONE, auto: wasRemoteAuto ? { ...s.auto, running: false } : s.auto }));
  }

  /** Re-reads the link: connected or dropped, what the phone reports, its auto shoot. */
  private refreshPhone(): void {
    const l = this.link;
    const sm = this.phoneSm();
    if (!l || !sm) return;
    const info = sm.info(l.token);
    const ready = this.phoneReady();
    if (ready && !this.wasConnected) {
      this.wasConnected = true;
      this.syncPhoneSettings();
      this.pushCount();
    } else if (!ready && this.wasConnected) {
      this.wasConnected = false;
      this.ed.toast('The phone is not connected. You can still shoot here; the phone keeps its pictures and sends them when it is back.', 'info');
      if (this.remoteAuto) {
        this.remoteAuto = false;
        this.store.set((s) => ({ ...s, auto: { ...s.auto, running: false } }));
      }
    }
    const st = info?.status ?? null;
    const received = info?.received ?? 0;
    const asked = this.store.get().phone.asked && received <= this.askedReceived && this.env.now() - this.askedTime < 20_000;
    const state: PhoneShootUi['state'] = ready ? 'connected' : this.store.get().phone.state === 'connected' || this.store.get().phone.state === 'dropped' ? 'dropped' : 'waiting';
    this.store.set((s) => ({ ...s, phone: { token: l.token, state, received, arriving: info?.arriving?.fraction ?? null, unsent: ready ? st?.unsent ?? 0 : s.phone.unsent, note: ready ? st?.note ?? '' : '', asked } }));
    if (ready && st && (st.auto.running || this.remoteAuto)) {
      this.remoteAuto = st.auto.running;
      const every = Number(this.params(l.node).interval);
      this.store.set((s) => ({ ...s, auto: { running: st.auto.running, every: Number.isFinite(every) ? every : s.auto.every, limit: st.auto.limit, count: st.auto.count, nextAt: this.env.now() + st.auto.nextInMs } }));
    }
  }

  /** Remote shutter: the phone takes the picture, it arrives as a shot. True when the phone was asked. */
  private remoteShutter(): boolean {
    const l = this.link;
    if (!l) return false;
    this.askedReceived = this.phoneSm()?.info(l.token)?.received ?? 0;
    this.askedTime = this.env.now();
    this.store.set((s) => ({ ...s, phone: { ...s.phone, asked: true } }));
    this.env.later(20_100, () => this.refreshPhone()); // the label does not stay on "waiting" if nothing arrives
    return !!this.phoneSm()?.command(l.token, 'shoot');
  }

  /** A picture from the phone arrived complete and checked: it becomes Media and one shot, one undo step, exactly like a local shot. */
  private async receiveShot(id: string, shot: ReceivedShot): Promise<SinkResult> {
    if (!this.node(id)) return { ok: false, code: 'no-target', reason: 'This Stop Motion is not in the project any more.' };
    if (this.shots(id).length >= MAX_SHOTS) return { ok: false, code: 'full', reason: `A Stop Motion holds at most ${MAX_SHOTS} shots.` };
    try {
      const ext = shot.mime === 'image/png' ? 'png' : shot.mime === 'image/webp' ? 'webp' : 'jpg';
      const file = new File([shot.bytes as BlobPart], `Stop motion shot ${this.shots(id).length + 1}.${ext}`, { type: shot.mime });
      const [asset] = await this.io.library.add([file]);
      if (!asset) return { ok: false, code: 'failed', reason: 'The picture could not be added to Media.' };
      if (!this.node(id)) return { ok: false, code: 'no-target', reason: 'This Stop Motion is not in the project any more.' };
      this.edit(id, (s) => addShot(s, { asset: asset.id, kind: 'still' }));
      return { ok: true, asset: asset.id };
    } catch (err) {
      return { ok: false, code: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The phone's Undo for a shot that is already in the node: take that very shot out (not just the last one). One undo step. */
  private removeAsset(id: string, asset: string): void {
    const i = this.shots(id).findIndex((x) => x.asset === asset);
    if (i >= 0) this.ed.setParam(id, 'shots', removeShot(this.shots(id), i));
    this.pushCount();
  }

  /** Shots changed in the node: tell the phone which of its pictures are gone, and the new count. */
  private phoneShotsChanged(id: string, before: Shot[], after: Shot[]): void {
    const l = this.link;
    if (!l || l.node !== id) return;
    const keep = new Set(after.map((x) => x.asset));
    for (const x of before) if (!keep.has(x.asset)) this.phoneSm()?.removedOnComputer(l.token, x.asset);
    this.pushCount();
  }

  private pushCount(): void {
    const l = this.link;
    if (l) this.phoneSm()?.setCount(l.token, this.shots(l.node).length);
  }

  /** The node's settings as the phone shows them. Called when the link is made and whenever the panel sees a setting change. */
  syncPhoneSettings(): void {
    const l = this.link;
    if (!l) return;
    const p = this.params(l.node);
    const s = stopMotionSettings(p);
    this.phoneSm()?.setSettings(l.token, {
      maxSide: s.maxSide,
      onion: p.onion !== false,
      onionStrength: Number.isFinite(Number(p.onionStrength)) ? Number(p.onionStrength) : 0.4,
      onionFrames: Number.isFinite(Number(p.onionFrames)) ? Number(p.onionFrames) : 1,
      interval: s.every,
      stopAfter: s.limit,
      fps: clampFps(p.fps),
    });
  }

  /** A setting changed on the phone: it goes into the node (so the project keeps it) and back to the phone as the new truth. */
  private phoneChangedSettings(id: string, patch: Partial<{ maxSide: number; onion: boolean; onionStrength: number; onionFrames: number; interval: number; stopAfter: number }>): void {
    if (!this.node(id)) return;
    const set = (key: string, value: unknown) => {
      if (this.params(id)[key] !== value) this.ed.setParam(id, key, value);
    };
    if (patch.maxSide !== undefined) set('shotSize', patch.maxSide === 0 ? 'full' : String(patch.maxSide));
    if (patch.onion !== undefined) set('onion', patch.onion);
    if (patch.onionStrength !== undefined) set('onionStrength', patch.onionStrength);
    if (patch.onionFrames !== undefined) set('onionFrames', patch.onionFrames);
    if (patch.interval !== undefined) set('interval', patch.interval);
    if (patch.stopAfter !== undefined) set('stopAfter', patch.stopAfter);
    this.syncPhoneSettings();
  }

  /* ------------------------------------------------------------ auto shoot (time-lapse / hyperlapse) ------------------------------------------------------------ */

  /** Start taking a picture every `interval` seconds (from the node's settings). */
  startAuto(id: string): void {
    if (this.store.get().auto.running || !this.node(id)) return;
    if (this.remote(id)) {
      // the phone runs the schedule (its own clock, its own wake lock); its status comes back and fills `auto`
      this.phoneSm()?.command(this.link!.token, 'auto-start');
      return;
    }
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
    if (this.link && this.remoteAuto && this.phoneReady()) this.phoneSm()?.command(this.link.token, 'auto-stop');
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
