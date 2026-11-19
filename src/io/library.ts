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
import type { AssetProblem, FastCopyFormat, LibraryAsset, MediaLibrary } from './api';
import { mixToStereo } from './audio-util';
import { hapName, hapToRgba } from './hap';
import { HapPresenter, HapReader, type HapFramePlace } from './hap-video';
import { pcmLayoutOf, readIsoPcm } from './iso-pcm';
import { encodeWav } from './wav';
import { idbAll, idbDelete, idbGet, idbPut } from './db';
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

const MODEL_EXT = ['glb', 'gltf', 'obj'];
const LUT_EXT = ['cube'];
const SPLAT_EXT = ['ply', 'splat'];
const SUBTITLE_EXT = ['srt', 'vtt'];

/** First bytes of a file say whether it really is a 3D model of the kind its name claims. */
export function sniffModel(ext: string, head: Uint8Array): { ok: boolean; reason?: string } {
  const text = () => new TextDecoder().decode(head.subarray(0, 64)).trimStart();
  if (ext === 'glb') return head.length >= 12 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46 ? { ok: true } : { ok: false, reason: 'This .glb file does not start with the "glTF" marker: it is damaged or not a GLB.' };
  if (ext === 'gltf') return text().startsWith('{') ? { ok: true } : { ok: false, reason: 'This .gltf file is not JSON.' };
  return head.length > 0 ? { ok: true } : { ok: false, reason: 'This model file is empty.' };
}

/** A GLB renamed to something else is still recognised by its first four bytes. */
export function isGlbMagic(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46;
}

