/**
 * Recording a live picture (Webcam, Phone Camera, URL / Stream) into a video clip.
 *
 * `LiveRecorder` encodes: on a timer at the project frame rate it draws the current picture of the source into a canvas and hands
 * the frame to the same WebCodecs + mediabunny path the exporter uses (H.264 in MP4, VP9 in WebM as the fallback). Timestamps come
 * from the wall clock, so the clip plays in real time even when a tick was late or skipped. Picture only, no sound. The file is
 * kept in memory until Stop, so a recording ends by itself after `MAX_SECONDS` or `MAX_BYTES`.
 *
 * `LiveRecordController` is what the app uses (`io.liveRecorder`): one recording at a time, and the finished clip goes into the
 * Media library through the ordinary import path (`library.add`).
 */
import { BufferTarget, MediaStreamAudioTrackSource, Mp4OutputFormat, Output, Quality, VideoSample, VideoSampleSource, WebMOutputFormat, canEncodeAudio, canEncodeVideo, type AudioCodec, type VideoCodec } from 'mediabunny';
import type { AssetInfo, LiveSource } from '../engine/types';
import { choosePipeline, sourceOptions } from './encode-order';
import type { LiveRecordApi, LiveRecordFinish, LiveRecordResult, LiveRecordStart } from './api';

/* ----------------------------------------- pure helpers ----------------------------------------- */

/** Longest side of a recorded clip (larger pictures are scaled down). */
export const MAX_SIDE = 1920;
/** A recording stops by itself after this long… */
export const MAX_SECONDS = 30 * 60;
/** …or when the encoded clip (held in memory) reaches this size. */
export const MAX_BYTES = 1.5e9;
export const MIN_FPS = 5;
export const MAX_FPS = 60;

/** Frame rate of a recording: the project's, kept between 5 and 60. */
export function clampFps(fps: number): number {
  return Number.isFinite(fps) ? Math.min(MAX_FPS, Math.max(MIN_FPS, fps)) : 30;
}

/** Size of the clip for a source picture: long side at most `maxSide` (aspect kept), both sides rounded DOWN to even (H.264 needs that). */
export function recordSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  const k = long > maxSide ? maxSide / long : 1;
  const even = (v: number) => Math.max(2, Math.floor((v * k + 1e-6) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Which frame of the clip the picture at `elapsedSeconds` belongs to. */
export function frameIndexAt(elapsedSeconds: number, fps: number): number {
  return Math.max(0, Math.round(elapsedSeconds * fps));
}

/** Bitrate for a clip: about 0.12 bits per pixel per frame, between 2 and 20 Mbps. */
export function recordBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(20_000_000, Math.max(2_000_000, 0.12 * width * height * fps)));
}

/** True when a recording must end (30 minutes or 1.5 GB, whichever comes first). */
export function limitReached(elapsedSeconds: number, bytes: number): boolean {
  return elapsedSeconds >= MAX_SECONDS || bytes >= MAX_BYTES;
}

/** Pixel size of anything a canvas can draw (video, image, bitmap, canvas, VideoFrame); 0 x 0 when it has no picture yet. */
export function sourceSize(src: unknown): { width: number; height: number } {
  const s = src as Record<string, unknown> | null;
  if (!s) return { width: 0, height: 0 };
  const pick = (a: string, b: string) => ({ width: Number(s[a]) || 0, height: Number(s[b]) || 0 });
  if ('videoWidth' in s) return pick('videoWidth', 'videoHeight');
  if ('naturalWidth' in s) return pick('naturalWidth', 'naturalHeight');
  if ('displayWidth' in s) return pick('displayWidth', 'displayHeight');
  return pick('width', 'height');
}

