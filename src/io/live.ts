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
    if (!f || !req.controls) return f;
    const e = this.entries.get(sourceKey(req));
    return e?.caps && digitalZoomFor(req.controls.zoom, e.caps) === 1 ? { ...f, nativeZoom: true } : f;
  }

  private async frameOf(req: LiveRequest, maxSide: number, hold?: { at: number; held: boolean }): Promise<LiveFrame | null> {
    const key = sourceKey(req);
    if (req.kind === 'camera' && this.camerasSuspended) return null;
    let e = this.entries.get(key);
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
    if (hold?.held && e.held && e.heldAt === hold.at) return e.held;
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
    if (req.kind === 'camera' && this.camerasSuspended) return null;
    let e = this.entries.get(key);
    if (!e && req.kind === 'camera' && this.cameraRefused) return null;
    if (!e) {
      e = this.open(key, req);
      this.entries.set(key, e);
      this.ensureSweeper();
    }
    e.lastUsed = performance.now();
    return this.pictureOf(e);
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
    return { open: !!track && !e?.closed, capabilities: e?.caps ?? {}, settings, digitalZoom: digitalZoomFor(c?.wanted.zoom, e?.caps ?? null), error: c?.error ?? '' };
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
    const base = { key, req, phoneVersion: -1, stream: null, track: null, caps: null, initial: {}, texture: null, frame: null, error: null, lastUsed: performance.now(), fresh: true, lastTime: -1, uploadedBucket: '', heldAt: null, heldTexture: null, held: null, refreshTimer: null, rvfc: 0, closed: false } as const;
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

  private async openCamera(e: Entry, video: HTMLVideoElement, req: Extract<LiveRequest, { kind: 'camera' }>): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      e.error = new Error('This browser has no camera access (it needs a secure page: https or localhost).');
      return;
    }
    try {
      const constraints: MediaTrackConstraints = {};
      if (req.deviceId) constraints.deviceId = { exact: req.deviceId };
      if (req.width) constraints.width = { ideal: req.width };
      if (req.height) constraints.height = { ideal: req.height };
      if (req.facing) constraints.facingMode = req.facing;
      const wantRate = this.ctl.get(e.key)?.wanted.frameRate ?? req.controls?.frameRate;
      if (wantRate && wantRate > 0) constraints.frameRate = { ideal: wantRate };
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      if (e.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      e.stream = stream;
      this.readTrack(e, stream);
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (video.readyState < 2) await new Promise<void>((r) => (video.onloadeddata = () => r()));
      this.watchFrames(e, video);
      this.devicesListeners.forEach((l) => l()); // labels become available after permission
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.cameraRefused = true;
        e.error = new Error(CAMERA_BLOCKED);
      } else {
        e.error = new Error(cameraErrorMessage(err));
        this.cameraFailed.set(e.key, { until: performance.now() + CAMERA_RETRY_MS, message: e.error.message });
      }
    }
  }

  /**
   * Ask for camera permission now. Call it from a button press: browsers show the question reliably only then. Cameras that
   * failed are closed, so the nodes open them again on the next frame. Returns the outcome with a readable message on failure.
   */
  async askCamera(): Promise<{ ok: boolean; message?: string }> {
    if (this.camerasSuspended) return { ok: false, message: 'The camera is in use by the AR view. Leave the AR view first.' };
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, message: 'This browser has no camera access (it needs a secure page: https or localhost).' };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getTracks().forEach((t) => t.stop());
      this.cameraRefused = false;
      this.cameraFailed.clear();
      for (const e of [...this.entries.values()]) if (e.req.kind === 'camera' && e.error) this.close(e);
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

  /** Mark `fresh` whenever the video presents a new frame (cheap; falls back to currentTime polling). */
  private watchFrames(e: Entry, video: HTMLVideoElement): void {
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    const tick = () => {
      if (e.closed) return;
      e.fresh = true;
      e.rvfc = v.requestVideoFrameCallback!(tick);
    };
    e.rvfc = v.requestVideoFrameCallback(tick);
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
  }
}

/* ----------------------------------------- devices ---------------------------------------------- */

export interface Device {
  id: string;
  label: string;
}

/** Cameras (labels only after the user granted permission: before that "Camera 1", …). */
export async function listVideoInputs(): Promise<Device[]> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch {
    return [];
  }
}

export function onVideoDevicesChanged(listener: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.addEventListener) return () => undefined;
  md.addEventListener('devicechange', listener);
  return () => md.removeEventListener('devicechange', listener);
}
