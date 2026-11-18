/**
 * Go live (desktop app): sends what the viewer shows, with the sound mix, to a streaming service.
 *
 * HOW: the player's canvas is copied onto a hidden "stage" canvas of the stream's size at the stream's frame rate (so the stream
 * has a steady picture even while nothing in the viewer changes), `stage.captureStream()` plus the audio engine's output stream are
 * recorded by MediaRecorder in quarter-second pieces, and each piece is posted, in order, to the main process, which feeds FFmpeg
 * (desktop/addons/live.mjs). FFmpeg re-encodes to H.264 + AAC and sends it over RTMP. MediaRecorder keeps picture and sound in sync.
 *
 * WHAT IS SENT: whatever the player renders (like the Output window), so the preview scale applies. The app window has to stay
 * visible: a hidden or minimised window stops drawing.
 */
import type { StreamApi } from '../../io/api';
import { createStore, type Store } from './createStore';

export type StreamService = 'twitch' | 'youtube' | 'custom';

export interface StreamQuality {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Suggested video bitrate, kbit/s. */
  kbps: number;
}

/** The sizes streaming services recommend, with their usual bitrates. */
export const STREAM_QUALITIES: readonly StreamQuality[] = [
  { id: '720p30', label: '720p · 30 fps', width: 1280, height: 720, fps: 30, kbps: 3000 },
  { id: '720p60', label: '720p · 60 fps', width: 1280, height: 720, fps: 60, kbps: 4500 },
  { id: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, kbps: 4500 },
  { id: '1080p60', label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, kbps: 6000 },
  { id: 'v720p30', label: 'Vertical 720 × 1280 · 30 fps', width: 720, height: 1280, fps: 30, kbps: 3000 },
];

export interface StreamSettings {
  service: StreamService;
  /** Stream key. Kept on this computer only when `remember` is on. */
  key: string;
  /** Custom service: rtmp:// or rtmps:// address. */
  url: string;
  quality: string;
  /** Video bitrate, kbit/s. 0 = the quality's suggestion. */
  kbps: number;
  remember: boolean;
}

export const DEFAULT_STREAM_SETTINGS: StreamSettings = { service: 'twitch', key: '', url: '', quality: '720p30', kbps: 0, remember: false };
const KEY = 'rsmps.stream.settings';

type Store2 = Pick<Storage, 'getItem' | 'setItem'>;

/** Settings from storage. The key comes back only if it was stored with "remember". */
export function loadStreamSettings(store: Store2 | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): StreamSettings {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const o = raw as Partial<StreamSettings>;
      const remember = o.remember === true;
      return {
        service: o.service === 'youtube' || o.service === 'custom' ? o.service : 'twitch',
        key: remember && typeof o.key === 'string' ? o.key : '',
        url: typeof o.url === 'string' ? o.url : '',
        quality: STREAM_QUALITIES.some((q) => q.id === o.quality) ? (o.quality as string) : DEFAULT_STREAM_SETTINGS.quality,
        kbps: typeof o.kbps === 'number' && o.kbps >= 0 && o.kbps <= 51000 ? Math.round(o.kbps) : 0,
        remember,
      };
    }
  } catch {
    /* storage unavailable or damaged */
  }
  return { ...DEFAULT_STREAM_SETTINGS };
}

/** Store the settings; the stream key only with "remember" (it is as good as a password to the channel). */
export function saveStreamSettings(s: StreamSettings, store: Store2 | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): void {
  try {
    store?.setItem(KEY, JSON.stringify({ ...s, key: s.remember ? s.key : '' }));
  } catch {
    /* private window */
  }
}

export const qualityOf = (id: string): StreamQuality => STREAM_QUALITIES.find((q) => q.id === id) ?? STREAM_QUALITIES[0];