/** "Phone take 2026-11-17 18.42.05.mp4" (local time; no characters a file system refuses). */
export function takeFileName(label: string, at: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${label} take ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}.${ext}`;
}

/** "0:12", "12:05": the running time on the Stop button. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where a w x h picture goes in a W x H frame when it is fitted inside it (centered, aspect kept). */
export function containRect(w: number, h: number, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const k = Math.min(W / w, H / h);
  return { x: (W - w * k) / 2, y: (H - h * k) / 2, w: w * k, h: h * k };
}

/* ----------------------------------------- recorder --------------------------------------------- */

export type LiveRecorderState = 'idle' | 'recording' | 'saving';

export interface LiveRecording {
  /** The clip has a sound track. */
  hasAudio: boolean;
  blob: Blob;
  name: string;
  frames: number;
  seconds: number;
  width: number;
  height: number;
}

export interface LiveRecorderOptions {
  /** Project frame rate (clamped to 5..60). */
  fps: number;
  /** First word of the file name ("Phone", "Webcam", "Stream"). */
  label?: string;
  /** How the node shows the picture: mirrored and / or turned clockwise in quarter turns. Read every frame. */
  orient?: () => { mirror: boolean; turns: number };
  /**
   * A live sound track to record with the picture (the app's sound mix), asked for once when the first picture arrives. Null or
   * absent = picture only. The clip then has sound from that moment on, in step with the picture.
   */
  audio?: () => MediaStreamTrack | null;
  /** Longest side of the clip (default 1920). */
  maxSide?: number;
}

interface Session {
  getSource: () => CanvasImageSource | null;
  fps: number;
  label: string;
  orient: () => { mirror: boolean; turns: number };
  audio: (() => MediaStreamTrack | null) | null;
  maxSide: number;
  /** True when the clip got a sound track. */
  hasAudio: boolean;
  started: Date;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  stopping: boolean;
  work: Promise<void>;
  output: Output | null;
  source: VideoSampleSource | null;
  canvas: OffscreenCanvas | null;
  ctx: OffscreenCanvasRenderingContext2D | null;
  webm: boolean;
  shiftFrames: number;
  width: number;
  height: number;
  /** performance.now() of frame 0; 0 until the encoder is ready. */
  t0: number;
  lastN: number;
  frames: number;
  bytes: number;
  shownSecond: number;
  error: Error | null;
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export class LiveRecorder {
  private s: Session | null = null;
  private _state: LiveRecorderState = 'idle';
  private listeners = new Set<() => void>();
  /** Called once when the recording must end by itself: a limit was reached, or a frame could not be encoded. The owner then calls `stop()`. */
  onAutoStop: ((reason: 'limit' | 'error', error?: Error) => void) | null = null;

  get state(): LiveRecorderState {
    return this._state;
  }
  /** Seconds recorded so far (0 until the first frame). */
  get elapsed(): number {
    const s = this.s;
    if (!s || !s.t0) return 0;
    return s.stopping ? (s.lastN + 1) / s.fps : (performance.now() - s.t0) / 1000;
  }
  get frames(): number {
    return this.s?.frames ?? 0;
  }

  /** Called on every state change and about once a second while recording. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Start recording what `getSource` returns. Ticks without a picture are skipped; nothing is encoded until the first picture. */
  start(getSource: () => CanvasImageSource | null, opts: LiveRecorderOptions): void {
    if (this._state !== 'idle') throw new Error('A recording is already running.');
    if (typeof VideoFrame === 'undefined' || typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('This browser cannot record video (it has no WebCodecs video encoder).');
    const fps = clampFps(opts.fps);
    const s: Session = {
      getSource,
      fps,
      label: opts.label ?? 'Live',
      orient: opts.orient ?? (() => ({ mirror: false, turns: 0 })),
      audio: opts.audio ?? null,
      maxSide: opts.maxSide ?? MAX_SIDE,
      hasAudio: false,
      started: new Date(),
      timer: null,
      busy: false,
      stopping: false,
      work: Promise.resolve(),
      output: null,
      source: null,
      canvas: null,
      ctx: null,
      webm: false,
      shiftFrames: 0,
      width: 0,
      height: 0,
      t0: 0,
      lastN: -1,
      frames: 0,
      bytes: 0,
      shownSecond: -1,
      error: null,
    };
    this.s = s;
    this._state = 'recording';
    // Twice per frame: a timer that fires exactly once per frame lands on the same frame index twice now and then (timer jitter)
    // and so leaves a gap; a tick whose frame was already recorded costs nothing.
    s.timer = setInterval(() => this.tick(s), 500 / fps);
    this.emit();
    this.tick(s);
  }

  private tick(s: Session): void {
    if (s.busy || s.stopping || this.s !== s) return;
    s.busy = true;
    s.work = this.step(s)
      .catch((err) => {
        s.error = asError(err);
      })
      .then(() => {
        s.busy = false;
        if (s.stopping || this.s !== s) return;
        const limit = s.t0 > 0 && limitReached((performance.now() - s.t0) / 1000, s.bytes);
        if (s.error || limit) {
          this.halt(s);
          this.onAutoStop?.(s.error ? 'error' : 'limit', s.error ?? undefined);
          return;
        }
        const second = Math.floor(this.elapsed);
        if (second !== s.shownSecond) {
          s.shownSecond = second;
          this.emit();
        }
      });
  }

  /** No more frames: the timer is off, `elapsed` is frozen at the clip's length. */
  private halt(s: Session): void {
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    s.stopping = true;
  }

  private async step(s: Session): Promise<void> {
    const src = s.getSource();
    if (!src) return;
    const size = sourceSize(src);
    if (!size.width || !size.height) return;
    const { mirror, turns } = s.orient();
    const swap = turns % 2 === 1;
    if (!s.output) {
      await this.setup(s, swap ? size.height : size.width, swap ? size.width : size.height);
      return; // the picture may have changed while the encoder was set up: the next tick records frame 0
    }
    if (!s.t0) s.t0 = performance.now();
    const n = frameIndexAt((performance.now() - s.t0) / 1000, s.fps);
    if (n <= s.lastN) return;
    const g = s.ctx!;
    const W = s.width;
    const H = s.height;
    try {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      // The picture as the node shows it (turned, then mirrored), fitted into the clip: a source that changes size mid-take is letterboxed.
      const r = containRect(swap ? size.height : size.width, swap ? size.width : size.height, W, H);
      g.translate(W / 2, H / 2);
      if (mirror) g.scale(-1, 1);
      g.rotate((turns * Math.PI) / 2);
      const dw = swap ? r.h : r.w;
      const dh = swap ? r.w : r.h;
      g.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    } catch (err) {
      if ((err as { name?: string })?.name === 'SecurityError') throw err;
      return; // a picture that went away between the check and the draw (a replaced phone frame): skip this tick
    }
    const frame = new VideoFrame(s.canvas!, { timestamp: Math.round(((n + s.shiftFrames) / s.fps) * 1e6), duration: Math.round(1e6 / s.fps) });
    const sample = new VideoSample(frame);
    try {
      await s.source!.add(sample);
    } finally {
      sample.close();
    }
    s.lastN = n;
    s.frames++;
  }

  /** Pick the codec and frame order for this size (measured like an export does), then open the file. */
  private async setup(s: Session, srcW: number, srcH: number): Promise<void> {
    const { width, height } = recordSize(srcW, srcH, s.maxSide);
    const fps = s.fps;
    const bitrate = recordBitrate(width, height, fps);
    const quality = new Quality({ bitrate });
    let chosen: { codec: VideoCodec; webm: boolean; realtime: boolean } | null = null;
    const tries: { codec: VideoCodec; webm: boolean; realtime: boolean }[] = [
      { codec: 'avc', webm: false, realtime: true },
      { codec: 'avc', webm: false, realtime: false },
      { codec: 'vp9', webm: true, realtime: true },
      { codec: 'vp9', webm: true, realtime: false },
    ];
    for (const t of tries) {
      if (await canEncodeVideo(t.codec, { width, height, frameRate: fps, quality, ...(t.realtime ? { latencyMode: 'realtime' as const } : {}) }).catch(() => false)) {
        chosen = t;
        break;
      }
    }
    if (!chosen) throw new Error(`This browser cannot encode ${width}x${height} video (tried H.264 and VP9).`);
    // Frame order is measured, not assumed (see encode-order.ts): encoders that emit B-frames get the Baseline profile or all key frames.
    const pick = await choosePipeline({ codec: chosen.codec, webm: chosen.webm }, { width, height, fps }, false, undefined, (codec) =>
      VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate, avc: { format: 'avc' } })
        .then((r) => r.supported === true)
        .catch(() => false),
    );
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser could not make a canvas to record into.');
    const output = new Output({ format: chosen.webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new BufferTarget() });
    const source = new VideoSampleSource({
      codec: chosen.codec,
      quality,
      keyFrameInterval: 1,
      ...(chosen.realtime ? { latencyMode: 'realtime' as const } : {}),
      ...sourceOptions(pick.options, fps),
      onEncodedPacket: (packet) => {
        s.bytes += packet.data.byteLength;
      },
    });
    output.addVideoTrack(source, { frameRate: fps });
    // Sound, when the owner has a live track for it: AAC in MP4 and Opus in WebM where the browser can encode them (Opus in MP4 as
    // the fallback). A track that cannot be encoded is left out with a warning; the picture is still recorded.
    const track = s.audio?.() ?? null;
    if (track && track.readyState === 'live') {
      const st = track.getSettings?.() ?? {};
      const cfg = { numberOfChannels: Math.min(2, st.channelCount ?? 2), sampleRate: st.sampleRate ?? 48000, bitrate: 192_000 };
      let codec: AudioCodec | null = null;
      for (const c of (chosen.webm ? ['opus'] : ['aac', 'opus']) as AudioCodec[]) {
        if (await canEncodeAudio(c, cfg).catch(() => false)) {
          codec = c;
          break;
        }
      }
      if (codec) {
        const audio = new MediaStreamAudioTrackSource(track as MediaStreamAudioTrack, { codec, bitrate: cfg.bitrate });
        // a sound encoder that breaks mid-take ends the recording the way a picture error does: what was recorded is still saved
        void audio.errorPromise.catch((err) => {
          if (this.s === s && !s.stopping) this.onAutoStop?.('error', asError(err));
        });
        output.addAudioTrack(audio);
        s.hasAudio = true;
      } else console.warn('This browser cannot encode the sound of a recording: the clip has the picture only.');
    }
    await output.start();
    s.canvas = canvas;
    s.ctx = ctx;
    s.webm = chosen.webm;
    s.shiftFrames = pick.shiftFrames;
    s.width = width;
    s.height = height;
    s.source = source;
    s.output = output;
  }

  /** Finish the file. Rejects (and releases the encoder) when no frame was recorded. */
  async stop(): Promise<LiveRecording> {
    const s = this.s;
    if (!s || this._state !== 'recording') throw new Error('Nothing is being recorded.');
    this.halt(s);
    this._state = 'saving';
    this.emit();
    let done = false;
    try {
      await s.work;
      if (!s.output || s.frames === 0) throw s.error ?? new Error('Nothing was recorded: no picture arrived.');
      await s.output.finalize();
      done = true;
      const buffer = (s.output.target as BufferTarget).buffer;
      if (!buffer) throw new Error('The recording could not be written.');
      const ext = s.webm ? 'webm' : 'mp4';
      return {
        hasAudio: s.hasAudio,
        blob: new Blob([buffer], { type: s.webm ? 'video/webm' : 'video/mp4' }),
        name: takeFileName(s.label, s.started, ext),
        frames: s.frames,
        seconds: (s.lastN + 1) / s.fps,
        width: s.width,
        height: s.height,
      };
    } finally {
      if (!done) await s.output?.cancel().catch(() => undefined);
      this.s = null;
      this._state = 'idle';
      this.emit();
    }
  }

  /** Throw the recording away and release the encoder. */
  async cancel(): Promise<void> {
    const s = this.s;
    if (!s || this._state !== 'recording') return;
    this.halt(s);
    this._state = 'saving';
    this.emit();
    try {
      await s.work;
      await s.output?.cancel().catch(() => undefined);
    } finally {
      this.s = null;
      this._state = 'idle';
      this.emit();
    }
  }
}

/* ----------------------------------------- controller ------------------------------------------- */

export interface LiveRecordDeps {
  /** `LiveSources` (src/io/live.ts). */
  live: { drawable(source: LiveSource): CanvasImageSource | null; hasPicture(source: LiveSource): boolean };
  /** The Media library's ordinary import. */
  add(files: File[]): Promise<AssetInfo[]>;
  recorder?: LiveRecorder;
}

/** `io.liveRecorder`: one recording at a time; the finished clip is imported into the Media library. */
export class LiveRecordController implements LiveRecordApi {
  private rec: LiveRecorder;
  private node: string | null = null;
  private finishing: Promise<LiveRecordResult | null> | null = null;
  private finished = new Set<(f: LiveRecordFinish) => void>();
  private listeners = new Set<() => void>();

  constructor(private d: LiveRecordDeps) {
    this.rec = d.recorder ?? new LiveRecorder();
    this.rec.onAutoStop = (reason, error) => void this.finish(reason, error);
    this.rec.subscribe(() => this.emit());
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  get state(): LiveRecorderState {
    return this.finishing ? 'saving' : this.rec.state;
  }
  get nodeId(): string | null {
    return this.node;
  }
  get elapsed(): number {
    return this.rec.elapsed;
  }
  get frames(): number {
    return this.rec.frames;
  }

  ready(source: LiveSource): boolean {
    return this.d.live.hasPicture(source);
  }

  start(o: LiveRecordStart): void {
    if (this.state !== 'idle') throw new Error('A recording is already running. Stop it first.');
    this.rec.start(
      () => {
        const src = o.source();
        if (src === 'gone') {
          void this.finish('gone');
          return null;
        }
        return src ? this.d.live.drawable(src) : null;
      },
      { fps: o.fps, label: o.label, orient: o.orient },
    );
    this.node = o.nodeId;
  }

  stop(): Promise<LiveRecordResult | null> {
    return this.finish('stop');
  }

  /** Stop, import the clip and tell the listeners. Every way a recording ends comes through here; resolves null when nothing was saved. */
  finish(reason: LiveRecordFinish['reason'], error?: Error): Promise<LiveRecordResult | null> {
    if (this.finishing) return this.finishing;
    if (this.rec.state !== 'recording') return Promise.resolve(null);
    const nodeId = this.node ?? '';
    const run = async (): Promise<LiveRecordResult | null> => {
      let out: LiveRecordFinish;
      try {
        const take = await this.rec.stop();
        const [asset] = await this.d.add([new File([take.blob], take.name, { type: take.blob.type })]);
        if (!asset) throw new Error('The clip could not be added to Media.');
        out = { reason, nodeId, result: { asset, name: take.name, seconds: take.seconds, frames: take.frames, width: take.width, height: take.height }, error: error?.message };
      } catch (err) {
        out = { reason, nodeId, result: null, error: asError(err).message };
      }
      this.node = null;
      this.finishing = null;
      this.emit();
      for (const l of [...this.finished]) l(out);
      return out.result;
    };
    this.finishing = run();
    return this.finishing;
  }

  async cancel(): Promise<void> {
    if (this.finishing) return;
    await this.rec.cancel();
    this.node = null;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFinished(listener: (f: LiveRecordFinish) => void): () => void {
    this.finished.add(listener);
    return () => this.finished.delete(listener);
  }
}