export function detectKind(file: { name: string; type: string }): Kind | null {
  const ext = extOf(file.name);
  const type = file.type.toLowerCase();
  if (LUT_EXT.includes(ext)) return 'lut';
  if (SPLAT_EXT.includes(ext)) return 'splat';
  if (SUBTITLE_EXT.includes(ext)) return 'subtitles';
  if (MODEL_EXT.includes(ext) || type === 'model/gltf-binary' || type === 'model/gltf+json' || type === 'model/obj') return 'model';
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
/** Placeholder thumbnail of a 3D model: a plain cube outline. */
const MODEL_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1e293b"/><g fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linejoin="round"><path d="M32 10 52 21v22L32 54 12 43V21z"/><path d="M12 21 32 32 52 21M32 32v22"/></g></svg>',
)}`;
/** Raw file bytes kept in memory for `assetBytes` (models and the like); older ones are read again when needed. */
const BYTES_CACHE_MAX = 192 * 1024 * 1024;
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
  /** HAP clips: served from their compressed textures, never through a video decoder (see hap-video.ts). */
  private hapReaders = new Map<string, HapReader>();
  /** Clips found to be HAP only when the video decoder refused them (imported before the app could read HAP). */
  private hapFound = new Set<string>();
  private hapPresenter: HapPresenter | null = null;
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

  async fastCopy(assetId: string, opts: { maxSide: number; format?: FastCopyFormat; onProgress?: (fraction: number) => void; onNote?: (text: string) => void; signal?: AbortSignal }): Promise<AssetInfo> {
    const info = this.infos.get(assetId);
    const blob = this.blobs.get(assetId);
    if (!info || !blob || info.kind !== 'video') throw new Error('Only a video clip can be converted.');
    let file: File;
    if (opts.format && opts.format !== 'h264') {
      // HAP is written by the desktop app's FFmpeg (the browser has no encoder for it)
      const { makeHapCopy } = await import('./hap-copy');
      file = await makeHapCopy(blob, info.name, info, { ...opts, format: opts.format });
    } else {
      const { makeFastCopy } = await import('./fast-copy');
      file = await makeFastCopy(blob, info.name, info, opts);
    }
    const [made] = await this.add([file]);
    if (!made) throw new Error('The fast copy could not be added to Media.');
    return made;
  }

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

  async attachSequence(owner: string, name: string, frames: Blob[], fps: number, meta?: Record<string, unknown>): Promise<AssetInfo> {
    if (frames.length === 0) throw new Error('An image sequence needs at least one frame.');
    const rate = Number.isFinite(fps) && fps > 0 ? fps : 12;
    const probe = await createImageBitmap(frames[0]).catch(() => null);
    if (!probe) throw new Error('The first frame of the sequence could not be decoded.');
    const { width, height } = probe;
    probe.close();
    // one hidden working sequence per owner AND paper layer (meta.layer, default 0)
    const wantLayer = typeof meta?.layer === 'number' ? meta.layer : 0;
    const existing = [...this.infos.values()].find((a) => (a as LibraryAsset).owner === owner && a.kind === 'video' && (((a as { layer?: number }).layer ?? 0) === wantLayer));
    const id = existing?.id ?? uniqueId('a');
    const info: LibraryAsset = { id, name, kind: 'video', width, height, duration: frames.length / rate, fps: rate, hasAudio: false, owner, hidden: true, ...(meta ?? {}) };
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
    // A NEW sequence cannot be in any cached result yet: only replacing frames under the same id must flush the engine (a finished
    // process then invalidates its own node and downstream through its cache key, not the whole cache).
    if (existing) this.onInvalidate?.();
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

  async addTexture(name: string, blob: Blob): Promise<AssetInfo> {
    const file = new File([blob], `${name.replace(/[\/:*?"<>|]+/g, '_') || 'texture'}.png`, { type: blob.type || 'image/png' });
    const [info] = await this.add([file]);
    if (!info) throw new Error('The texture could not be saved.');
    const tagged = { ...info, name, shelf: 'textures' } as AssetInfo & { shelf: string };
    this.infos.set(info.id, tagged);
    const record: AssetRecord = { id: info.id, added: Date.now(), info: tagged, blob: file };
    await idbPut('assets', info.id, record).catch((err) => console.warn(`The texture could not be saved for the next session: ${errorMessage(err)}`));
    this.notify();
    return tagged;
  }

  textures(): AssetInfo[] {
    return [...this.infos.values()].filter((a) => (a as { shelf?: string }).shelf === 'textures' && !(a as LibraryAsset).hidden);
  }

  async rename(assetId: string, name: string): Promise<void> {
    const info = this.infos.get(assetId);
    const clean = name.trim();
    if (!info || !clean || clean === info.name) return;
    const next = { ...info, name: clean };
    this.infos.set(assetId, next);
    try {
      const rec = await idbGet<AssetRecord>('assets', assetId);
      if (rec) await idbPut('assets', assetId, { ...rec, info: next });
    } catch (err) {
      console.warn(`The new name of "${clean}" could not be saved for the next session: ${errorMessage(err)}`);
    }
    this.notify();
  }

  assetMeta(assetId: string): { sequence: boolean; bytes: number; shelf?: string } {
    const frames = this.sequences.get(assetId);
    const bytes = frames ? frames.reduce((s, b) => s + b.size, 0) : (this.blobs.get(assetId)?.size ?? 0);
    const shelf = (this.infos.get(assetId) as { shelf?: string } | undefined)?.shelf;
    return { sequence: !!frames, bytes, ...(shelf ? { shelf } : {}) };
  }

  /**
   * Store opaque bytes (a process result: JSON, a typed array) as a hidden asset of `owner`. One asset per (owner, slot): a second call
   * REPLACES it under the same id. Read it back with `assetBytes`. Same persistence as `attachSequence` (one store for bakes and processes).
   */
  async attachBlob(owner: string, slot: string, name: string, blob: Blob, meta?: Record<string, unknown>): Promise<AssetInfo> {
    const existing = [...this.infos.values()].find((a) => (a as LibraryAsset).owner === owner && (a as { slot?: string }).slot === slot);
    const id = existing?.id ?? uniqueId('a');
    const info = { id, name, kind: 'model', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false, owner, hidden: true, slot, ...(meta ?? {}) } as LibraryAsset;
    this.bytes.delete(id);
    this.bytesSize.delete(id);
    this.infos.set(id, info);
    this.blobs.set(id, blob);
    const record: AssetRecord = { id, added: Date.now(), info, blob };
    idbPut('assets', id, record).catch((err) => console.warn(`"${name}" could not be saved for the next session: ${errorMessage(err)}`));
    // No engine flush: a process result's cache key carries its creation time, and the engine's parsed-JSON memo is keyed by it too.
    this.notify();
    return info;
  }

  /** Set by createIo: what the process scheduler is doing with a node (engine `Host.processLive`). */
  liveProcess: ((nodeId: string) => import('../engine/types').ProcessLive | null) | null = null;
  processLive(nodeId: string): import('../engine/types').ProcessLive | null {
    return this.liveProcess?.(nodeId) ?? null;
  }
  /** Set by createIo in the desktop app: Splat from Video's COLMAP + Brush pipeline (engine `Host.splatTrain`); undefined on the web. */
  splatTrain?: import('../engine/types').SplatTrainHost;

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
    this.dropHap(assetId);
    this.hapFound.delete(assetId);
    this.dropElements(assetId);
    this.problems.delete(assetId);
    this.audio.delete(assetId);
    this.bytes.delete(assetId);
    this.bytesSize.delete(assetId);
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
    let kind = detectKind(file);
    if (!kind) {
      // Unknown name: a GLB is still recognised by its magic bytes.
      if (isGlbMagic(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) kind = 'model';
      else throw new Error('Unsupported file type. Images, videos, audio, MIDI, 3D models (.glb, .gltf, .obj), LUTs (.cube), subtitles (.srt, .vtt) and Gaussian splats (.ply, .splat) can be imported.');
    }
    if (kind === 'lut' || kind === 'splat' || kind === 'subtitles') return { id: uniqueId('a'), name: file.name, kind, width: 0, height: 0, duration: 0, fps: 0, hasAudio: false };
    if (kind === 'model') {
      const verdict = sniffModel(extOf(file.name) || 'glb', new Uint8Array(await file.slice(0, 64).arrayBuffer()));
      if (!verdict.ok) throw new Error(verdict.reason);
      return { id: uniqueId('a'), name: file.name, kind, width: 0, height: 0, duration: 0, fps: 0, hasAudio: false };
    }
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
          // HAP is not a codec the demuxer knows by name: it is recognised by its sample entry ("Hap1", "HapY" ...) and played from its
          // compressed textures (hap-video.ts). The label is what later sends the clip down that path.
          codec = hapName(await vtrack.getInternalCodecId().catch(() => null)) ?? codecLabel(await vtrack.getCodec(), await vtrack.getCodecParameterString().catch(() => null));
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
  private decodeSequenceFrame(info: AssetInfo, stills: Blob[], size: { bucket: number; width: number; height: number }, group: string, t: number, ahead = true): Promise<Frame | null> {
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
    if (ahead) this.readAhead(info, stills, size, group, idx);
    return p;
  }

  /**
   * Playing a sequence (a baked region) decodes the next frames while the current one is used, like a video decoder does: two
   * frames ahead, wrapping at the end (baked clips loop). Skipped for exports (they ask in order anyway).
   */
  private readAhead(info: AssetInfo, stills: Blob[], size: { bucket: number; width: number; height: number }, group: string, idx: number): void {
    if (this.exact || stills.length < 3 || !(info as LibraryAsset).owner) return;
    for (let d = 1; d <= 2; d++) {
      const next = (idx + d) % stills.length;
      const t = next / info.fps;
      if (this.frames.find(group, t + 1e-6) || this.pending.has(`${group}#${next}`)) continue;
      void this.decodeSequenceFrame(info, stills, size, group, t + 1e-6, false).catch(() => undefined);
    }
  }

  private decodeVideoFrame(info: AssetInfo, size: { bucket: number; width: number; height: number }, group: string, t: number): Promise<Frame | null> {
    const blob = this.blobs.get(info.id);
    if (!blob) return Promise.resolve(null);
    if (this.isHap(info)) return this.hapFrame(info, size, group, t);
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
      .catch(async (err) => {
        // WebCodecs could not decode this video (phone HEVC, 10-bit...) and never produced a frame: use the browser's player.
        if (r.served > 0 || !this.infos.has(info.id)) throw err;
        r.dispose();
        if (this.readers.get(info.id) === r) this.readers.delete(info.id);
        // ...unless it turns out to be a HAP clip imported before the app could read HAP (its stored label does not say so)
        if (!this.elementAssets.has(info.id) && (await this.sniffHap(info))) return this.hapFrame(info, size, group, t);
        this.elementAssets.add(info.id);
        return this.elementFrame(info, size, group, t);
      });
  }

  /* ------------------------------ HAP: frames that are already textures ------------------------- */

  private isHap(info: AssetInfo): boolean {
    return this.hapFound.has(info.id) || /^HAP\b/.test((info as LibraryAsset).codec ?? '');
  }

  private hapReader(info: AssetInfo): HapReader | null {
    let reader = this.hapReaders.get(info.id);
    if (!reader) {
      const blob = this.blobs.get(info.id);
      if (!blob) return null;
      reader = new HapReader(blob);
      this.hapReaders.set(info.id, reader);
    }
    return reader;
  }

  private dropHap(assetId: string): void {
    this.hapReaders.get(assetId)?.dispose();
    this.hapReaders.delete(assetId);
  }

  /** Is this clip HAP after all? Asked only once the ordinary decoder has refused it. */
  private async sniffHap(info: AssetInfo): Promise<boolean> {
    if (this.isHap(info)) return true;
    const reader = this.hapReader(info);
    if (!reader) return false;
    try {
      await reader.init();
    } catch {
      this.dropHap(info.id);
      return false;
    }
    if (!this.infos.has(info.id)) return false;
    this.hapFound.add(info.id);
    return true;
  }

  /**
   * A frame of a HAP clip: find it in the file, read it, put it on a texture. No decoder state, so any frame costs the same
   * and requests for different frames run side by side; two requests for the same frame share one read.
   */
  private async hapFrame(info: AssetInfo, size: { bucket: number; width: number; height: number }, group: string, t: number): Promise<Frame | null> {
    const reader = this.hapReader(info);
    if (!reader) return null;
    const place: HapFramePlace | null = await reader.locate(t);
    if (!place || !this.infos.has(info.id)) return null;
    const hit = this.frames.find(group, t);
    if (hit) return hit;
    const key = `${group}#hap${place.packet.timestamp}`;
    let p = this.pending.get(key);
    if (!p) {
      p = (async () => {
        const data = await reader.read(place);
        if (!this.infos.has(info.id)) return null;
        const presenter = (this.hapPresenter ??= new HapPresenter(this.gpu));
        const texture = presenter.present(data, reader.width, reader.height, size.width, size.height);
        this.gpu.retain(texture);
        const frame: Frame = { texture, width: size.width, height: size.height };
        this.frames.put(group, place.start, place.end, this.bytesOf(frame), frame);
        return frame;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  /** Thumbnail of a HAP clip: one frame decoded on the CPU (small and rare, so not worth a trip through the GPU and back). */
  private async hapThumbnail(info: AssetInfo): Promise<Blob | null> {
    const reader = this.hapReader(info);
    if (!reader) return null;
    const place = await reader.locate(Math.min(1, info.duration * 0.1));
    if (!place) return null;
    const pixels = hapToRgba(await reader.read(place), reader.width, reader.height);
    const full = new OffscreenCanvas(reader.width, reader.height);
    full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length), reader.width, reader.height), 0, 0);
    const k = Math.min(1, THUMB_SIDE / Math.max(reader.width, reader.height));
    const w = Math.max(1, Math.round(reader.width * k));
    const h = Math.max(1, Math.round(reader.height * k));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(full, 0, 0, w, h);
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
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
    if (info.kind === 'model' || info.kind === 'lut' || info.kind === 'splat' || info.kind === 'subtitles') return MODEL_ICON; // a neutral placeholder: models are not rendered for thumbnails
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
      if (this.isHap(info)) {
        // never the browser's player for HAP: it cannot play it, and would mark the clip as unusable
        const made = await this.hapThumbnail(info).catch(() => null);
        return made ? URL.createObjectURL(made) : null;
      }
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
        if (!out && (await this.sniffHap(info))) out = await this.hapThumbnail(info).catch(() => null);
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
  liveFrame(source: LiveSource, maxSide: number, at?: number): Promise<Frame | null> {
    // asked for a time that is not the player's present: a time node (Retime's stop-motion) is holding that moment
    const now = this.liveNow?.();
    const hold = at !== undefined && now !== undefined ? { at, held: Math.abs(at - now) > 1e-6 } : undefined;
    return this.live.frame(source as LiveRequest, maxSide, hold);
  }
  /** The player's present, in project seconds. Set by createIo. */
  liveNow: (() => number) | null = null;

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
      this.dropHap(id);
      this.dropElements(id);
      this.bytes.delete(id);
      this.bytesSize.delete(id);
      this.audio.delete(id);
      this.audioBytes.delete(id);
    }
  }

  /** Decoded frames (GPU) plus decoded PCM, in bytes. */
  decodedBytes(): number {
    let pcm = 0;
    for (const n of this.bytesSize.values()) pcm += n;
    for (const n of this.audioBytes.values()) pcm += n;
    return this.frames.bytes + pcm;
  }

  /** CPU memory this library holds for decoded sound and cached file bytes (models), for the memory readout. */
  cpuBytes(): { audioPcmBytes: number; fileBytes: number } {
    let audio = 0;
    let files = 0;
    for (const n of this.audioBytes.values()) audio += n;
    for (const n of this.bytesSize.values()) files += n;
    return { audioPcmBytes: audio, fileBytes: files };
  }

  /** Drop every decoded frame and cached byte buffer (they are decoded / read again on demand). */
  dropFrames(): void {
    this.frames.clear();
    this.bytes.clear();
  }

  /* ----------------------------------- raw bytes ----------------------------------- */

  private bytes = new Map<string, Promise<ArrayBuffer | null>>();
  private bytesSize = new Map<string, number>();

  /**
   * The file's bytes (the first frame for an image sequence). The SAME ArrayBuffer instance is returned for the same asset until
   * the asset is removed or replaced, or the cache evicts it under pressure (a new instance after that): consumers may memoise
   * parsed data keyed by the buffer object.
   */
  assetBytes(assetId: string): Promise<ArrayBuffer | null> {
    const blob = this.blobs.get(assetId);
    if (!blob) return Promise.resolve(null);
    let p = this.bytes.get(assetId);
    if (!p) {
      p = blob.arrayBuffer().then(
        (buf) => {
          this.bytesSize.set(assetId, buf.byteLength);
          this.evictBytes(assetId);
          return buf;
        },
        () => {
          this.bytes.delete(assetId);
          return null;
        },
      );
      this.bytes.set(assetId, p);
    }
    return p;
  }

  private evictBytes(keep: string): void {
    let total = 0;
    for (const n of this.bytesSize.values()) total += n;
    for (const id of [...this.bytes.keys()]) {
      if (total <= BYTES_CACHE_MAX) break;
      if (id === keep) continue;
      total -= this.bytesSize.get(id) ?? 0;
      this.bytes.delete(id);
      this.bytesSize.delete(id);
    }
  }

  private imageGroups = new WeakMap<ArrayBuffer, string>();
  private imageGroupCounter = 0;

  /**
   * Decode PNG/JPEG/WebP bytes found inside a model file into a GPU texture (premultiplied). Cached per buffer object, inside
   * the decoded-frame store (so it counts toward the memory budget and is evicted under pressure).
   */
  async decodeImageBytes(bytes: ArrayBuffer, mime: string): Promise<Frame | null> {
    let group = this.imageGroups.get(bytes);
    if (!group) {
      group = `bytes:${++this.imageGroupCounter}:${mime}`;
      this.imageGroups.set(bytes, group);
    }
    const hit = this.frames.find(group, 0);
    if (hit) return hit;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { premultiplyAlpha: 'none' });
    } catch {
      return null;
    }
    const w = bmp.width;
    const h = bmp.height;
    const texture = this.takeTexture(w, h);
    try {
      await uploadExternal(this.gpu.device, bmp, texture, w, h);
    } catch {
      this.gpu.release(texture);
      return null;
    } finally {
      bmp.close();
    }
    const frame: Frame = { texture, width: w, height: h };
    this.frames.put(group, 0, Infinity, this.bytesOf(frame), frame);
    return frame;
  }

  /**
   * After a device loss every texture handle here is invalid: forget them without releasing. Live sources keep their
   * camera or stream open and upload into new textures. Call after `Gpu.replaceDevice`.
   */
  onDeviceReset(): void {
    this.frames.clear();
    this.live.onDeviceReset();
    this.hapPresenter?.reset();
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
    for (const id of [...this.hapReaders.keys()]) this.dropHap(id);
    this.hapPresenter?.dispose();
    this.hapPresenter = null;
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
  const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, () => new Float32Array(buf.length));
  mixToStereo(channels, 0, Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))); // 5.1 and the like are folded down
  return { sampleRate: buf.sampleRate, channels };
}

