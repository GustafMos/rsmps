/**
 * MediaLibrary: imports, persists and decodes the user's media. Implements the engine `Host`.
 *
 * GPU memory model: every texture handed to the engine comes from `gpu.acquire()` and is retained by
 * the library while it sits in the frame store. The engine retains it again while one of its cached
 * node results references it. Eviction only drops the library's reference, so a texture is recycled
 * only when nobody uses it any more (no destroy-while-cached bugs, no engine.clear() on eviction).
 */
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  VideoSampleSink,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny';
import type { PcmAudio } from '../engine/audio/api';
import type { Gpu } from '../engine/gpu/gpu';
import type { AssetInfo, LiveSource, TextSpec } from '../engine/types';
import { LiveSources, type LiveRequest } from './live';
import type { AssetProblem, LibraryAsset, MediaLibrary } from './api';
import { encodeWav } from './wav';
import { idbAll, idbDelete, idbPut } from './db';
import type { SignalRouter } from './signals';
import { uploadExternal } from './upload';
import { ElementPool, ElementVideo, codecLabel, snapTime, unsupportedHint, unsupportedMessage } from './video-element';
import { TimedFrameStore } from './lru';
import { cssFont, wrapLines } from './text';
import { errorMessage, uniqueId } from './util';

interface Frame {
  texture: GPUTexture;
  width: number;
  height: number;
}

interface AssetRecord {
  id: string;
  added: number;
  info: AssetInfo;
  /** The file, or the first frame for image sequences. */
  blob: Blob;
  /** Image sequences: one still per frame. */
  frames?: Blob[];
}

