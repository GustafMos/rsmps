/**
 * Live picture sources for `Host.liveFrame`: webcams and network pictures / streams / video files.
 *
 * - Streams open lazily on the first request, are shared by every node using the same source, and are closed
 *   when nobody has asked for ~5 s (or on `closeAll`, used when switching projects).
 * - Every frame is uploaded straight to a pooled GPU texture with copyExternalImageToTexture (no CPU readback).
 *   One texture per source and size is reused; it is only re-uploaded when the source has a new frame.
 * - Failures throw readable Errors; the engine shows them on the node.
 */
import type { Gpu } from '../engine/gpu/gpu';
import { uploadExternal } from './upload';
import type { CameraControls, LiveSource } from '../engine/types';
import { CANNOT_MESSAGE, buildConstraints, digitalZoomFor, type Caps } from './camera-controls';
import { facingOfId, facingOfLabel, loadCatalogue, nameCameras, noteCamera, onCatalogueChanged, recordFromTrack } from './camera-catalogue';
import {
  CHEAP_FIX_MS, CLASH_MESSAGE, GAVE_UP_MESSAGE, MUTE_GRACE_MS, PAIR_FAIL_MS, RESTART_BACKOFF_MS, SIZE_HD, SIZE_SD, STUCK_MS, TEST_SIZES,
  describePairTests, isClashError, ladderRungs, pairKey, reducedNote, type PairOutcome, type PairTest, type Selector, type Size,
} from './camera-ladder';
import { DEFAULT_TURNS, FIRST_FRAME_MS, MAIN_DWELL_MS, ONE_AT_A_TIME_LINE, RECORDING_QUIET_MS, RELEASE_GAP_MS, RETURN_RETRY_MS, TURN_TICK_MS, resolveRoles, turnLine, visitBackoff, type Roles, type TurnSettings } from './camera-turns';

type UrlMode = 'auto' | 'image' | 'mjpeg' | 'video';
export type LiveRequest = LiveSource & { freeze?: boolean };

/** What the phone link offers `LiveSources` (see phone.ts). */
export interface PhoneProvider {
  source(token: string): { video: HTMLVideoElement | null; bitmap: ImageBitmap | null; version: number; state: 'waiting' | 'connected' | 'disconnected' | 'expired' } | null;
  /** Explains why there is no session at all (LAN mode off, unknown token). */
  unavailable(): string;
}

export interface LiveFrame {
  texture: GPUTexture;
  width: number;
  height: number;
  /** Camera pictures: true when the camera does the zoom itself, so the node must not zoom the picture again. */
  nativeZoom?: boolean;
}

/** What a camera source reports about itself, for the inspector. */
export interface CameraInfo {
  /** The camera is open and has a live track. */
  open: boolean;
  capabilities: Caps;
  settings: Record<string, unknown>;
  /** Zoom to do in the picture (1 = none): the whole zoom when the camera has no zoom of its own. */
  digitalZoom: number;
  /** The last thing the camera refused, in plain words ('' = nothing). */
  error: string;
  /** Set when the camera runs at a smaller picture so that two cameras can work together: the size and a one-line explanation. */
  reducedTo: Size | null;
  note: string;
  /** The id the browser gives this camera ('' when unknown). */
  deviceId: string;
  /** Cameras that take turns: what this camera is doing in plain words ('' when it does not take turns). */
  turnLine: string;
  /** Cameras that take turns: this camera is a visited one, so Refresh now works. */
  canRefresh: boolean;
}

/** Applying camera constraints is slow: at most one in flight, and the next one waits at least this long, keeping only the latest wish. */
export const CAMERA_APPLY_MS = 80;

/** What is remembered about the controls of one camera source (it outlives the stream, so a reopened camera gets them again). */
interface CameraCtl {
  wanted: CameraControls;
  /** Signature of the last snapshot the node handed in: the node's values only replace `wanted` when they changed. */
  snap: string;
  /** Constraint names sent to the current track. */
  sent: Set<string>;
  lastSig: string;
  busy: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  error: string;
}

export const IDLE_CLOSE_MS = 5000;

/* ----------------------------------------- pure helpers ----------------------------------------- */