/** PCM sound of an MP4 / MOV track, read by iso-pcm.ts. Null for other codecs and containers (and fragmented files). */
async function decodeIsoPcm(blob: Blob, track: { codec: string | null; numberOfChannels: number; sampleRate: number; id: number }): Promise<PcmAudio | null> {
  if (!pcmLayoutOf(track.codec) || !(track.sampleRate > 0)) return null;
  const read = async (start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const pcm = await readIsoPcm(read, blob.size, { codec: track.codec, channels: track.numberOfChannels, trackId: track.id }, MAX_AUDIO_SECONDS * track.sampleRate);
  if (!pcm || pcm.channels[0].length === 0) return null;
  if (pcm.channels.length <= 2) return { sampleRate: track.sampleRate, channels: pcm.channels };
  const channels = [new Float32Array(pcm.channels[0].length), new Float32Array(pcm.channels[0].length)];
  mixToStereo(channels, 0, pcm.channels);
  return { sampleRate: track.sampleRate, channels };
}

/** Decode the primary audio track with mediabunny (used for video sound tracks). */
async function decodeTrackPcm(blob: Blob): Promise<PcmAudio | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    // Uncompressed sound in MP4 / MOV is read from the file's own tables: the demuxer misreads the layout phone apps write
    // (one entry per buffer), taking one sample out of each buffer, which is heard as ticking. See iso-pcm.ts.
    const own = await decodeIsoPcm(blob, track).catch(() => null);
    if (own) return own;
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
      // Packets are laid down by their own time stamps. More than two channels (5.1 ...) are folded down to stereo, centre included.
      const src = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      if (src.length <= 2) for (let c = 0; c < nch; c++) channels[c].set(src[Math.min(c, src.length - 1)].subarray(0, Math.max(0, Math.min(buffer.length, length - at))), at);
      else {
        for (let c = 0; c < nch; c++) channels[c].fill(0, at, Math.min(length, at + buffer.length)); // overlapping packets replace, like the plain copy
        mixToStereo(channels, at, src);
      }
    }
    return { sampleRate: rate, channels };
  } finally {
    input.dispose();
  }
}