/** MediaRecorder formats, best first: H.264 is the cheapest to make (often hardware), VP8 works everywhere. FFmpeg re-encodes either. */
export const RECORDER_TYPES = ['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
export function recorderType(isSupported: (type: string) => boolean): string | null {
  return RECORDER_TYPES.find((t) => isSupported(t)) ?? null;
}

/** 3725 -> "1:02:05", 65 -> "1:05". */
export function streamClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Where a picture of `sw` x `sh` sits inside `dw` x `dh`, whole and centred (black bars around it). */
export function fitInside(sw: number, sh: number, dw: number, dh: number): { x: number; y: number; w: number; h: number } {
  if (!(sw > 0) || !(sh > 0)) return { x: 0, y: 0, w: dw, h: dh };
  const k = Math.min(dw / sw, dh / sh);
  const w = Math.round(sw * k);
  const h = Math.round(sh * k);
  return { x: Math.round((dw - w) / 2), y: Math.round((dh - h) / 2), w, h };
}

export interface StreamUi {
  phase: 'idle' | 'starting' | 'live' | 'stopping';
  /** Seconds on air. */
  seconds: number;
  kbps: number;
  fps: number;
  /** FFmpeg's speed: below about 0.9 the computer cannot keep up. */
  speed: number;
  /** Pieces are piling up faster than they are sent. */
  behind: boolean;
  /** Why the last stream ended, when it was not stopped by the user. */
  error: string | null;
  service: StreamService | null;
}

const IDLE: StreamUi = { phase: 'idle', seconds: 0, kbps: 0, fps: 0, speed: 0, behind: false, error: null, service: null };
const PIECE_MS = 250;
/** More than this waiting to be sent means the encoder or the connection is not keeping up. */
const BEHIND_BYTES = 6 * 1024 * 1024;

/** The hidden canvas of the stream's size that is recorded. */
export interface StreamStage {
  canvas: HTMLCanvasElement;
  /** Show this canvas (the player's). Call again when the player gets a new canvas. */
  attach(src: HTMLCanvasElement): void;
  /** Draw the current picture, fitted, with black around it. */
  draw(): void;
  dispose(): void;
}

/** The parts of the browser the controller uses, injectable for tests. */
export interface StreamEnv {
  findCanvas(): HTMLCanvasElement | null;
  createStage(width: number, height: number): StreamStage | null;
  capture(stage: HTMLCanvasElement, fps: number): MediaStream | null;
  recorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(type: string): boolean;
  mediaStream(tracks: MediaStreamTrack[]): MediaStream;
  every(ms: number, fn: () => void): () => void;
}

export const browserStreamEnv: StreamEnv = {
  findCanvas: () => document.querySelector<HTMLCanvasElement>('canvas.rs-viewer__canvas'),
  createStage(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    // The picture is taken the way the Output window takes it: the player's canvas is captured into a <video>, which always
    // holds the latest frame (a WebGPU canvas itself is empty again once its frame has been shown, so copying it at any
    // moment gives black). Where the browser cannot capture the canvas, the canvas is copied directly as a fallback.
    let src: HTMLCanvasElement | null = null;
    let video: HTMLVideoElement | null = null;
    const drop = () => {
      const stream = video?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      video = null;
    };
    return {
      canvas,
      attach(next) {
        if (next === src) return;
        drop();
        src = next;
        try {
          const stream = (next as HTMLCanvasElement & { captureStream?: () => MediaStream }).captureStream?.();
          if (stream) {
            video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.srcObject = stream;
            void video.play().catch(() => undefined);
          }
        } catch {
          video = null;
        }
      },
      draw() {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        const fromVideo = video && video.videoWidth > 0 && video.videoHeight > 0;
        const pic: HTMLVideoElement | HTMLCanvasElement | null = fromVideo ? video : src;
        const pw = fromVideo ? video!.videoWidth : (src?.width ?? 0);
        const ph = fromVideo ? video!.videoHeight : (src?.height ?? 0);
        if (!pic || !(pw > 0) || !(ph > 0)) return;
        const r = fitInside(pw, ph, width, height);
        try {
          ctx.drawImage(pic, r.x, r.y, r.w, r.h);
        } catch {
          /* the player's canvas is being replaced: keep the black frame */
        }
      },
      dispose: drop,
    };
  },
  capture: (stage, fps) => (stage as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream?.(fps) ?? null,
  recorder: (stream, options) => new MediaRecorder(stream, options),
  isTypeSupported: (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
  mediaStream: (tracks) => new MediaStream(tracks),
  every(ms, fn) {
    const t = window.setInterval(fn, ms);
    return () => window.clearInterval(t);
  },
};

export class StreamController {
  readonly store: Store<StreamUi> = createStore<StreamUi>({ ...IDLE });
  private id = '';
  private rec: MediaRecorder | null = null;
  private videoTracks: MediaStreamTrack[] = [];
  private queue: Blob[] = [];
  private queued = 0;
  private pumping: Promise<void> | null = null;
  private stops: (() => void)[] = [];

  constructor(
    private api: StreamApi,
    private toast: (message: string, kind: 'info' | 'error' | 'ok') => void,
    private env: StreamEnv = browserStreamEnv,
  ) {}

  get supported(): boolean {
    return this.api.supported;
  }
  get live(): boolean {
    return this.store.get().phase !== 'idle';
  }

  /** Start streaming. Resolves true when on air; false (with `error` set and a toast) when it could not start. */
  async start(settings: StreamSettings): Promise<boolean> {
    if (this.live) return false;
    const q = qualityOf(settings.quality);
    const fail = (message: string): false => {
      this.cleanup();
      this.store.set(() => ({ ...IDLE, error: message }));
      this.toast(message, 'error');
      return false;
    };
    this.store.set(() => ({ ...IDLE, phase: 'starting', service: settings.service }));
    const type = recorderType((t) => this.env.isTypeSupported(t));
    const canvas = this.env.findCanvas();
    if (!type) return fail('This version of the app cannot record its output for streaming.');
    if (!canvas) return fail('There is no picture to stream yet: open a project with an Output first.');
    const stage = this.env.createStage(q.width, q.height);
    const video = stage && this.env.capture(stage.canvas, q.fps);
    if (!stage || !video) return fail('The picture could not be captured for streaming.');
    stage.attach(canvas);
    stage.draw();
    this.stops.push(
      this.env.every(1000 / q.fps, () => {
        stage.attach(this.env.findCanvas() ?? canvas); // the viewer may get a new canvas (layout change): follow it
        stage.draw();
      }),
      () => stage.dispose(),
    );
    this.videoTracks = video.getVideoTracks();
    const audioTracks = this.api.audioStream()?.getAudioTracks() ?? [];
    try {
      const started = await this.api.start({ service: settings.service, key: settings.key.trim(), url: settings.url.trim(), width: q.width, height: q.height, fps: q.fps, videoKbps: settings.kbps > 0 ? settings.kbps : q.kbps, hasAudio: audioTracks.length > 0 });
      this.id = started.id;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    try {
      // recorded well above the stream's bitrate: FFmpeg encodes again, and the less this first pass loses the better
      const rec = this.env.recorder(this.env.mediaStream([...this.videoTracks, ...audioTracks]), { mimeType: type, videoBitsPerSecond: Math.max(8_000_000, (settings.kbps || q.kbps) * 2500), audioBitsPerSecond: 256_000 });
      rec.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        this.queue.push(e.data);
        this.queued += e.data.size;
        this.pump();
      };
      rec.onerror = () => void this.end('The recording of the output stopped unexpectedly.');
      rec.start(PIECE_MS);
      this.rec = rec;
    } catch (err) {
      void this.api.stop(this.id).catch(() => undefined);
      return fail(`The output could not be recorded for streaming (${err instanceof Error ? err.message : String(err)}).`);
    }
    this.stops.push(this.env.every(1000, () => void this.poll()));
    this.store.set((s) => ({ ...s, phase: 'live' }));
    if (!audioTracks.length) this.toast('Live without sound: there is no sound running. Press Enable audio and go live again to include it.', 'info');
    return true;
  }

  /** Stop by the user: send what is recorded, then end the stream. */
  async stop(): Promise<void> {
    if (!this.live || this.store.get().phase === 'stopping') return;
    await this.end(null);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = (async () => {
      while (this.queue.length) {
        const piece = this.queue.shift()!;
        try {
          await this.api.chunk(this.id, await piece.arrayBuffer());
        } catch (err) {
          this.queue.length = 0;
          this.queued = 0;
          void this.end(err instanceof Error ? err.message : String(err));
          return;
        }
        this.queued -= piece.size;
        const behind = this.queued > BEHIND_BYTES;
        if (behind !== this.store.get().behind) this.store.set((s) => ({ ...s, behind }));
      }
    })().finally(() => {
      this.pumping = null;
    });
  }

  private async poll(): Promise<void> {
    if (this.store.get().phase !== 'live') return;
    try {
      const info = await this.api.info();
      const cur = info.current && info.current.id === this.id ? info.current : null;
      if (cur) this.store.set((s) => (s.phase === 'live' ? { ...s, seconds: Math.max(cur.seconds, cur.wallSeconds), kbps: cur.kbps, fps: cur.fps, speed: cur.speed } : s));
      else if (this.store.get().phase === 'live') await this.end(info.last && info.last.id === this.id && info.last.error ? info.last.error : 'The stream ended.');
    } catch {
      /* a missed status is not the end of the stream */
    }
  }

  /** `error` null = stopped on purpose. */
  private async end(error: string | null): Promise<void> {
    if (this.store.get().phase === 'idle' || this.store.get().phase === 'stopping') return;
    this.store.set((s) => ({ ...s, phase: 'stopping' }));
    const rec = this.rec;
    if (rec && rec.state !== 'inactive') {
      const flushed = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        window.setTimeout(resolve, 1500);
      });
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      if (!error) await flushed;
    }
    if (!error && this.pumping) await Promise.race([this.pumping, new Promise((r) => window.setTimeout(r, 3000))]);
    let reason = error;
    try {
      const info = await this.api.stop(this.id);
      if (!reason && info.last?.id === this.id && info.last.error) reason = info.last.error;
    } catch {
      /* the main process is gone or already stopped */
    }
    this.cleanup();
    this.store.set(() => ({ ...IDLE, error: reason }));
    if (reason) this.toast(`The stream stopped: ${reason}`, 'error');
    else this.toast('The stream has ended.', 'ok');
  }

  private cleanup(): void {
    for (const off of this.stops.splice(0)) off();
    for (const t of this.videoTracks.splice(0)) t.stop(); // the picture capture only: the sound stream belongs to the audio engine
    this.rec = null;
    this.queue.length = 0;
    this.queued = 0;
    this.id = '';
  }
}