/** Stable key of a source: what identifies one shared stream (freeze does not). */
export function sourceKey(s: LiveRequest): string {
  if (s.kind === 'phone') return `phone|${s.session}`;
  if (s.kind === 'camera') return `camera|${s.deviceId}|${s.width ?? 0}x${s.height ?? 0}|${s.facing ?? ''}`;
  return `url|${s.url}|${s.mode ?? 'auto'}|${s.mode === 'image' ? (s.refresh ?? 0) : 0}`;
}

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg)(\?|#|$)/i;

/** How to read a URL: a video element for video files, otherwise an <img> (it also plays MJPEG natively). */
export function classifyUrl(url: string, mode: UrlMode | undefined): 'image' | 'mjpeg' | 'video' {
  if (mode === 'video') return 'video';
  if (mode === 'image') return 'image';
  if (mode === 'mjpeg') return 'mjpeg';
  return VIDEO_EXT.test(url) ? 'video' : 'mjpeg'; // 'auto': an <img> handles stills and MJPEG alike
}

/** Size to upload: shrink to `maxSide` on the long side (0 = natural). */
export function targetSize(w: number, h: number, maxSide: number, deviceMax: number): { width: number; height: number } {
  const long = Math.max(w, h);
  const cap = Math.min(maxSide > 0 ? maxSide : long, deviceMax);
  if (cap >= long) return { width: w, height: h };
  const k = cap / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export function isIdle(lastUsed: number, now: number): boolean {
  return now - lastUsed >= IDLE_CLOSE_MS;
}

export function hostOf(url: string): string {
  try {
    return new URL(url, typeof location !== 'undefined' ? location.href : undefined).host;
  } catch {
    return url;
  }
}

export function corsMessage(url: string): string {
  return `The server at ${hostOf(url)} does not allow other sites to read its picture (CORS). It must send an "Access-Control-Allow-Origin" header (a phone camera app often has a setting for this).`;
}

/** Why an <img>/<video> failed to load, in plain words. */
export function loadFailureMessage(url: string, pageProtocol: string, pageOrigin: string): string {
  let u: URL | null = null;
  try {
    u = new URL(url, pageOrigin);
  } catch {
    return `"${url}" is not a valid address.`;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (pageProtocol === 'https:' && u.protocol === 'http:' && !local) {
    return `The browser blocks ${u.host} because this page is https and the address is http (mixed content). Use an https address, or open the app over http on the same network.`;
  }
  if (u.origin !== pageOrigin) {
    return `Could not load the picture from ${u.host}. Check the address and that the server is reachable; it must also send CORS headers ("Access-Control-Allow-Origin") so this page may read the picture.`;
  }
  return `Could not load the picture from ${u.host}${u.pathname}. Check the address.`;
}

export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Allow the camera for this site in the browser address bar, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'The chosen camera was not found. Pick another one, or choose the default camera.';
  if (name === 'NotReadableError') return 'The camera is in use by another program or tab.';
  return `The camera could not be opened (${(err as Error)?.message ?? String(err)}).`;
}

/** A camera that could not be opened (in use, unplugged) is tried again this often, not on every frame. */
export const CAMERA_RETRY_MS = 5000;

export type CameraPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** What the browser says about camera permission for this site, without asking. 'unknown' where it does not tell (Firefox, Safari). */
export async function cameraPermission(): Promise<CameraPermission> {
  try {
    const st = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return st.state === 'granted' || st.state === 'denied' || st.state === 'prompt' ? st.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const CAMERA_BLOCKED = 'Camera permission was denied. Select the Webcam node and press "Allow camera", or allow the camera for this site in the browser\'s site settings.';

/* ----------------------------------------- sources ---------------------------------------------- */

interface Entry {
  key: string;
  req: LiveRequest;
  el: HTMLVideoElement | HTMLImageElement;
  phoneVersion: number;
  isVideo: boolean;
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
  caps: Caps | null;
  /** What the camera reported when it was opened. */
  initial: Record<string, unknown>;
  texture: GPUTexture | null;
  frame: LiveFrame | null;
  ready: Promise<void>;
  error: Error | null;
  lastUsed: number;
  /** A new picture may be available since the last upload. */
  fresh: boolean;
  lastTime: number;
  uploadedBucket: string;
  /** The picture kept for a held project time (see `frame`): its own texture, so the live one can go on changing. */
  heldAt: number | null;
  heldTexture: GPUTexture | null;
  held: LiveFrame | null;
  refreshTimer: ReturnType<typeof setInterval> | null;
  rvfc: number;
  closed: boolean;
  /** Order of opening: a camera waits for the ones opened before it (so two cameras never ask at the same instant). */
  seq: number;
  /** Device cameras: the first picture arrived (health checks start here). */
  opened: boolean;
  deviceId: string;
  /** When the track went mute (0 = not mute), when the last new picture was seen, when the video said it stalled. */
  mutedAt: number;
  lastFrameAt: number;
  lastSeenTime: number;
  stalledAt: number;
  trackEnded: boolean;
  /** Recovery of a stuck camera: stage (0 play, 1 fresh video element, 2+ full restarts), when the next step may run, a restart is running. */
  recStage: number;
  recAt: number;
  restarting: boolean;
  /** Running smaller than asked so that another camera fits; and the size to go back to. */
  reduced: Size | null;
  original: Size | null;
  /** Taking turns (see camera-turns.ts): this camera shares the one-camera-at-a-time schedule; it has no stream of its own right now; what its node says. */
  turn: boolean;
  turnIdle: boolean;
  turns: TurnSettings;
  /** The size the node last asked for (the schedule takes its pictures at the same size). */
  maxSide: number;
  /** When a visit last gave this camera a picture (0 = never), when it may be visited again after a failure, failures in a row, Refresh now was pressed. */
  lastGoodAt: number;
  backoffUntil: number;
  fails: number;
  asked: boolean;
}

export class LiveSources {
  private entries = new Map<string, Entry>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private devicesListeners = new Set<() => void>();
  /** Set by createIo when the phone link exists. */
  phone: PhoneProvider | null = null;
  /**
   * Set when the camera was refused. While set, cameras are not opened again on their own: every retry would be another
   * permission question (or a silent failure) at a moment the user did not choose. `askCamera` (a button) clears it.
   */
  private cameraRefused = false;
  /** Cameras that failed to open for another reason (in use, not found): not tried again before `until`, so a failing camera is not opened on every frame. */
  private cameraFailed = new Map<string, { until: number; message: string }>();
  private ctl = new Map<string, CameraCtl>();
  /** While true the device cameras are closed and never opened (the AR view owns the camera). Remote sources are not touched. */
  private camerasSuspended = false;
  /** True while the page opens cameras itself (a test or a measurement): nodes get nothing meanwhile and the cameras come back afterwards. */
  private parked = false;
  private seqCounter = 0;
  /** What worked (or did not) for each pair of cameras this session, so the ladder is not run again for every frame. */
  private pairs = new Map<string, PairOutcome>();
  /** Cameras the page stopped restarting by itself: they stay closed until the Restart button. */
  private gaveUp = new Map<string, string>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pageOff: (() => void) | null = null;
  /** Taking turns: the timer, a visit or a change of main camera is going on, who is main, who is looked at, the measured costs. */
  private turnTimer: ReturnType<typeof setInterval> | null = null;
  private turnBusy = false;
  private roles: Roles = { main: '', visited: [], lostMain: [] };
  private viewedKey = '';
  private mainSince = 0;
  private lastDrawable = -1e9;
  private visiting = '';
  private visitMs: number | null = null;
  private returnMs: number | null = null;

  get camerasBlocked(): boolean {
    return this.camerasSuspended;
  }

  /** Close every open device camera and keep them closed (on), or let the nodes open them again on their next frame (off). */
  suspendCameras(on: boolean): void {
    if (on === this.camerasSuspended) return;
    this.camerasSuspended = on;
    if (on) {
      for (const e of [...this.entries.values()]) if (e.req.kind === 'camera') this.close(e);
    }
    this.cameraFailed.clear(); // a camera that failed meanwhile is tried afresh
    this.mainSince = 0;
    this.gaveUp.clear();
  }

  constructor(private gpu: Gpu) {}

  /** True while any source is open (the player uses this to keep its refresh loop honest). */
  get active(): boolean {
    return this.entries.size > 0;
  }

  /**
   * `hold`: the picture is asked for a project time that is not the present (`at`, seconds). A live source has no past, so
   * what a time node gets is the picture taken when that time was first asked for, kept until another time is asked for.
   * That is what makes Retime's stop-motion (and anything else that holds a time) work on a camera: the time stays the
   * same for a few frames, and so does the picture.
   */
  async frame(req: LiveRequest, maxSide: number, hold?: { at: number; held: boolean }): Promise<LiveFrame | null> {
    if (req.kind !== 'camera') return this.frameOf(req, maxSide, hold);
    if (req.controls) this.noteControls(sourceKey(req), req.controls);
    const f = await this.frameOf(req, maxSide, hold);
    const e = this.entries.get(sourceKey(req));
    if (e && req.turns) e.turns = req.turns;
    if (!f || !req.controls) return f;
    return e?.caps && digitalZoomFor(req.controls.zoom, e.caps) === 1 ? { ...f, nativeZoom: true } : f;
  }

  private async frameOf(req: LiveRequest, maxSide: number, hold?: { at: number; held: boolean }): Promise<LiveFrame | null> {
    const key = sourceKey(req);
    if (req.kind === 'camera' && (this.camerasSuspended || this.parked)) return null;
    let e = this.entries.get(key);
    if (req.kind === 'camera' && this.gaveUp.has(key)) throw new Error(this.gaveUp.get(key));
    if (!e && req.kind === 'camera') {
      if (this.cameraRefused) throw new Error(CAMERA_BLOCKED);
      const failed = this.cameraFailed.get(key);
      if (failed && performance.now() < failed.until) throw new Error(failed.message);
    }
    if (!e) {
      e = this.open(key, req);
      this.entries.set(key, e);
      this.ensureSweeper();
    }
    e.lastUsed = performance.now();
    e.maxSide = maxSide;
    if (hold?.held && e.held && e.heldAt === hold.at) return e.held;
    // taking turns and not the open camera right now: the picture it gave last (none before its first visit)
    if (req.kind === 'camera' && e.turn && e.turnIdle) return e.held;
    if (req.kind === 'phone') {
      const live = await this.phoneFrame(e, req.session, maxSide, !!req.freeze);
      return hold?.held ? ((await this.snapshot(e, maxSide, hold.at)) ?? live) : live;
    }
    if (e.error) {
      const err = e.error;
      this.close(e); // the next request retries from scratch
      throw err;
    }
    // Never hold the render up for a slow open (permission prompt, network): answer "not yet" and let the next tick retry.
    const opened = await Promise.race([e.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
    if (!opened) return null;
    if (e.error) {
      const err = e.error;
      this.close(e);
      throw err;
    }
    if (req.freeze && e.frame) return e.frame;
    const live = await this.upload(e, maxSide);
    return hold?.held ? ((await this.snapshot(e, maxSide, hold.at)) ?? live) : live;
  }

  /**
   * The element or bitmap that currently holds the picture of a source, for the live recorder (no GPU upload). Opens the source like
   * `frame()` does and counts as a use, so a stream that is being recorded is not closed as idle. Null while there is no picture.
   */
  drawable(req: LiveRequest): CanvasImageSource | null {
    const key = sourceKey(req);
    if (req.kind === 'camera' && (this.camerasSuspended || this.parked || this.gaveUp.has(key))) return null;
    let e = this.entries.get(key);
    if (!e && req.kind === 'camera' && this.cameraRefused) return null;
    if (!e) {
      e = this.open(key, req);
      this.entries.set(key, e);
      this.ensureSweeper();
    }
    e.lastUsed = performance.now();
    this.lastDrawable = performance.now(); // a recording is asking: the schedule leaves the cameras alone meanwhile
    return e.turn && e.turnIdle ? null : this.pictureOf(e);
  }

  /** A camera that takes turns and has not been visited yet: the node gives a transparent picture. */
  waitingForTurn(req: LiveRequest): boolean {
    const e = this.entries.get(sourceKey(req));
    return !!e && e.turn && e.turnIdle && !e.held;
  }

  /** True when a source is open and has a picture right now. Never opens anything (no camera prompt). */
  hasPicture(req: LiveRequest): boolean {
    const e = this.entries.get(sourceKey(req));
    return !!e && this.pictureOf(e) !== null;
  }

  private pictureOf(e: Entry): CanvasImageSource | null {
    if (e.req.kind === 'phone') {
      const src = this.phone?.source(e.req.session) ?? null;
      if (!src) return null;
      return src.video && src.video.readyState >= 2 && src.video.videoWidth > 0 && src.video.videoHeight > 0 ? src.video : src.bitmap;
    }
    if (e.error) return null;
    if (e.isVideo) {
      const v = e.el as HTMLVideoElement;
      return v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0 ? v : null;
    }
    const img = e.el as HTMLImageElement;
    return img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null;
  }

  /**
   * After a GPU device loss: the textures are gone with the old device (forget them, do not release), but cameras and streams
   * stay open. Closing them would open the camera again a moment later, which on a phone can ask for permission again.
   */
  onDeviceReset(): void {
    for (const e of this.entries.values()) {
      e.texture = null;
      e.frame = null;
      e.uploadedBucket = '';
      e.heldAt = null;
      e.heldTexture = null;
      e.held = null;
      e.phoneVersion = -1;
      e.fresh = true;
    }
  }

  closeAll(): void {
    for (const e of [...this.entries.values()]) this.close(e);
    for (const c of this.ctl.values()) if (c.timer) clearTimeout(c.timer);
    this.ctl.clear();
    this.pageOff?.();
    if (this.turnTimer) clearInterval(this.turnTimer);
    this.turnTimer = null;
  }

  /* --------------------------------------- camera controls ----------------------------------- */

  private ctlOf(key: string): CameraCtl {
    let c = this.ctl.get(key);
    if (!c) {
      c = { wanted: {}, snap: '', sent: new Set(), lastSig: '', busy: false, timer: null, lastFlush: 0, error: '' };
      this.ctl.set(key, c);
    }
    return c;
  }

  /** The node's values for a camera, handed in with every frame request: they replace what is wanted only when they changed. */
  private noteControls(key: string, controls: CameraControls): void {
    const c = this.ctlOf(key);
    const snap = JSON.stringify(controls);
    if (snap === c.snap) return;
    c.snap = snap;
    c.wanted = { ...controls };
    this.scheduleApply(key);
  }

  /** What a camera source can do and how it is set now. Never opens the camera. */
  cameraInfo(req: LiveRequest): CameraInfo {
    const key = sourceKey(req);
    const e = this.entries.get(key);
    const c = this.ctl.get(key);
    const track = e?.track;
    let settings: Record<string, unknown> = {};
    try {
      settings = (track?.getSettings?.() as Record<string, unknown>) ?? {};
    } catch {
      /* a track that ended */
    }
    const peers = e ? this.deviceCameras(e) : [];
    const reducedTo = e?.reduced && peers.length ? e.reduced : null;
    let together = 'the two cameras';
    const mine = e ? facingOfId(e.deviceId) : 'unknown';
    const theirs = peers[0] ? facingOfId(peers[0].deviceId) : 'unknown';
    if (mine !== 'unknown' && theirs !== 'unknown' && mine !== theirs) together = 'the front and back cameras';
    return {
      open: !!track && !e?.closed,
      capabilities: e?.caps ?? {},
      settings,
      digitalZoom: digitalZoomFor(c?.wanted.zoom, e?.caps ?? null),
      error: this.gaveUp.get(key) ?? c?.error ?? '',
      reducedTo,
      note: reducedTo ? reducedNote(reducedTo, together) : '',
      deviceId: e?.deviceId || String(settings.deviceId ?? ''),
      turnLine: e ? this.turnLineOf(e) : '',
      canRefresh: !!e && e.turn && this.roles.main !== e.key,
    };
  }

  /**
   * Ask a camera source for some settings now (merged into what is wanted; the node's own values replace them the next time they change).
   * Applied to the live track when there is one, otherwise as soon as the camera is open, and again whenever it is reopened.
   * Says plainly when the camera cannot do it; the stream is never touched in that case.
   */
  applyCamera(req: LiveRequest, partial: CameraControls): { ok: boolean; message?: string } {
    const key = sourceKey(req);
    const c = this.ctlOf(key);
    const e = this.entries.get(key);
    const names = Object.keys(partial).filter((k) => k !== 'zoom' && k !== 'frameRate'); // those two always work (zoom falls back to the picture)
    if (e?.caps && names.length) {
      const probe = buildConstraints({ ...c.wanted, ...partial }, e.caps, c.sent, e.initial);
      if (probe.unsupported.filter((u) => names.includes(u)).length === names.length) {
        c.error = CANNOT_MESSAGE;
        return { ok: false, message: CANNOT_MESSAGE };
      }
    }
    c.error = '';
    c.wanted = { ...c.wanted, ...partial };
    this.scheduleApply(key);
    return { ok: true };
  }

  private readTrack(e: Entry, stream: MediaStream): void {
    const track = stream.getVideoTracks?.()[0] ?? null;
    e.track = track;
    e.caps = null;
    if (!track) return;
    try {
      e.caps = typeof track.getCapabilities === 'function' ? ((track.getCapabilities() as unknown as Caps) ?? {}) : {};
      e.initial = (track.getSettings?.() as unknown as Record<string, unknown>) ?? {};
    } catch {
      e.caps = {};
    }
    const c = this.ctlOf(e.key);
    c.sent = new Set();
    c.lastSig = '';
    c.busy = false;
    this.scheduleApply(e.key);
  }

  private scheduleApply(key: string): void {
    const c = this.ctlOf(key);
    if (c.busy || c.timer) return; // the pending / running one picks up the latest wish
    const wait = Math.max(0, c.lastFlush + CAMERA_APPLY_MS - performance.now());
    c.timer = setTimeout(() => {
      c.timer = null;
      void this.flushApply(key);
    }, wait);
  }

  private async flushApply(key: string): Promise<void> {
    const c = this.ctlOf(key);
    const e = this.entries.get(key);
    if (!e?.track || !e.caps || e.closed || c.busy) return;
    const built = buildConstraints(c.wanted, e.caps, c.sent, e.initial);
    if (built.unsupported.length && !c.error) c.error = CANNOT_MESSAGE;
    if (!built.unsupported.length && c.error === CANNOT_MESSAGE) c.error = '';
    if (built.signature === c.lastSig || !built.keys.length) {
      c.lastSig = built.signature;
      return;
    }
    c.busy = true;
    c.lastFlush = performance.now();
    const track = e.track;
    const sigBefore = JSON.stringify(c.wanted);
    try {
      await track.applyConstraints(built.constraints);
      c.lastSig = built.signature;
      c.sent = new Set(built.active);
    } catch {
      // the stream goes on as it was: only the setting is refused
      c.error = CANNOT_MESSAGE;
      c.lastSig = built.signature; // do not retry the same refused set on every frame
    }
    c.busy = false;
    if (JSON.stringify(c.wanted) !== sigBefore) this.scheduleApply(key); // the wish changed meanwhile: only the latest is sent
  }

  /* --------------------------------------- opening ------------------------------------------- */

  private open(key: string, req: LiveRequest): Entry {
    const base = { key, req, phoneVersion: -1, stream: null, track: null, caps: null, initial: {}, texture: null, frame: null, error: null, lastUsed: performance.now(), fresh: true, lastTime: -1, uploadedBucket: '', heldAt: null, heldTexture: null, held: null, refreshTimer: null, rvfc: 0, closed: false, seq: ++this.seqCounter, opened: false, deviceId: '', mutedAt: 0, lastFrameAt: performance.now(), lastSeenTime: -1, stalledAt: 0, trackEnded: false, recStage: 0, recAt: 0, restarting: false, reduced: null, original: null, turn: false, turnIdle: false, turns: (req.kind === 'camera' && req.turns) || DEFAULT_TURNS, maxSide: 0, lastGoodAt: 0, backoffUntil: 0, fails: 0, asked: false } as const;
    if (req.kind === 'phone') {
      const e: Entry = { ...base, el: document.createElement('video'), isVideo: false, ready: Promise.resolve() };
      return e;
    }
    if (req.kind === 'camera') {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      const e: Entry = { ...base, el: video, isVideo: true, ready: Promise.resolve() };
      e.ready = this.openCamera(e, video, req);
      return e;
    }
    const type = classifyUrl(req.url, req.mode);
    if (type === 'video') {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      const e: Entry = { ...base, el: video, isVideo: true, ready: Promise.resolve() };
      e.ready = new Promise<void>((resolve) => {
        video.onloadeddata = () => {
          void video.play().catch(() => undefined);
          this.watchFrames(e, video);
          resolve();
        };
        video.onerror = () => {
          e.error = new Error(loadFailureMessage(req.url, location.protocol, location.origin));
          resolve();
        };
      });
      video.src = req.url;
      return e;
    }
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    const e: Entry = { ...base, el: img, isVideo: false, ready: Promise.resolve() };
    const load = (url: string) => {
      img.src = url;
    };
    e.ready = new Promise<void>((resolve) => {
      img.onload = () => {
        e.fresh = true;
        resolve();
      };
      img.onerror = () => {
        if (!e.frame) e.error = new Error(loadFailureMessage(req.url, location.protocol, location.origin));
        resolve();
      };
    });
    if (type === 'image' && (req.refresh ?? 0) > 0) {
      // A snapshot URL: fetch again every N seconds (cache-busted), keeping the old picture until the new one has loaded.
      const ms = Math.max(100, (req.refresh ?? 2) * 1000);
      e.refreshTimer = setInterval(() => {
        const next = new Image();
        next.crossOrigin = 'anonymous';
        next.onload = () => {
          if (e.closed) return;
          e.el = next;
          e.fresh = true;
        };
        next.src = req.url + (req.url.includes('?') ? '&' : '?') + `_rsmps=${Date.now()}`;
      }, ms);
    }
    load(req.url);
    return e;
  }

  private newVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    return video;
  }

  private gum(video: MediaTrackConstraints | boolean): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }

  private primaryConstraints(e: Entry, req: Extract<LiveRequest, { kind: 'camera' }>): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {};
    if (req.deviceId) constraints.deviceId = { exact: req.deviceId };
    if (req.width) constraints.width = { ideal: req.width };
    if (req.height) constraints.height = { ideal: req.height };
    if (req.facing) constraints.facingMode = req.facing;
    const wantRate = this.ctl.get(e.key)?.wanted.frameRate ?? req.controls?.frameRate;
    if (wantRate && wantRate > 0) constraints.frameRate = { ideal: wantRate };
    return constraints;
  }

  private async openCamera(e: Entry, video: HTMLVideoElement, req: Extract<LiveRequest, { kind: 'camera' }>): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      e.error = new Error('This browser has no camera access (it needs a secure page: https or localhost).');
      return;
    }
    try {
      const stream = await this.acquire(e, req);
      if (e.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await this.attachStream(e, video, stream);
    } catch (err) {
      if ((err as { name?: string })?.name === 'ClashError' && e.turns.clash !== 'stop' && !e.closed) this.joinTurns(e);
      else this.failOpen(e, err);
    }
  }

  private failOpen(e: Entry, err: unknown): void {
    const name = (err as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      this.cameraRefused = true;
      e.error = new Error(CAMERA_BLOCKED);
    } else {
      e.error = new Error(name === 'ClashError' ? (err as Error).message : cameraErrorMessage(err));
      this.cameraFailed.set(e.key, { until: performance.now() + CAMERA_RETRY_MS, message: e.error.message });
    }
  }

  /** Other device cameras of this page that have a picture. */
  private deviceCameras(except?: Entry): Entry[] {
    return [...this.entries.values()].filter((x) => x !== except && x.req.kind === 'camera' && !x.closed && x.opened && !!x.stream);
  }

  private identity(e: Entry): string {
    const r = e.req;
    return r.kind === 'camera' ? e.deviceId || r.deviceId || r.facing || 'default' : '';
  }

  /** The stream for a camera. When another device camera of this page is open and the first request is refused, it climbs down the ladder. */
  private async acquire(e: Entry, req: Extract<LiveRequest, { kind: 'camera' }>): Promise<MediaStream> {
    const primary = this.primaryConstraints(e, req);
    // a camera that is still opening goes first: two cameras never ask at the same instant
    const earlier = [...this.entries.values()].filter((x) => x !== e && x.req.kind === 'camera' && !x.closed && !x.opened && x.seq < e.seq);
    if (earlier.length) await Promise.all(earlier.map((x) => x.ready.catch(() => undefined)));
    const others = this.deviceCameras(e);
    if (!others.length) return this.gum(primary);
    const other = others[0];
    const pk = pairKey(e.deviceId || req.deviceId || req.facing || 'default', this.identity(other));
    const known = this.pairs.get(pk);
    const turning = e.turns.clash !== 'stop';
    // asked to always take turns: do not even try two at once
    if (turning && (e.turns.clash === 'always' || others.some((o) => o.turns.clash === 'always'))) throw Object.assign(new Error(CLASH_MESSAGE), { name: 'ClashError' });
    if (known && !known.ok) {
      // taking turns: the memory does not run out (the Restart button clears it); otherwise the pair is tried again after a minute
      if (turning || performance.now() - known.at < PAIR_FAIL_MS) throw Object.assign(new Error(CLASH_MESSAGE), { name: 'ClashError' });
    } else if (known?.ok) {
      const rung = ladderRungs(this.sameSelector(req), this.altSelector(req, other)).find((r) => r.id === known.rung);
      if (rung) {
        try {
          if (known.otherSize && !other.reduced) await this.lower(other, known.otherSize);
          const s = await this.gum(rung.constraints);
          e.reduced = rung.size;
          e.original = this.sizeAsked(req);
          return s;
        } catch (err) {
          if (!isClashError(err)) throw err;
        }
      }
    }
    try {
      return await this.gum(primary);
    } catch (err) {
      if (!isClashError(err)) throw err;
      return this.ladder(e, req, other, pk);
    }
  }

  private sizeAsked(req: Extract<LiveRequest, { kind: 'camera' }>): Size {
    return { width: req.width ?? 1920, height: req.height ?? 1080 };
  }

  private sameSelector(req: Extract<LiveRequest, { kind: 'camera' }>): Selector {
    return req.deviceId ? { deviceId: req.deviceId } : req.facing ? { facing: req.facing } : null;
  }

  /** The other way of choosing the same camera: by side when it was chosen by id, and by the first camera known to face that way when it was chosen by side. */
  private altSelector(req: Extract<LiveRequest, { kind: 'camera' }>, other: Entry): Selector {
    if (req.deviceId) {
      const f = facingOfId(req.deviceId);
      return f === 'unknown' ? null : { facing: f === 'back' ? 'environment' : 'user' };
    }
    if (req.facing) {
      const want = req.facing === 'environment' ? 'back' : 'front';
      const cat = loadCatalogue();
      const id = Object.keys(cat).find((k) => k !== other.deviceId && facingOfId(k, cat) === want);
      return id ? { deviceId: id } : null;
    }
    return null;
  }

  private async lower(other: Entry, size: Size): Promise<void> {
    try {
      await other.track?.applyConstraints({ width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30 } });
    } catch {
      /* the camera keeps what it had */
    }
    other.reduced = size;
  }

  /**
   * The ladder (each step tried once, stopping at the first that works):
   *  1. the new camera at 1280x720, then 640x480, then the same two sizes chosen the other way (by side or by id);
   *  2. the camera that is already open lowered to 1280x720 without a restart, and step 1 again;
   *  3. the open camera restarted at 1280x720 (a brief interruption), and step 1 again;
   *  4. both at 640x480.
   * When nothing works the open camera is put back as it was and the failure is remembered for a minute.
   */
  private async ladder(e: Entry, req: Extract<LiveRequest, { kind: 'camera' }>, other: Entry, pk: string): Promise<MediaStream> {
    const rungs = ladderRungs(this.sameSelector(req), this.altSelector(req, other));
    const run = async () => {
      for (const r of rungs) {
        if (e.closed) return null;
        try {
          return { stream: await this.gum(r.constraints), rung: r };
        } catch (err) {
          if (!isClashError(err)) throw err;
        }
      }
      return null;
    };
    const done = (got: NonNullable<Awaited<ReturnType<typeof run>>>): MediaStream => {
      this.pairs.set(pk, { ok: true, rung: got.rung.id, size: got.rung.size, otherSize: other.reduced });
      e.reduced = got.rung.size;
      e.original = this.sizeAsked(req);
      return got.stream;
    };
    let got = await run();
    if (got) return done(got);
    const restoreTo = other.original;
    let restarted = false;
    await this.lower(other, SIZE_HD);
    if ((got = await run())) return done(got);
    const otherReq = other.req as Extract<LiveRequest, { kind: 'camera' }>;
    const otherAsk = (s: Size): MediaTrackConstraints => ({
      ...(other.deviceId ? { deviceId: { exact: other.deviceId } } : otherReq.deviceId ? { deviceId: { exact: otherReq.deviceId } } : otherReq.facing ? { facingMode: otherReq.facing } : {}),
      width: { ideal: s.width },
      height: { ideal: s.height },
      frameRate: { ideal: 30 },
    });
    for (const s of [SIZE_HD, SIZE_SD]) {
      restarted = true;
      other.reduced = s;
      await this.restartStream(other, otherAsk(s));
      if ((got = await run())) return done(got);
    }
    // nothing worked: put the open camera back as it was
    other.reduced = null;
    if (restarted) await this.restartStream(other, this.primaryConstraints(other, otherReq));
    else if (restoreTo) await other.track?.applyConstraints({ width: { ideal: restoreTo.width }, height: { ideal: restoreTo.height } }).catch(() => undefined);
    this.pairs.set(pk, { ok: false, at: performance.now() });
    throw Object.assign(new Error(CLASH_MESSAGE), { name: 'ClashError' });
  }

  /** Stop the stream of an open camera and open it again with other constraints (same entry, so the nodes keep their wiring). */
  private async restartStream(e: Entry, constraints: MediaTrackConstraints): Promise<boolean> {
    const video = this.newVideo();
    this.releaseStream(e);
    e.held = null;
    e.heldAt = null;
    try {
      const stream = await this.gum(constraints);
      if (e.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      await this.attachStream(e, video, stream);
      return true;
    } catch {
      return false;
    }
  }

  private releaseStream(e: Entry): void {
    e.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.onmute = null;
      t.onunmute = null;
      t.stop();
    });
    e.stream = null;
    e.track = null;
    const el = e.el as HTMLVideoElement & { cancelVideoFrameCallback?: (n: number) => void };
    if (el.cancelVideoFrameCallback && e.rvfc) el.cancelVideoFrameCallback(e.rvfc);
    el.pause?.();
    el.srcObject = null;
    e.fresh = true;
    e.lastTime = -1;
    e.uploadedBucket = '';
  }

  /** Show a stream in a video element, read what the camera reports, and start watching it. */
  private async attachStream(e: Entry, video: HTMLVideoElement, stream: MediaStream): Promise<void> {
    e.el = video;
    e.stream = stream;
    this.readTrack(e, stream);
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    if (video.readyState < 2) await Promise.race([new Promise<void>((r) => (video.onloadeddata = () => r())), new Promise<void>((r) => setTimeout(r, 4000))]);
    const now = performance.now();
    e.opened = true;
    e.mutedAt = 0;
    e.trackEnded = false;
    e.lastFrameAt = now;
    e.stalledAt = 0;
    const settings = (e.track?.getSettings?.() ?? {}) as Record<string, unknown>;
    e.deviceId = String(settings.deviceId ?? (e.req.kind === 'camera' ? e.req.deviceId : '') ?? '');
    if (!e.original && typeof settings.width === 'number' && typeof settings.height === 'number') e.original = { width: settings.width, height: settings.height };
    this.watchFrames(e, video);
    this.watchTrack(e, video);
    this.watchPage();
    if (e.deviceId) noteCamera(e.deviceId, { ...recordFromTrack(e.caps, settings), ...(e.track?.label ? { label: e.track.label } : {}) });
    this.devicesListeners.forEach((l) => l()); // labels become available after permission
  }

  /** Android takes the camera away when the page goes to the background: the track ends or goes mute, or the picture just stops. */
  private watchTrack(e: Entry, video: HTMLVideoElement): void {
    const track = e.track;
    if (track) {
      track.onended = () => {
        e.trackEnded = true;
      };
      track.onmute = () => {
        if (!e.mutedAt) e.mutedAt = performance.now();
      };
      track.onunmute = () => {
        e.mutedAt = 0;
      };
    }
    const mark = () => {
      if (e.el === video) e.stalledAt = performance.now();
    };
    video.onstalled = mark;
    video.onsuspend = mark;
    video.onemptied = mark;
    video.onpause = () => {
      if (e.el === video && !e.closed && !pageHidden()) void video.play().catch(() => undefined);
    };
  }

  private watchPage(): void {
    if (this.pageOff || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const back = () => {
      if (!pageHidden()) this.checkCameras(performance.now(), true);
    };
    document.addEventListener('visibilitychange', back);
    const w = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
    w?.addEventListener('pageshow', back);
    this.watchdog = setInterval(() => this.checkCameras(performance.now(), false), 1000);
    this.pageOff = () => {
      document.removeEventListener('visibilitychange', back);
      w?.removeEventListener('pageshow', back);
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      this.pageOff = null;
    };
  }

  /**
   * Look at every open device camera: ended, mute for longer than a moment, or showing no new picture for a couple of seconds while a node
   * wants it. Does nothing while the page is hidden or the AR view owns the camera. `resume`: the page just came back, so the
   * time spent hidden does not count, and a camera that ended meanwhile is restarted at once.
   */
  checkCameras(now: number, resume: boolean): void {
    if (this.camerasSuspended || this.parked || pageHidden()) return;
    for (const e of [...this.entries.values()]) {
      if (e.req.kind !== 'camera' || e.closed || e.error || !e.opened || e.restarting) continue;
      if (e.turn && (this.turnBusy || e.turnIdle)) continue; // closed on purpose by the schedule: not stuck, nothing to recover
      if (resume) {
        e.lastFrameAt = now;
        e.recAt = 0;
        if (e.mutedAt) e.mutedAt = now;
      }
      if (!resume && now - e.lastUsed > STUCK_MS + 1000) continue; // nobody wants this picture
      const v = e.el as HTMLVideoElement;
      if (v.currentTime !== e.lastSeenTime) {
        e.lastSeenTime = v.currentTime;
        e.lastFrameAt = now;
      }
      const ended = !e.stream || e.trackEnded || e.track?.readyState === 'ended';
      const muted = e.mutedAt > 0 && now - e.mutedAt > MUTE_GRACE_MS;
      const frozen = now - e.lastFrameAt > (e.stalledAt > e.lastFrameAt ? STUCK_MS / 2 : STUCK_MS);
      if (!ended && !muted && !frozen) {
        e.recStage = 0; // healthy again: the next trouble starts from the cheap fixes
        continue;
      }
      if (now < e.recAt) continue;
      this.recover(e, now, ended || muted);
    }
  }

  private recover(e: Entry, now: number, hard: boolean): void {
    const stage = hard ? Math.max(e.recStage, 2) : e.recStage;
    if (stage === 0) {
      void (e.el as HTMLVideoElement).play?.()?.catch?.(() => undefined);
      e.recStage = 1;
      e.recAt = now + CHEAP_FIX_MS;
      return;
    }
    if (stage === 1) {
      // a fresh video element on the same stream
      const old = e.el as HTMLVideoElement;
      const video = this.newVideo();
      video.srcObject = e.stream;
      old.pause?.();
      old.srcObject = null;
      e.el = video;
      e.fresh = true;
      e.lastTime = -1;
      void video.play?.()?.catch?.(() => undefined);
      this.watchFrames(e, video);
      this.watchTrack(e, video);
      e.recStage = 2;
      e.recAt = now + CHEAP_FIX_MS;
      return;
    }
    const run = stage - 2;
    if (run > RESTART_BACKOFF_MS.length) {
      this.gaveUp.set(e.key, GAVE_UP_MESSAGE);
      this.close(e);
      return;
    }
    e.recStage = stage + 1;
    void this.fullRestart(e, run);
  }

  /** The real restart: stop the stream, drop the picture sources, ask the browser for the camera again (through the ladder when another camera is open). The entry and its key stay. */
  private async fullRestart(e: Entry, run: number): Promise<void> {
    if (e.restarting || e.closed || e.req.kind !== 'camera') return;
    e.restarting = true;
    const video = this.newVideo();
    try {
      this.releaseStream(e);
      e.held = null;
      e.heldAt = null;
      const stream = await this.acquire(e, e.req);
      if (e.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await this.attachStream(e, video, stream);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'ClashError' && e.turns.clash !== 'stop' && !e.closed) this.joinTurns(e);
      else if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.cameraRefused = true;
        this.gaveUp.set(e.key, CAMERA_BLOCKED);
        this.close(e);
      }
    } finally {
      e.restarting = false;
      e.recAt = performance.now() + (RESTART_BACKOFF_MS[run] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]);
    }
  }

  /** When the camera that was keeping another one small closes, the other goes back up to the size it was asked for. */
  private raiseReduced(): void {
    const cams = this.deviceCameras();
    if (cams.length !== 1) return;
    const o = cams[0];
    const size = o.original;
    if (!o.reduced || !size) return;
    o.reduced = null;
    void o.track?.applyConstraints({ width: { ideal: size.width }, height: { ideal: size.height } }).catch(() => undefined);
  }

  /**
   * Ask for camera permission now, and restart every device camera. Call it from a button press: browsers show the question reliably
   * only then. Every device camera stream is stopped, whether it looks fine or not (a stream that Android took away can still look
   * "open"), every memory of failures is cleared, and the nodes open the cameras again on their next frame under the same source keys.
   */
  async askCamera(): Promise<{ ok: boolean; message?: string }> {
    if (this.camerasSuspended) return { ok: false, message: 'The camera is in use by the AR view. Leave the AR view first.' };
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, message: 'This browser has no camera access (it needs a secure page: https or localhost).' };
    this.cameraRefused = false;
    this.cameraFailed.clear();
    this.gaveUp.clear();
    this.pairs.clear();
    for (const e of [...this.entries.values()]) if (e.req.kind === 'camera') this.close(e);
    await new Promise((r) => setTimeout(r, 150)); // let the system let go of the camera
    try {
      const stream = await this.gum(true);
      stream.getTracks().forEach((t) => t.stop());
      this.devicesListeners.forEach((l) => l());
      return { ok: true };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.cameraRefused = true;
        const blocked = (await cameraPermission()) === 'denied';
        return { ok: false, message: blocked ? 'The camera is blocked for this site, so the browser does not ask any more. Tap the icon left of the address, open Permissions (or Site settings), set Camera to Allow, then press this again.' : 'The camera was not allowed.' };
      }
      return { ok: false, message: cameraErrorMessage(err) };
    }
  }

  /* ------------------------------- test and measure cameras ----------------------------------- */

  /** Close the device cameras for a moment (nodes get nothing meanwhile). The returned function opens them again, under the same keys. */
  private async parkCameras(): Promise<() => void> {
    const before = [...this.entries.values()].filter((x) => x.req.kind === 'camera' && !x.closed).map((x) => ({ key: x.key, req: x.req }));
    this.parked = true;
    for (const x of [...this.entries.values()]) if (x.req.kind === 'camera') this.close(x);
    await new Promise((r) => setTimeout(r, 150));
    return () => {
      this.parked = false;
      for (const b of before) {
        if (this.entries.has(b.key)) continue;
        this.entries.set(b.key, this.open(b.key, b.req));
      }
      if (before.length) this.ensureSweeper();
    };
  }

  /**
   * Try every back camera with every front camera (at most 6 pairs; when the sides are not known, pairs of the cameras in order) at
   * 1080p, 720p and 480p, and say which pairs work at which size. Whatever was open is opened again afterwards.
   */
  async testCamerasTogether(): Promise<{ ok: boolean; message?: string; rows: PairTest[]; lines: string[] }> {
    const fail = (message: string) => ({ ok: false, message, rows: [] as PairTest[], lines: [] as string[] });
    if (this.camerasSuspended) return fail('The camera is in use by the AR view. Leave the AR view first.');
    if (!navigator.mediaDevices?.getUserMedia) return fail('This browser has no camera access (it needs a secure page: https or localhost).');
    const raw = await rawVideoInputs();
    if (raw.length < 2) return fail('This device has fewer than two cameras, so there is nothing to test.');
    const names = nameCameras(raw);
    const nameOf = (id: string) => names.find((n) => n.id === id)?.label ?? 'Camera';
    const facing = (d: { id: string; label: string }) => (facingOfLabel(d.label) !== 'unknown' ? facingOfLabel(d.label) : facingOfId(d.id));
    const backs = raw.filter((d) => facing(d) === 'back');
    const fronts = raw.filter((d) => facing(d) === 'front');
    const pairs: [string, string][] = [];
    for (const b of backs) for (const f of fronts) pairs.push([b.id, f.id]);
    if (!pairs.length) for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++) pairs.push([raw[i].id, raw[j].id]);
    const restore = await this.parkCameras();
    const rows: PairTest[] = [];
    try {
      for (const [a, b] of pairs.slice(0, 6)) {
        const works: string[] = [];
        for (const t of TEST_SIZES) {
          const opened: MediaStream[] = [];
          try {
            for (const id of [a, b]) opened.push(await this.gum({ deviceId: { exact: id }, width: { ideal: t.size.width }, height: { ideal: t.size.height }, frameRate: { ideal: 30 } }));
            works.push(t.label);
          } catch (err) {
            const name = (err as { name?: string })?.name;
            if (name === 'NotAllowedError' || name === 'SecurityError') {
              this.cameraRefused = true;
              return fail(CAMERA_BLOCKED);
            }
          } finally {
            opened.forEach((s) => s.getTracks().forEach((x) => x.stop()));
          }
          await new Promise((r) => setTimeout(r, 60));
        }
        rows.push({ a: nameOf(a), b: nameOf(b), works });
      }
    } finally {
      restore();
    }
    const lines = describePairTests(rows);
    if (rows.length && rows.every((r) => !r.works.length)) lines.push(ONE_AT_A_TIME_LINE);
    else if (rows.length && rows.every((r) => r.works.length === TEST_SIZES.length)) lines.push('These cameras can run together at every size: no need to take turns.');
    else if (rows.length) lines.push('Some pairs work only at smaller sizes: the page lowers the picture size by itself when it needs to.');
    return { ok: true, rows, lines };
  }

  /** Open every camera briefly, one after the other, to learn what each reports (zoom range, largest picture, torch). Whatever was open is opened again afterwards. */
  async measureCameras(): Promise<{ ok: boolean; measured: number; message?: string }> {
    if (this.camerasSuspended) return { ok: false, measured: 0, message: 'The camera is in use by the AR view. Leave the AR view first.' };
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, measured: 0, message: 'This browser has no camera access (it needs a secure page: https or localhost).' };
    const raw = await rawVideoInputs();
    const restore = await this.parkCameras();
    let measured = 0;
    try {
      for (const d of raw) {
        if (!d.id) continue;
        try {
          const s = await this.gum({ deviceId: { exact: d.id } });
          const t = s.getVideoTracks()[0];
          noteCamera(d.id, { ...recordFromTrack((t?.getCapabilities?.() as unknown as Record<string, unknown>) ?? {}, (t?.getSettings?.() as unknown as Record<string, unknown>) ?? {}), label: d.label });
          measured++;
          s.getTracks().forEach((x) => x.stop());
        } catch (err) {
          const name = (err as { name?: string })?.name;
          if (name === 'NotAllowedError' || name === 'SecurityError') {
            this.cameraRefused = true;
            return { ok: false, measured, message: CAMERA_BLOCKED };
          }
        }
        await new Promise((r) => setTimeout(r, 60));
      }
    } finally {
      restore();
    }
    this.devicesListeners.forEach((l) => l());
    return { ok: true, measured };
  }

  /** Mark `fresh` whenever the video presents a new frame (cheap; falls back to currentTime polling). */
  private watchFrames(e: Entry, video: HTMLVideoElement): void {
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    const tick = () => {
      if (e.closed || e.el !== video) return;
      e.fresh = true;
      e.lastFrameAt = performance.now();
      e.rvfc = v.requestVideoFrameCallback!(tick);
    };
    e.rvfc = v.requestVideoFrameCallback(tick);
  }

  /* ------------------------------------- taking turns ----------------------------------------- */

  private turnGroup(): Entry[] {
    return [...this.entries.values()].filter((x) => x.turn && !x.closed && x.req.kind === 'camera');
  }

  /** Two cameras clashed: from now on they share the one-camera-at-a-time schedule. */
  private joinTurns(e: Entry): void {
    e.turn = true;
    e.turnIdle = true;
    for (const o of this.deviceCameras(e)) o.turn = true;
    if (!this.turnTimer) this.turnTimer = setInterval(() => this.turnTick(), TURN_TICK_MS);
  }

  /** The Webcam whose inspector is open (null: none). Under Role Automatic that camera is the main one. */
  viewCamera(req: LiveRequest | null): void {
    this.viewedKey = req && req.kind === 'camera' ? sourceKey(req) : '';
  }

  /** Refresh now: the next turn is for this camera. False when it is not a visited camera. */
  refreshNow(req: LiveRequest): boolean {
    const e = this.entries.get(sourceKey(req));
    if (!e || !e.turn || this.roles.main === e.key) return false;
    e.asked = true;
    e.backoffUntil = 0;
    return true;
  }

  private turnLineOf(e: Entry): string {
    if (!e.turn) return '';
    const role = this.roles.main === e.key ? 'main' : 'visited';
    return turnLine({
      role,
      lostMain: this.roles.lostMain.includes(e.key),
      live: !!e.stream,
      every: e.turns.every,
      age: e.lastGoodAt ? performance.now() - e.lastGoodAt : null,
      visitMs: this.visitMs,
      returnMs: this.returnMs,
      visiting: this.visiting !== '' && (role === 'main' || this.visiting === e.key),
      failed: e.fails > 0 && performance.now() < e.backoffUntil,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private turnsPaused(): boolean {
    return this.camerasSuspended || this.parked || this.cameraRefused;
  }

  private visitDue(v: Entry, now: number): boolean {
    if (v.asked) return true;
    if (now < v.backoffUntil) return false;
    if (now - v.lastUsed > IDLE_CLOSE_MS) return false; // nobody looks at this camera
    if (!v.lastGoodAt) return true; // the first picture is taken once, whatever Refresh every says
    return v.turns.every > 0 && now - v.lastGoodAt >= v.turns.every * 1000;
  }

  private turnTick(): void {
    if (this.turnBusy) return;
    const group = this.turnGroup();
    if (group.length < 2) {
      this.endTurns(group);
      return;
    }
    const now = performance.now();
    if (this.turnsPaused() || pageHidden() || group.some((x) => x.restarting)) return;
    this.roles = resolveRoles(group.map((x) => ({ key: x.key, role: x.turns.role, seq: x.seq, viewed: x.key === this.viewedKey })));
    const main = group.find((x) => x.key === this.roles.main);
    if (!main) return;
    for (const x of group) if (x !== main) x.turnIdle = true;
    if (!main.stream || group.some((x) => x !== main && x.stream)) {
      void this.runTurn(() => this.bringMain(main, group));
      return;
    }
    if (now - this.mainSince < MAIN_DWELL_MS || now - this.lastDrawable < RECORDING_QUIET_MS) return;
    const due = group.filter((x) => x !== main && this.visitDue(x, now)).sort((a, b) => a.lastGoodAt - b.lastGoodAt);
    if (due.length) void this.runTurn(() => this.visit(main, due[0]));
  }

  private async runTurn(fn: () => Promise<void>): Promise<void> {
    this.turnBusy = true;
    try {
      await fn();
    } catch {
      /* a failed turn is only a missing picture: the next tick looks again */
    } finally {
      this.visiting = '';
      this.turnBusy = false;
    }
  }

  /** Fewer than two cameras share the schedule any more: the remaining one is simply an ordinary camera. */
  private endTurns(group: Entry[]): void {
    for (const x of group) {
      x.turn = false;
      x.turnIdle = false;
    }
    this.roles = { main: '', visited: [], lostMain: [] };
    if (!group.length) {
      if (this.turnTimer) clearInterval(this.turnTimer);
      this.turnTimer = null;
      return;
    }
    const e = group[0];
    if (!e.stream && !e.restarting && !this.turnsPaused()) void this.runTurn(async () => void (await this.reopen(e)));
  }

  /** Keep the picture of a camera that is about to be closed, for its node to go on showing. */
  private async keepPicture(e: Entry): Promise<void> {
    if (e.stream && this.pictureOf(e)) await this.snapshot(e, e.maxSide, -1);
  }

  /** Make `main` the one open camera (the first time, after a change of roles, or when it was lost). */
  private async bringMain(main: Entry, group: Entry[]): Promise<void> {
    for (const x of group) {
      if (x === main || !x.stream) continue;
      await this.keepPicture(x);
      x.turnIdle = true;
      this.releaseStream(x);
    }
    if (!main.stream) {
      await this.sleep(RELEASE_GAP_MS);
      const t = performance.now();
      const ok = await this.reopen(main);
      if (ok) this.returnMs = performance.now() - t;
    }
    if (main.stream) main.turnIdle = false;
    this.mainSince = performance.now();
  }

  /** One visit: the main camera pauses, the visited camera gives one picture, the main camera comes back. */
  private async visit(main: Entry, v: Entry): Promise<void> {
    const t0 = performance.now();
    this.visiting = v.key;
    await this.keepPicture(main);
    main.turnIdle = true;
    this.releaseStream(main);
    await this.sleep(RELEASE_GAP_MS);
    let got = false;
    try {
      got = !this.turnsPaused() && (await this.takePicture(v));
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.cameraRefused = true;
    }
    const t1 = performance.now();
    v.asked = false;
    if (got) {
      v.fails = 0;
      v.lastGoodAt = t1;
      v.backoffUntil = 0;
      this.visitMs = t1 - t0;
    } else {
      v.fails++;
      v.backoffUntil = t1 + visitBackoff(v.fails); // the main camera comes back at once; this one is tried again later
    }
    await this.sleep(RELEASE_GAP_MS);
    const ok = this.turnsPaused() ? false : await this.reopen(main);
    if (ok) {
      this.returnMs = performance.now() - t1;
      main.turnIdle = false;
    }
    this.mainSince = performance.now();
  }

  /** Open a camera directly (no ladder, no memory of earlier clashes, no failure cooldown), a few times if it is slow to come back. */
  private async reopen(e: Entry): Promise<boolean> {
    for (let i = 0; ; i++) {
      try {
        const stream = await this.gum(this.primaryConstraints(e, e.req as Extract<LiveRequest, { kind: 'camera' }>));
        if (e.closed || this.turnsPaused()) {
          stream.getTracks().forEach((t) => t.stop());
          return false;
        }
        await this.attachStream(e, this.newVideo(), stream);
        return true;
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError' || i >= RETURN_RETRY_MS.length) {
          e.turnIdle = false;
          this.failOpen(e, err);
          return false;
        }
        await this.sleep(RETURN_RETRY_MS[i]);
        if (e.closed || this.turnsPaused()) return false;
      }
    }
  }

  /** Open the visited camera, wait for a real picture (and a few more so the exposure has settled), keep it, close the camera. */
  private async takePicture(v: Entry): Promise<boolean> {
    const stream = await this.gum(this.primaryConstraints(v, v.req as Extract<LiveRequest, { kind: 'camera' }>));
    const video = this.newVideo();
    try {
      if (v.closed || this.turnsPaused()) return false;
      const settings = (stream.getVideoTracks?.()[0]?.getSettings?.() ?? {}) as Record<string, unknown>;
      if (settings.deviceId) v.deviceId = String(settings.deviceId);
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (!(await this.waitPicture(video, v.turns.settle))) return false;
      v.el = video;
      return !!(await this.snapshot(v, v.maxSide, -1));
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      video.pause?.();
      video.srcObject = null;
    }
  }

  /** Resolves true once the video shows a real picture and `settle` more have gone by; false when no picture came in time. */
  private waitPicture(video: HTMLVideoElement, settle: number): Promise<boolean> {
    return new Promise((resolve) => {
      let first = false;
      const timer = setTimeout(() => resolve(first), FIRST_FRAME_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (typeof v.requestVideoFrameCallback === 'function') {
        let seen = 0;
        const step = () => {
          if (video.videoWidth > 0) first = true;
          if (first && ++seen > settle) return done();
          v.requestVideoFrameCallback!(step);
        };
        v.requestVideoFrameCallback(step);
        return;
      }
      const poll = () => {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          first = true;
          setTimeout(done, settle * 33);
        } else setTimeout(poll, 30);
      };
      poll();
    });
  }

  /* --------------------------------------- upload -------------------------------------------- */

  private async upload(e: Entry, maxSide: number): Promise<LiveFrame | null> {
    const el = e.el;
    const nw = e.isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
    const nh = e.isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
    if (!nw || !nh || (e.isVideo && (el as HTMLVideoElement).readyState < 2)) return e.frame;
    const { width, height } = targetSize(nw, nh, maxSide, this.gpu.device.limits.maxTextureDimension2D);
    const bucket = `${width}x${height}`;
    let fresh = e.fresh || bucket !== e.uploadedBucket || !e.frame;
    if (e.isVideo && !fresh) {
      const t = (el as HTMLVideoElement).currentTime;
      if (t !== e.lastTime) fresh = true; // no requestVideoFrameCallback: poll the playhead
    }
    if (!e.isVideo && !fresh) fresh = e.req.kind === 'url' && classifyUrl(e.req.url, e.req.mode) === 'mjpeg';
    if (!fresh) return e.frame;
    e.fresh = false;
    if (e.isVideo) e.lastTime = (el as HTMLVideoElement).currentTime;

    if (!e.texture || e.texture.width !== width || e.texture.height !== height) {
      if (e.texture) this.gpu.release(e.texture);
      e.texture = this.gpu.acquire(width, height, 'rgba8unorm');
      this.gpu.retain(e.texture);
      e.frame = { texture: e.texture, width, height };
    }
    try {
      await uploadExternal(this.gpu.device, el, e.texture, width, height, { width: nw, height: nh });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (e.req.kind === 'url' && (name === 'SecurityError' || /tainted|cross-origin/i.test(String(err)))) throw new Error(corsMessage(e.req.url));
      throw new Error(`The live picture could not be read (${(err as Error)?.message ?? String(err)}).`);
    }
    e.uploadedBucket = bucket;
    return e.frame;
  }

  /** Take the picture the source shows right now into the entry's held texture, for project time `at`. Null while there is no picture. */
  private async snapshot(e: Entry, maxSide: number, at: number): Promise<LiveFrame | null> {
    const el = this.pictureOf(e);
    if (!el) return null;
    const dims = el as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
    const nw = dims.videoWidth || dims.naturalWidth || dims.width || 0;
    const nh = dims.videoHeight || dims.naturalHeight || dims.height || 0;
    if (!nw || !nh) return null;
    const { width, height } = targetSize(nw, nh, maxSide, this.gpu.device.limits.maxTextureDimension2D);
    if (!e.heldTexture || e.heldTexture.width !== width || e.heldTexture.height !== height) {
      if (e.heldTexture) this.gpu.release(e.heldTexture);
      e.heldTexture = this.gpu.acquire(width, height, 'rgba8unorm');
      this.gpu.retain(e.heldTexture);
    }
    try {
      await uploadExternal(this.gpu.device, el as never, e.heldTexture, width, height, { width: nw, height: nh });
    } catch {
      return null;
    }
    e.held = { texture: e.heldTexture, width, height };
    e.heldAt = at;
    return e.held;
  }

  /** The phone's video (WebRTC) or its latest JPEG frame, uploaded like the camera path. */
  private async phoneFrame(e: Entry, token: string, maxSide: number, freeze: boolean): Promise<LiveFrame | null> {
    const src = this.phone?.source(token) ?? null;
    if (!src) throw new Error(this.phone?.unavailable() ?? 'The phone link is not available.');
    if (src.state === 'expired') throw new Error('The phone link expired. Make a new QR code.');
    if (src.state === 'waiting') throw new Error('Waiting for the phone: scan the QR code and open the link on it.');
    if (src.state === 'disconnected' && !src.bitmap && !(src.video && src.video.readyState >= 2)) throw new Error('The phone disconnected. Open the link on it again.');
    if (freeze && e.frame) return e.frame;
    const video = src.video && src.video.readyState >= 2 && src.video.videoWidth > 0 ? src.video : null;
    const el = video ?? src.bitmap;
    if (!el) return e.frame;
    const nw = video ? video.videoWidth : (el as ImageBitmap).width;
    const nh = video ? video.videoHeight : (el as ImageBitmap).height;
    const { width, height } = targetSize(nw, nh, maxSide, this.gpu.device.limits.maxTextureDimension2D);
    const bucket = `${width}x${height}`;
    if (e.frame && src.version === e.phoneVersion && bucket === e.uploadedBucket) return e.frame;
    if (!e.texture || e.texture.width !== width || e.texture.height !== height) {
      if (e.texture) this.gpu.release(e.texture);
      e.texture = this.gpu.acquire(width, height, 'rgba8unorm');
      this.gpu.retain(e.texture);
      e.frame = { texture: e.texture, width, height };
    }
    try {
      await uploadExternal(this.gpu.device, el, e.texture, width, height, { width: nw, height: nh });
    } catch (err) {
      throw new Error(`The phone picture could not be read (${(err as Error)?.message ?? String(err)}).`);
    }
    e.phoneVersion = src.version;
    e.uploadedBucket = bucket;
    return e.frame;
  }

  /* --------------------------------------- closing ------------------------------------------- */

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = performance.now();
      for (const e of [...this.entries.values()]) if (isIdle(e.lastUsed, now)) this.close(e);
    }, 1000);
  }

  private close(e: Entry): void {
    if (e.closed) return;
    e.closed = true;
    this.entries.delete(e.key);
    if (e.refreshTimer) clearInterval(e.refreshTimer);
    e.stream?.getTracks().forEach((t) => t.stop());
    if (e.el instanceof HTMLVideoElement) {
      e.el.pause();
      e.el.srcObject = null;
      e.el.removeAttribute('src');
      e.el.load();
    } else {
      e.el.removeAttribute('src');
    }
    if (e.texture) this.gpu.release(e.texture);
    if (e.heldTexture) this.gpu.release(e.heldTexture);
    e.texture = null;
    e.frame = null;
    e.heldTexture = null;
    e.held = null;
    if (this.entries.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    if (e.req.kind === 'camera') {
      this.raiseReduced();
      if (![...this.entries.values()].some((x) => x.req.kind === 'camera')) this.pageOff?.();
    }
  }
}

/** True while the page is in the background: no camera is checked or restarted then. */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && (document.visibilityState === 'hidden' || document.hidden === true);
}

/* ----------------------------------------- devices ---------------------------------------------- */

export interface Device {
  id: string;
  label: string;
}

/** The cameras as the browser lists them (labels only after the user granted permission). */
export async function rawVideoInputs(): Promise<Device[]> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput').map((d) => ({ id: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

/** Cameras with short plain names (see camera-catalogue.ts): the owner's own name, else the side and what the camera reported, else the browser's label. */
export async function listVideoInputs(): Promise<Device[]> {
  const raw = await rawVideoInputs();
  for (const d of raw) if (d.id && d.label) noteCamera(d.id, { label: d.label, ...(facingOfLabel(d.label) !== 'unknown' ? { facing: facingOfLabel(d.label) } : {}) });
  return nameCameras(raw);
}

export function onVideoDevicesChanged(listener: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.addEventListener) return () => undefined;
  md.addEventListener('devicechange', listener);
  const offNames = onCatalogueChanged(listener);
  return () => {
    md.removeEventListener('devicechange', listener);
    offNames();
  };
}
