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
import type { LiveSource } from '../engine/types';

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

/* ----------------------------------------- sources ---------------------------------------------- */

interface Entry {
  key: string;
  req: LiveRequest;
  el: HTMLVideoElement | HTMLImageElement;
  phoneVersion: number;
  isVideo: boolean;
  stream: MediaStream | null;
  texture: GPUTexture | null;
  frame: LiveFrame | null;
  ready: Promise<void>;
  error: Error | null;
  lastUsed: number;
  /** A new picture may be available since the last upload. */
  fresh: boolean;
  lastTime: number;
  uploadedBucket: string;
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

  constructor(private gpu: Gpu) {}

  /** True while any source is open (the player uses this to keep its refresh loop honest). */
  get active(): boolean {
    return this.entries.size > 0;
  }

  async frame(req: LiveRequest, maxSide: number): Promise<LiveFrame | null> {
    const key = sourceKey(req);
    let e = this.entries.get(key);
    if (!e) {
      e = this.open(key, req);
      this.entries.set(key, e);
      this.ensureSweeper();
    }
    e.lastUsed = performance.now();
    if (req.kind === 'phone') return this.phoneFrame(e, req.session, maxSide, !!req.freeze);
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
    return this.upload(e, maxSide);
  }

  closeAll(): void {
    for (const e of [...this.entries.values()]) this.close(e);
  }

  /* --------------------------------------- opening ------------------------------------------- */

  private open(key: string, req: LiveRequest): Entry {
    const base = { key, req, phoneVersion: -1, stream: null, texture: null, frame: null, error: null, lastUsed: performance.now(), fresh: true, lastTime: -1, uploadedBucket: '', refreshTimer: null, rvfc: 0, closed: false } as const;
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
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      if (e.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      e.stream = stream;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (video.readyState < 2) await new Promise<void>((r) => (video.onloadeddata = () => r()));
      this.watchFrames(e, video);
      this.devicesListeners.forEach((l) => l()); // labels become available after permission
    } catch (err) {
      e.error = new Error(cameraErrorMessage(err));
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
    e.texture = null;
    e.frame = null;
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