type Kind = AssetInfo['kind'];

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ts', 'mts', 'm2ts'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba'];
const MIDI_EXT = ['mid', 'midi', 'kar'];

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function detectKind(file: { name: string; type: string }): Kind | null {
  const ext = extOf(file.name);
  const type = file.type.toLowerCase();
  if (MIDI_EXT.includes(ext) || type === 'audio/midi' || type === 'audio/x-midi' || type === 'audio/mid') return 'midi';
  if (type.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (type.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  if (type.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

/** Long side (texels) a request resolves to, bucketed so near-identical proxies share cache entries. */
export function sizeBucket(width: number, height: number, maxSide: number, deviceMax: number): { bucket: number; width: number; height: number } {
  const longSide = Math.max(width, height);
  const wanted = Math.min(maxSide > 0 ? maxSide : longSide, deviceMax);
  if (wanted >= longSide) return { bucket: 0, width, height };
  const bucket = Math.max(8, Math.ceil(wanted / 8) * 8);
  const scale = Math.min(1, bucket / longSide);
  return { bucket, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const FRAME_BUDGET_BYTES = 512 * 1024 * 1024;
/** Forward distance (s) over which the decoder keeps decoding instead of re-seeking. */
const SEEK_AHEAD_SECONDS = 1;
const THUMB_SIDE = 160;
/** Decoded sound kept in memory (bytes); older tracks are decoded again when needed. */
const AUDIO_CACHE_BYTES = 256 * 1024 * 1024;
/** Longest sound track decoded (seconds): longer ones are cut with a warning, so one huge file cannot exhaust memory. */
const MAX_AUDIO_SECONDS = 20 * 60;

/** Dev-only switch: serve every video through an HTMLVideoElement (localStorage.rsmpsForceVideoElement = '1' or ?forceVideoElement). Read once. */
function forceVideoElement(): boolean {
  try {
    return !!import.meta.env?.DEV && (localStorage.getItem('rsmpsForceVideoElement') === '1' || /[?&]forceVideoElement\b/.test(location.search));
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Video reader: one decoder cursor per asset                                                      */
/* ---------------------------------------------------------------------------------------------- */

class VideoReader {
  private input: Input;
  private track!: InputVideoTrack;
  private sink!: VideoSampleSink;
  private ready: Promise<void> | null = null;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  /** The latest sample at or before the last requested time. Owned by the reader. */
  cur: VideoSample | null = null;
  /** Start time of the sample after `cur` (Infinity once the stream ended). */
  nextStart = Infinity;
  private nextP: Promise<IteratorResult<VideoSample, void>> | null = null;
  private exhausted = false;
  private chain: Promise<unknown> = Promise.resolve();
  private scratch: OffscreenCanvas | null = null;
  /** Frames delivered so far: a decode failure before the first one means "use the browser's player instead". */
  served = 0;

  constructor(
    private blob: Blob,
    private fps: number,
  ) {
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      const track = await this.input.getPrimaryVideoTrack();
      if (!track) throw new Error('No video track.');
      if (!(await track.canDecode().catch(() => true))) {
        throw new Error('This browser cannot decode this video. Try re-encoding it to H.264 or VP9.');
      }
      this.track = track;
      this.sink = new VideoSampleSink(track);
    })();
    return this.ready;
  }

  /** Serialise cursor work: one request at a time per asset. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The decoded sample covering `t`, plus the time range it is valid for. Must run inside `run`. */
  async sampleAt(t: number): Promise<{ sample: VideoSample; start: number; end: number } | null> {
    await this.init();
    const cursorOk = this.iter && this.cur && t >= this.cur.timestamp && t - this.cur.timestamp <= SEEK_AHEAD_SECONDS;
    if (!cursorOk) this.seek(t);
    const iter = this.iter!;
    for (;;) {
      if (!this.nextP && !this.exhausted) this.nextP = iter.next();
      if (!this.nextP) break;
      let r: IteratorResult<VideoSample, void>;
      try {
        r = await this.nextP;
      } catch (err) {
        this.dropCursor(); // a failed decoder cannot continue: the next request re-seeks
        throw err;
      }
      if (r.done) {
        this.nextP = null;
        this.exhausted = true;
        this.nextStart = Infinity;
        break;
      }
      if (r.value.timestamp <= t + 1e-6 || !this.cur) {
        this.cur?.close();
        this.cur = r.value;
        this.nextP = null;
        continue;
      }
      this.nextStart = r.value.timestamp; // peeked; stays in nextP for the next call
      break;
    }
    if (!this.cur) {
      // Past the end of the stream, or before it begins: ask for the single nearest frame.
      const s = await this.sink.getSample(Math.max(0, t));
      if (!s) return null;
      this.cur = s;
      this.nextStart = Infinity;
    }
    this.served++;
    const cur = this.cur;
    // Keep the pipeline busy: ask for the following frame while the caller uploads this one.
    if (!this.nextP && !this.exhausted) {
      this.nextP = iter.next();
      this.nextP.catch(() => undefined);
    }
    const nominal = cur.duration > 0 ? cur.duration : 1 / this.fps;
    const end = this.exhausted ? Infinity : Math.max(this.nextStart, cur.timestamp + nominal * 0.5);
    return { sample: cur, start: cur.timestamp, end };
  }

  private seek(t: number): void {
    this.dropCursor();
    this.exhausted = false;
    this.nextStart = Infinity;
    this.iter = this.sink.samples(Math.max(0, t));
  }

  private dropCursor(): void {
    const iter = this.iter;
    const pending = this.nextP;
    this.iter = null;
    this.nextP = null;
    this.cur?.close();
    this.cur = null;
    pending?.then((r) => (r.done ? undefined : r.value.close())).catch(() => undefined);
    void iter?.return(undefined).catch(() => undefined);
  }

  /** Upload a sample into a pooled texture of the requested size. */
  async upload(sample: VideoSample, width: number, height: number, texture: GPUTexture, device: GPUDevice): Promise<void> {
    const dw = sample.displayWidth;
    const dh = sample.displayHeight;
    const plain = sample.rotation === 0 && !sample.flip;
    if (plain) {
      const vf = sample.toVideoFrame();
      try {
        if (vf.displayWidth === dw && vf.displayHeight === dh) {
          await uploadExternal(device, vf, texture, width, height, { width: dw, height: dh });
          return;
        }
      } finally {
        vf.close();
      }
    }
    // Rotated, flipped or non-square pixels: let mediabunny draw it with the metadata applied.
    const canvas = (this.scratch ??= new OffscreenCanvas(width, height));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    sample.draw(ctx, 0, 0, width, height);
    await uploadExternal(device, canvas, texture, width, height);
  }

  async thumbnail(t: number, side: number): Promise<Blob | null> {
    await this.init();
    const s = await this.sink.getSample(Math.max(0, t));
    if (!s) return null;
    try {
      const scale = Math.min(1, side / Math.max(s.displayWidth, s.displayHeight));
      const w = Math.max(1, Math.round(s.displayWidth * scale));
      const h = Math.max(1, Math.round(s.displayHeight * scale));
      const canvas = new OffscreenCanvas(w, h);
      s.draw(canvas.getContext('2d')!, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    } finally {
      s.close();
    }
  }

  dispose(): void {
    this.dropCursor();
    try {
      this.input.dispose();
    } catch {
      /* already disposed */
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Library                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** False once the browser has refused a VideoFrame as a texture source (then frames go through ImageBitmap). */

export class Library implements MediaLibrary {
  private infos = new Map<string, AssetInfo>();
  private blobs = new Map<string, Blob>();
  /** Image-sequence assets: the stills, in frame order. */
  private sequences = new Map<string, Blob[]>();
  private listeners = new Set<() => void>();
  private frames: TimedFrameStore<Frame>;
  private readers = new Map<string, VideoReader>();
  /** Videos served through an HTMLVideoElement because WebCodecs cannot decode them. */
  private elementAssets = new Set<string>();
  private pools = new Map<string, ElementPool>();
  private problems = new Map<string, AssetProblem>();
  private forceElement = forceVideoElement();
  private poolSweeper: ReturnType<typeof setInterval> | null = null;
  /** True while an export runs: video frames must be frame-exact (seek path only, never real-time playback). */
  exact = false;
  private frameBudget = FRAME_BUDGET_BYTES;
  private pending = new Map<string, Promise<Frame | null>>();
  private audio = new Map<string, Promise<PcmAudio | null>>();
  private audioBytes = new Map<string, number>();
  private thumbs = new Map<string, Promise<string | null>>();
  private textCanvas: OffscreenCanvas | null = null;
  readonly live: LiveSources;
  /** Bumps on every change to the asset list; the player folds it into its frame-cache key. */
  version = 0;
  /** Set by createIo: called when decoded content for an existing id may have changed. */
  onInvalidate: (() => void) | null = null;
  /** Source of `Host.signal` (live audio or offline export tracks). Set by createIo. */
  signals: SignalRouter | null = null;

  constructor(private gpu: Gpu) {
    this.live = new LiveSources(gpu);
    this.frames = new TimedFrameStore<Frame>(this.frameBudget, (f) => this.gpu.release(f.texture));
  }

  /* --------------------------------- listing -------------------------------- */

  list(opts?: { includeHidden?: boolean }): AssetInfo[] {
    const all = [...this.infos.values()];
    return opts?.includeHidden ? all : all.filter((a) => !(a as LibraryAsset).hidden);
  }

  signal(nodeId: string, name: string, seconds: number): number {
    return this.signals?.signal(nodeId, name, seconds) ?? 0;
  }

  assetInfo(assetId: string): AssetInfo | null {
    return this.infos.get(assetId) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.version++;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error(err);
      }
    }
  }

  /* ------------------------------- import/restore --------------------------- */

  async add(files: File[]): Promise<AssetInfo[]> {
    const added: AssetInfo[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        const info = await this.probe(file);
        this.infos.set(info.id, info);
        this.blobs.set(info.id, file);
        added.push(info);
        const record: AssetRecord = { id: info.id, added: Date.now(), info, blob: file };
        idbPut('assets', info.id, record).catch((err) =>
          console.warn(`"${file.name}" could not be saved for the next session: ${errorMessage(err)}`),
        );
      } catch (err) {
        failures.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    if (added.length) this.notify();
    if (failures.length) {
      if (!added.length) throw new Error(failures.join('\n'));
      console.warn('Some files could not be imported:\n' + failures.join('\n'));
    }
    return added;
  }

  async addSequence(name: string, frames: Blob[] | ImageBitmap[], fps: number): Promise<AssetInfo> {
    if (frames.length === 0) throw new Error('An image sequence needs at least one frame.');
    const rate = Number.isFinite(fps) && fps > 0 ? fps : 12;
    const blobs: Blob[] = [];
    for (const f of frames as (Blob | ImageBitmap)[]) {
      if (f instanceof Blob) blobs.push(f);
      else {
        const canvas = new OffscreenCanvas(f.width, f.height);
        canvas.getContext('2d')!.drawImage(f, 0, 0);
        blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
      }
    }
    let width = 0;
    let height = 0;
    try {
      const probe = await createImageBitmap(blobs[0]);
      width = probe.width;
      height = probe.height;
      probe.close();
    } catch {
      throw new Error('The first frame of the sequence could not be decoded.');
    }
    const info: AssetInfo = { id: uniqueId('a'), name, kind: 'video', width, height, duration: blobs.length / rate, fps: rate, hasAudio: false };
    this.infos.set(info.id, info);
    this.sequences.set(info.id, blobs);
    this.blobs.set(info.id, blobs[0]);
    const record: AssetRecord = { id: info.id, added: Date.now(), info, blob: blobs[0], frames: blobs };
    idbPut('assets', info.id, record).catch((err) => console.warn(`"${name}" could not be saved for the next session: ${errorMessage(err)}`));
    this.notify();
    return info;
  }

  async attachSequence(owner: string, name: string, frames: Blob[], fps: number): Promise<AssetInfo> {
    if (frames.length === 0) throw new Error('An image sequence needs at least one frame.');
    const rate = Number.isFinite(fps) && fps > 0 ? fps : 12;
    const probe = await createImageBitmap(frames[0]).catch(() => null);
    if (!probe) throw new Error('The first frame of the sequence could not be decoded.');
    const { width, height } = probe;
    probe.close();
    const existing = [...this.infos.values()].find((a) => (a as LibraryAsset).owner === owner);
    const id = existing?.id ?? uniqueId('a');
    const info: LibraryAsset = { id, name, kind: 'video', width, height, duration: frames.length / rate, fps: rate, hasAudio: false, owner, hidden: true };
    if (existing) {
      // Same id, new frames: drop everything decoded for the old ones so the engine and player re-render.
      this.frames.dropGroups(`${id}|`);
      this.readers.get(id)?.dispose();
      this.readers.delete(id);
    }
    this.infos.set(id, info);
    this.sequences.set(id, frames);
    this.blobs.set(id, frames[0]);
    const record: AssetRecord = { id, added: Date.now(), info, blob: frames[0], frames };
    idbPut('assets', id, record).catch((err) => console.warn(`"${name}" could not be saved for the next session: ${errorMessage(err)}`));
    this.onInvalidate?.();
    this.notify(); // bumps `version`: the player's frame cache key changes
    return info;
  }

  async addRecording(name: string, pcm: PcmAudio): Promise<AssetInfo> {
    const frames = pcm.channels[0]?.length ?? 0;
    if (frames === 0) throw new Error('The recording is empty.');
    const channels = pcm.channels.slice(0, 2).map((c) => c.slice());
    const blob = new Blob([encodeWav({ sampleRate: pcm.sampleRate, channels }, 32) as BlobPart], { type: 'audio/wav' });
    const info: AssetInfo = { id: uniqueId('a'), name, kind: 'audio', width: 0, height: 0, duration: frames / pcm.sampleRate, fps: 0, hasAudio: true };
    this.infos.set(info.id, info);
    this.blobs.set(info.id, blob);
    // Serve it to the audio engine right away, without decoding the WAV again.
    this.audio.set(info.id, Promise.resolve({ sampleRate: pcm.sampleRate, channels }));
    this.audioBytes.set(info.id, channels.reduce((s, c) => s + c.byteLength, 0));
    const record: AssetRecord = { id: info.id, added: Date.now(), info, blob };
    idbPut('assets', info.id, record).catch((err) => console.warn(`"${name}" could not be saved for the next session: ${errorMessage(err)}`));
    this.notify();
    return info;
  }

  async removeOwned(owner: string): Promise<void> {
    for (const a of [...this.infos.values()]) if ((a as LibraryAsset).owner === owner) await this.remove(a.id);
  }

  async restore(): Promise<void> {
    let records: AssetRecord[] = [];
    try {
      records = await idbAll<AssetRecord>('assets');
    } catch (err) {
      console.warn('Could not restore media:', err);
      return;
    }
    records.sort((a, b) => a.added - b.added);
    for (const r of records) {
      if (!r?.info || !r.blob) continue;
      this.infos.set(r.id, r.info);
      this.blobs.set(r.id, r.blob);
      if (r.frames?.length) this.sequences.set(r.id, r.frames);
    }
    if (records.length) this.notify();
  }

  async remove(assetId: string): Promise<void> {
    if (!this.infos.delete(assetId)) return;
    this.blobs.delete(assetId);
    this.sequences.delete(assetId);
    this.frames.dropGroups(`${assetId}|`);
    this.readers.get(assetId)?.dispose();
    this.readers.delete(assetId);
    this.dropElements(assetId);
    this.problems.delete(assetId);
    this.audio.delete(assetId);
    const thumb = this.thumbs.get(assetId);
    this.thumbs.delete(assetId);
    void thumb?.then((url) => url && URL.revokeObjectURL(url));
    try {
      await idbDelete('assets', assetId);
    } catch (err) {
      console.warn('Could not delete the stored file:', err);
    }
    this.onInvalidate?.();
    this.notify();
  }

  private async probe(file: File): Promise<AssetInfo> {
    const kind = detectKind(file);
    if (!kind) throw new Error('Unsupported file type.');
    const id = uniqueId('a');
    const base: AssetInfo = { id, name: file.name, kind, width: 0, height: 0, duration: 0, fps: 0, hasAudio: false };
    if (kind === 'midi') return base;
    if (kind === 'image') {
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(file);
      } catch {
        throw new Error('The browser could not decode this image.');
      }
      const info = { ...base, width: bmp.width, height: bmp.height };
      bmp.close();
      return info;
    }
    // Video and audio go through mediabunny for probing.
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      if (!(await input.canRead().catch(() => false))) throw new Error('Unreadable or unsupported media file.');
      const vtrack = kind === 'video' ? await pickVideoTrack(input) : null;
      const atrack = await input.getPrimaryAudioTrack().catch(() => null);
      if (kind === 'video' && !vtrack) {
        if (!atrack) throw new Error('No video track found.');
        base.kind = 'audio';
      }
      if (vtrack) {
        let width = 0;
        let height = 0;
        try {
          width = await vtrack.getDisplayWidth();
          height = await vtrack.getDisplayHeight();
        } catch {
          /* fall through */
        }
        if (!width || !height) {
          width = await vtrack.getCodedWidth();
          height = await vtrack.getCodedHeight();
        }
        let fps = 24;
        try {
          const m = await vtrack.computeFrameRateMetrics();
          fps = [m.bestGuessFrameRate, m.averageFrameRate, 24].find((v) => Number.isFinite(v) && v > 0) ?? 24;
        } catch {
          /* keep 24 */
        }
        const duration = await firstPositive([
          () => input.computeDuration(),
          () => vtrack.computeDuration(),
          () => input.getDurationFromMetadata([vtrack]),
        ]);
        let codec = '';
        try {
          codec = codecLabel(await vtrack.getCodec(), await vtrack.getCodecParameterString().catch(() => null));
        } catch {
          codec = '';
        }
        return { ...base, width, height, fps, duration, hasAudio: !!atrack, ...(codec ? { codec } : {}) } as AssetInfo;
      }
      const duration = await firstPositive([
        () => input.computeDuration(),
        () => (atrack ? atrack.computeDuration() : Promise.resolve(0)),
      ]);
      return { ...base, duration, hasAudio: true };
    } finally {
      input.dispose();
    }
  }

  /* ---------------------------------- frames -------------------------------- */

  assetFrame(assetId: string, seconds: number, maxSide: number): Promise<Frame | null> {
    const info = this.infos.get(assetId);
    if (!info) return Promise.resolve(null);
    if (info.kind !== 'image' && info.kind !== 'video') return Promise.resolve(null);
    if (!info.width || !info.height) return Promise.resolve(null);
    const device = this.gpu.device;
    const size = sizeBucket(info.width, info.height, maxSide, device.limits.maxTextureDimension2D);
    const group = `${assetId}|${size.bucket}`;
    const t = info.kind === 'image' ? 0 : Math.max(0, seconds);
    const hit = this.frames.find(group, t);
    if (hit) return Promise.resolve(hit);
    const sequence = this.sequences.get(assetId);
    if (sequence) return this.decodeSequenceFrame(info, sequence, size, group, t);
    if (info.kind === 'image') {
      let p = this.pending.get(group);
      if (!p) {
        p = this.decodeImage(info, size, group).finally(() => this.pending.delete(group));
        this.pending.set(group, p);
      }
      return p;
    }
    return this.decodeVideoFrame(info, size, group, t);
  }

  private takeTexture(width: number, height: number): GPUTexture {
    const tex = this.gpu.acquire(width, height, 'rgba8unorm');
    this.gpu.retain(tex);
    return tex;
  }

  private bytesOf(f: { width: number; height: number }): number {
    return f.width * f.height * 4;
  }

  private async decodeImage(info: AssetInfo, size: { bucket: number; width: number; height: number }, group: string): Promise<Frame | null> {
    const blob = this.blobs.get(info.id);
    if (!blob) return null;
    const bmp =
      size.bucket === 0
        ? await createImageBitmap(blob)
        : await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
    if (!this.infos.has(info.id)) {
      bmp.close();
      return null;
    }
    // Read the size BEFORE close(): a closed ImageBitmap reports 0×0.
    const bw = bmp.width;
    const bh = bmp.height;
    const texture = this.takeTexture(bw, bh);
    try {
      this.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture, premultipliedAlpha: true }, [bw, bh]);
    } finally {
      bmp.close();
    }
    const frame: Frame = { texture, width: bw, height: bh };
    this.frames.put(group, 0, Infinity, this.bytesOf(frame), frame);
    return frame;
  }

  /** Image-sequence asset: frame = floor(seconds x fps), clamped to the last frame. */
  private decodeSequenceFrame(info: AssetInfo, stills: Blob[], size: { bucket: number; width: number; height: number }, group: string, t: number): Promise<Frame | null> {
    const idx = Math.min(stills.length - 1, Math.max(0, Math.floor(t * info.fps + 1e-6)));
    const key = `${group}#${idx}`;
    let p = this.pending.get(key);
    if (!p) {
      p = (async () => {
        const blob = stills[idx];
        const bmp =
          size.bucket === 0
            ? await createImageBitmap(blob)
            : await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
        if (!this.infos.has(info.id)) {
          bmp.close();
          return null;
        }
        // Read the size BEFORE close(): a closed ImageBitmap reports 0×0.
        const bw = bmp.width;
        const bh = bmp.height;
        const texture = this.takeTexture(bw, bh);
        try {
          this.gpu.device.queue.copyExternalImageToTexture({ source: bmp }, { texture, premultipliedAlpha: true }, [bw, bh]);
        } finally {
          bmp.close();
        }
        const frame: Frame = { texture, width: bw, height: bh };
        const end = idx === stills.length - 1 ? Infinity : (idx + 1) / info.fps;
        this.frames.put(group, idx / info.fps, end, this.bytesOf(frame), frame);
        return frame;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private decodeVideoFrame(info: AssetInfo, size: { bucket: number; width: number; height: number }, group: string, t: number): Promise<Frame | null> {
    const blob = this.blobs.get(info.id);
    if (!blob) return Promise.resolve(null);
    let reader = this.readers.get(info.id);
    if (!reader) {
      reader = new VideoReader(blob, info.fps || 24);
      this.readers.set(info.id, reader);
    }
    if (this.elementAssets.has(info.id) || this.forceElement) return this.elementFrame(info, size, group, t);
    const r = reader;
    return r
      .run(async () => {
      // Another request queued ahead of us may already have decoded this frame.
      const again = this.frames.find(group, t);
      if (again) return again;
      const got = await r.sampleAt(t);
      if (!got) return null;
      const texture = this.takeTexture(size.width, size.height);
      try {
        await r.upload(got.sample, size.width, size.height, texture, this.gpu.device);
      } catch (err) {
        this.gpu.release(texture);
        throw err;
      }
      const frame: Frame = { texture, width: size.width, height: size.height };
      if (this.infos.has(info.id)) this.frames.put(group, got.start, got.end, this.bytesOf(frame), frame);
      return frame;
    })
      .catch((err) => {
        // WebCodecs could not decode this video (phone HEVC, 10-bit...) and never produced a frame: use the browser's player.
        if (r.served > 0 || !this.infos.has(info.id)) throw err;
        this.elementAssets.add(info.id);
        r.dispose();
        this.readers.delete(info.id);
        return this.elementFrame(info, size, group, t);
      });
  }

  /* ------------------------- video through an HTMLVideoElement (fallback) ------------------------ */

  private poolFor(info: AssetInfo): ElementPool | null {
    let pool = this.pools.get(info.id);
    if (!pool) {
      const blob = this.blobs.get(info.id);
      if (!blob) return null;
      // Several elements of a 4K video are heavy: cap the pool by pixels (about 20 megapixels in total).
      const cap = Math.max(1, Math.min(3, Math.floor(20_000_000 / Math.max(1, info.width * info.height))));
      pool = new ElementPool(() => new ElementVideo(blob, info.fps || 24, info.duration), cap);
      this.pools.set(info.id, pool);
      this.poolSweeper ??= setInterval(() => {
        const now = performance.now();
        for (const p of this.pools.values()) p.sweep(now);
      }, 250);
    }
    return pool;
  }

  private markUnsupported(info: AssetInfo): Error {
    const label = (info as LibraryAsset).codec ?? 'this';
    this.problems.set(info.id, { code: 'unsupported-codec', codec: label, hint: unsupportedHint(info.name) });
    return new Error(unsupportedMessage(info.name, label));
  }

  assetProblem(assetId: string): AssetProblem | null {
    return this.problems.get(assetId) ?? null;
  }

  private async elementFrame(info: AssetInfo, size: { bucket: number; width: number; height: number }, group: string, t: number): Promise<Frame | null> {
    const pool = this.poolFor(info);
    if (!pool) return null;
    const fps = info.fps || 24;
    const snapped = snapTime(t, fps);
    const end = snapped + 1 / fps;
    const approxGroup = `${group}|p`;
    if (!this.exact) {
      // Frames from real-time playback are only approximately at their time: never served to exports (this.exact).
      const hit = this.frames.find(approxGroup, t);
      if (hit) return hit;
    }
    const ev = pool.pick(t);
    try {
      await ev.open();
    } catch {
      throw this.markUnsupported(info);
    }
    let frame: Frame | null = null;
    const wasExact = await ev.present(t, this.exact, async () => {
      const texture = this.takeTexture(size.width, size.height);
      try {
        await uploadExternal(this.gpu.device, ev.video, texture, size.width, size.height, ev.size);
      } catch (err) {
        this.gpu.release(texture);
        throw err;
      }
      frame = { texture, width: size.width, height: size.height };
    });
    if (!frame) return null;
    const f: Frame = frame;
    if (this.infos.has(info.id)) this.frames.put(wasExact ? group : approxGroup, snapped, end, this.bytesOf(f), f);
    return f;
  }

  private async elementThumbnail(info: AssetInfo): Promise<Blob | null> {
    const blob = this.blobs.get(info.id);
    if (!blob) return null;
    const ev = new ElementVideo(blob, info.fps || 24, info.duration);
    try {
      await ev.open();
      await ev.present(Math.min(1, info.duration * 0.1), true);
      const v = ev.video;
      const k = Math.min(1, THUMB_SIDE / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.max(1, Math.round(v.videoWidth * k));
      const h = Math.max(1, Math.round(v.videoHeight * k));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d')!.drawImage(v, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    } catch {
      this.markUnsupported(info);
      return null;
    } finally {
      ev.dispose();
    }
  }

  /* ----------------------------------- audio -------------------------------- */

  assetAudio(assetId: string): Promise<PcmAudio | null> {
    const info = this.infos.get(assetId);
    if (!info || (info.kind !== 'audio' && !(info.kind === 'video' && info.hasAudio))) return Promise.resolve(null);
    let p = this.audio.get(assetId);
    if (!p) {
      p = this.decodeAudio(info).catch((err) => {
        console.warn(`Could not decode audio of "${info.name}":`, err);
        this.audio.delete(assetId);
        return null;
      });
      this.audio.set(assetId, p);
      void p.then((pcm) => {
        if (pcm && this.audio.get(assetId) === p) {
          this.audioBytes.set(assetId, pcm.channels.reduce((s, c) => s + c.byteLength, 0));
          this.evictAudio(assetId);
        }
      });
    }
    // A video's sound track carries the clip's duration and frame rate: Media In needs them to map trim and speed.
    if (info.kind !== 'video') return p;
    return p.then((pcm) => (pcm ? { ...pcm, video: { duration: info.duration, fps: info.fps || 24 } } : null));
  }

  /** Decoded PCM is CPU memory: keep at most AUDIO_CACHE_BYTES, dropping the least recently decoded (never `keep`). */
  private evictAudio(keep: string): void {
    let total = 0;
    for (const n of this.audioBytes.values()) total += n;
    for (const id of [...this.audio.keys()]) {
      if (total <= AUDIO_CACHE_BYTES) break;
      if (id === keep) continue;
      total -= this.audioBytes.get(id) ?? 0;
      this.audio.delete(id);
      this.audioBytes.delete(id);
    }
  }

  private async decodeAudio(info: AssetInfo): Promise<PcmAudio | null> {
    const blob = this.blobs.get(info.id);
    if (!blob) return null;
    if (info.kind === 'audio') {
      try {
        const ctx = new OfflineAudioContext(2, 1, 48000);
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        return audioBufferToPcm(buf);
      } catch {
        /* fall back to mediabunny below */
      }
    }
    try {
      const pcm = await decodeTrackPcm(blob);
      if (pcm) return pcm;
    } catch {
      /* fall back to the browser's decoder below */
    }
    // AAC in MP4 decodes in every browser even when the video does not.
    const ctx = new OfflineAudioContext(2, 1, 48000);
    return audioBufferToPcm(await ctx.decodeAudioData(await blob.arrayBuffer()));
  }

  /* --------------------------------- thumbnails ----------------------------- */

  thumbnail(assetId: string): Promise<string | null> {
    const info = this.infos.get(assetId);
    if (!info) return Promise.resolve(null);
    let p = this.thumbs.get(assetId);
    if (!p) {
      p = this.makeThumbnail(info).catch(() => null);
      this.thumbs.set(assetId, p);
    }
    return p;
  }

  private async makeThumbnail(info: AssetInfo): Promise<string | null> {
    const blob = this.blobs.get(info.id);
    if (!blob) return null;
    if (info.kind === 'image' || this.sequences.has(info.id)) {
      const long = Math.max(info.width, info.height);
      const scale = Math.min(1, THUMB_SIDE / Math.max(1, long));
      const w = Math.max(1, Math.round(info.width * scale));
      const h = Math.max(1, Math.round(info.height * scale));
      const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }));
    }
    if (info.kind === 'video') {
      let reader = this.readers.get(info.id);
      if (!reader) {
        reader = new VideoReader(blob, info.fps || 24);
        this.readers.set(info.id, reader);
      }
      let out: Blob | null = null;
      if (!this.elementAssets.has(info.id) && !this.forceElement) {
        try {
          out = await reader.thumbnail(Math.min(1, info.duration * 0.1), THUMB_SIDE);
        } catch {
          out = null; // WebCodecs cannot decode it: try the browser's own player
        }
      }
      out ??= await this.elementThumbnail(info);
      return out ? URL.createObjectURL(out) : null;
    }
    return null;
  }

  /* ----------------------------------- text --------------------------------- */

  /** Release the <video> elements and object URLs of one asset (the choice of decoder is kept). */
  private dropElements(assetId: string): void {
    this.pools.get(assetId)?.dispose();
    this.pools.delete(assetId);
    if (this.pools.size === 0 && this.poolSweeper) {
      clearInterval(this.poolSweeper);
      this.poolSweeper = null;
    }
  }

  /** Diagnostics: how many times the element path had to seek (tests / dev tools). */
  elementSeeks(assetId: string): number {
    return this.pools.get(assetId)?.totalSeeks() ?? 0;
  }

  /** Host.liveFrame: webcam / URL pictures (see live.ts). Throws readable errors. */
  liveFrame(source: LiveSource, maxSide: number): Promise<Frame | null> {
    return this.live.frame(source as LiveRequest, maxSide);
  }

  rasterizeText(spec: TextSpec): { data: Uint8ClampedArray; width: number; height: number } | null {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const probe = (this.textCanvas ??= new OffscreenCanvas(8, 8));
    const mctx = probe.getContext('2d', { willReadFrequently: true })!;
    const font = cssFont(spec);
    mctx.font = font;
    const measure = (s: string) => mctx.measureText(s).width;
    const lines = wrapLines(spec.text, spec.maxWidthPx > 0 ? spec.maxWidthPx : 0, measure);
    const lineH = Math.max(1, spec.sizePx * (spec.lineHeight > 0 ? spec.lineHeight : 1.2));
    const pad = Math.ceil(spec.sizePx * 0.15) + 2;
    let textW = 0;
    for (const l of lines) textW = Math.max(textW, measure(l));
    const boxW = spec.maxWidthPx > 0 ? Math.max(spec.maxWidthPx, textW) : textW;
    const width = Math.max(1, Math.ceil(boxW + pad * 2));
    const height = Math.max(1, Math.ceil(lines.length * lineH + pad * 2));
    if (width > 16384 || height > 16384) return null;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = spec.align;
    const x = spec.align === 'left' ? pad : spec.align === 'center' ? width / 2 : width - pad;
    lines.forEach((line, i) => ctx.fillText(line, x, pad + lineH * (i + 0.5)));
    const image = ctx.getImageData(0, 0, width, height);
    return { data: image.data, width, height };
  }

  /**
   * Project switch: drop everything decoded (frames, textures, PCM, decoder cursors) for assets not in `keep`.
   * The assets themselves stay in memory as blobs and in IndexedDB.
   */
  releaseDecodedExcept(keep: ReadonlySet<string>): void {
    this.live.closeAll();
    for (const id of this.infos.keys()) {
      if (keep.has(id)) continue;
      this.frames.dropGroups(`${id}|`);
      this.readers.get(id)?.dispose();
      this.readers.delete(id);
      this.dropElements(id);
      this.audio.delete(id);
      this.audioBytes.delete(id);
    }
  }

  /** Decoded frames (GPU) plus decoded PCM, in bytes. */
  decodedBytes(): number {
    let pcm = 0;
    for (const n of this.audioBytes.values()) pcm += n;
    return this.frames.bytes + pcm;
  }

  /** Drop every decoded frame (they are decoded again on demand). */
  dropFrames(): void {
    this.frames.clear();
  }

  /**
   * After a device loss every texture handle here is invalid: forget them without releasing, and drop the live sources.
   * Call after `Gpu.replaceDevice`.
   */
  onDeviceReset(): void {
    this.frames.clear();
    this.live.closeAll();
    this.pending.clear();
  }

  /** Set the byte budget of the decoded-frame store (evicts down to it); returns the previous one. */
  setFrameBudget(bytes: number): number {
    const prev = this.frameBudget;
    this.frameBudget = bytes;
    this.frames.maxBytes = bytes;
    return prev;
  }

  /** Release decoders and textures (page teardown). */
  dispose(): void {
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
    for (const id of [...this.pools.keys()]) this.dropElements(id);
    this.frames.clear();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* helpers                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

async function pickVideoTrack(input: Input): Promise<InputVideoTrack | null> {
  try {
    const decodable = await input.getPrimaryVideoTrack({ filter: (t) => t.canDecode().catch(() => false) });
    if (decodable) return decodable;
  } catch {
    /* fall through */
  }
  return input.getPrimaryVideoTrack().catch(() => null);
}

async function firstPositive(fns: (() => Promise<number | null>)[]): Promise<number> {
  for (const fn of fns) {
    try {
      const v = await fn();
      if (v !== null && Number.isFinite(v) && v > 0) return v;
    } catch {
      /* try the next strategy */
    }
  }
  return 0;
}

function audioBufferToPcm(buf: AudioBuffer): PcmAudio {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(new Float32Array(buf.getChannelData(c)));
  return { sampleRate: buf.sampleRate, channels };
}

/** Decode the primary audio track with mediabunny (used for video sound tracks). */
async function decodeTrackPcm(blob: Blob): Promise<PcmAudio | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const sink = new AudioBufferSink(track);
    const parts: { buffer: AudioBuffer; timestamp: number }[] = [];
    for await (const wrapped of sink.buffers(0, MAX_AUDIO_SECONDS)) parts.push(wrapped);
    if (parts.length && parts[parts.length - 1].timestamp + parts[parts.length - 1].buffer.duration >= MAX_AUDIO_SECONDS - 1) {
      console.warn(`The sound track is longer than ${MAX_AUDIO_SECONDS / 60} minutes: only the first part is used.`);
    }
    if (parts.length === 0) return null;
    const rate = parts[0].buffer.sampleRate;
    const nch = Math.min(2, Math.max(1, parts[0].buffer.numberOfChannels));
    const last = parts[parts.length - 1];
    const length = Math.ceil((last.timestamp + last.buffer.duration) * rate) + 1;
    const channels = Array.from({ length: nch }, () => new Float32Array(length));
    for (const { buffer, timestamp } of parts) {
      const at = Math.max(0, Math.round(timestamp * rate));
      for (let c = 0; c < nch; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        channels[c].set(src.subarray(0, Math.max(0, Math.min(src.length, length - at))), at);
      }
    }
    return { sampleRate: rate, channels };
  } finally {
    input.dispose();
  }
}
