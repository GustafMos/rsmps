/** NodeHost: the engine's Host for headless runs. Images through sharp, video and audio through ffmpeg. */
import { statSync } from 'node:fs';
import sharp from 'sharp';
import type { Gpu } from '../engine/gpu/gpu';
import type { AssetInfo, Host, ImageValue } from '../engine/types';
import { probe, requireFfmpeg, runFfmpeg } from './ffmpeg';
import { assetName, kindByExtension, sequenceFiles } from './media';
import { VideoDecoder } from './video-decoder';

interface AssetRecord {
  info: AssetInfo;
  /** Image-sequence frame files (folder assets). */
  files?: string[];
}

interface CachedFrame {
  image: ImageValue;
  bytes: number;
  /** Video frame index (0 for stills). */
  index: number;
}

export interface NodeHostOptions {
  /** Frame rate given to image-sequence folders. */
  sequenceFps: number;
  /** Byte budget of the decoded-image cache (GPU memory). */
  imageBudget?: number;
}

export class NodeHost implements Host {
  private assets = new Map<string, AssetRecord>();
  private images = new Map<string, CachedFrame>();
  private imageBytes = 0;
  private decoders = new Map<string, VideoDecoder>();
  private videoFrames = new Map<string, CachedFrame>();
  private audio = new Map<string, Promise<{ sampleRate: number; channels: Float32Array[] } | null>>();
  private budget: number;
  private spawnsClosed = 0;

  /** Rasterising text needs a canvas, which does not exist headlessly: left undefined on purpose. */
  rasterizeText = undefined;

  constructor(
    private gpu: Gpu,
    private opts: NodeHostOptions,
  ) {
    this.budget = opts.imageBudget ?? 384 * 1024 * 1024;
  }

  /** ffmpeg decoder processes spawned in total (tests assert that sequential playback uses one). */
  get decoderSpawns(): number {
    let n = this.spawnsClosed;
    for (const d of this.decoders.values()) n += d.spawns;
    return n;
  }

  /** Probe an asset id (a file or an image-sequence folder) so that `assetInfo` can answer synchronously. */
  async register(id: string): Promise<AssetInfo> {
    const known = this.assets.get(id);
    if (known) return known.info;
    let st;
    try {
      st = statSync(id);
    } catch {
      throw new Error(`File not found: ${id}`);
    }
    const name = assetName(id);
    let rec: AssetRecord;
    if (st.isDirectory()) {
      const files = sequenceFiles(id);
      if (files.length === 0) throw new Error(`No image files in sequence folder: ${id}`);
      const meta = await sharp(files[0]).metadata();
      const rotated = (meta.orientation ?? 1) >= 5;
      const fps = this.opts.sequenceFps;
      rec = {
        files,
        info: {
          id,
          name,
          kind: 'video',
          width: (rotated ? meta.height : meta.width) ?? 0,
          height: (rotated ? meta.width : meta.height) ?? 0,
          duration: files.length / fps,
          fps,
          hasAudio: false,
        },
      };
    } else {
      let kind = kindByExtension(id);
      if (kind === 'image') {
        const meta = await sharp(id).metadata();
        const rotated = (meta.orientation ?? 1) >= 5;
        const w = meta.width ?? 0;
        const h = meta.height ?? 0;
        rec = { info: { id, name, kind, width: rotated ? h : w, height: rotated ? w : h, duration: 0, fps: 0, hasAudio: false } };
      } else if (kind === 'midi') {
        rec = { info: { id, name, kind, width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } };
      } else {
        const p = await probe(id);
        if (!kind) kind = p.hasVideo ? 'video' : p.hasAudio ? 'audio' : null;
        if (!kind) throw new Error(`Unsupported or unreadable media: ${id}`);
        if (kind === 'video' && !p.hasVideo) kind = 'audio';
        rec = { info: { id, name, kind, width: p.width, height: p.height, duration: p.duration, fps: kind === 'video' ? p.fps : 0, hasAudio: p.hasAudio } };
      }
    }
    this.assets.set(id, rec);
    return rec.info;
  }

  assetInfo(assetId: string): AssetInfo | null {
    return this.assets.get(assetId)?.info ?? this.processStore?.assetInfo(assetId) ?? null;
  }

  /** Process mode (`--process`): results of processes run in this run live in RAM; the host answers for them. */
  private processStore: { assetInfo(id: string): AssetInfo | null } | null = null;
  assetBytes?: (assetId: string) => Promise<ArrayBuffer | null>;
  attachProcessStore(store: { assetInfo(id: string): AssetInfo | null; assetBytes(id: string): Promise<ArrayBuffer | null> }): void {
    this.processStore = store;
    this.assetBytes = (id) => store.assetBytes(id);
  }

  private fit(info: AssetInfo, maxSide: number): { w: number; h: number } {
    const long = Math.max(info.width, info.height);
    if (maxSide > 0 && long > maxSide) {
      const s = maxSide / long;
      return { w: Math.max(1, Math.round(info.width * s)), h: Math.max(1, Math.round(info.height * s)) };
    }
    return { w: info.width, h: info.height };
  }

  async assetFrame(assetId: string, seconds: number, maxSide: number): Promise<{ texture: GPUTexture; width: number; height: number } | null> {
    const rec = this.assets.get(assetId);
    if (!rec) return null;
    const { info } = rec;
    if (info.kind === 'image') return this.imageFrame(assetId, rec, maxSide);
    if (info.kind !== 'video') return null;
    const { w, h } = this.fit(info, maxSide);
    const key = `${assetId}|${w}x${h}`;
    const index = Math.max(0, Math.round(seconds * info.fps));
    if (rec.files) return this.sequenceFrame(key, rec, index, w, h);
    let dec = this.decoders.get(key);
    if (!dec) {
      dec = new VideoDecoder(assetId, w, h, info.width, info.height, info.fps, Math.max(1, Math.round(info.duration * info.fps)));
      this.decoders.set(key, dec);
    }
    const frame = await dec.frame(index);
    if (!frame) return null;
    const cached = this.videoFrames.get(key);
    if (cached && cached.index === frame.index) return cached.image;
    const image = this.gpu.upload(frame.data, w, h, 1, true);
    this.gpu.retain(image.texture);
    if (cached) this.gpu.release(cached.image.texture);
    this.videoFrames.set(key, { image, bytes: w * h * 4, index: frame.index });
    return image;
  }

  private async sequenceFrame(key: string, rec: AssetRecord, index: number, w: number, h: number) {
    const files = rec.files!;
    const i = Math.min(files.length - 1, index);
    const cached = this.videoFrames.get(key);
    if (cached && cached.index === i) return cached.image;
    const data = await this.decodeFile(files[i], w, h);
    const image = this.gpu.upload(data.data, data.width, data.height, 1, true);
    this.gpu.retain(image.texture);
    if (cached) this.gpu.release(cached.image.texture);
    this.videoFrames.set(key, { image, bytes: data.width * data.height * 4, index: i });
    return image;
  }

  private async decodeFile(file: string, w: number, h: number): Promise<{ data: Buffer; width: number; height: number }> {
    let img = sharp(file, { failOn: 'none' }).rotate().ensureAlpha();
    const meta = await sharp(file).metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    const sw = rotated ? meta.height : meta.width;
    const sh = rotated ? meta.width : meta.height;
    if (w > 0 && h > 0 && (w !== sw || h !== sh)) img = img.resize(w, h, { fit: 'fill', kernel: 'lanczos3' });
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  private async imageFrame(assetId: string, rec: AssetRecord, maxSide: number) {
    const { w, h } = this.fit(rec.info, maxSide);
    const key = `${assetId}|${w}x${h}`;
    const hit = this.images.get(key);
    if (hit) {
      this.images.delete(key); // refresh LRU order
      this.images.set(key, hit);
      return hit.image;
    }
    const data = await this.decodeFile(assetId, w, h);
    const image = this.gpu.upload(data.data, data.width, data.height, 1, true);
    this.gpu.retain(image.texture);
    const bytes = data.width * data.height * 4;
    this.images.set(key, { image, bytes, index: 0 });
    this.imageBytes += bytes;
    for (const [k, v] of this.images) {
      if (this.imageBytes <= this.budget || k === key) break;
      this.images.delete(k);
      this.imageBytes -= v.bytes;
      this.gpu.release(v.image.texture);
    }
    return image;
  }

  /** Free cached stills (call after engine.clear() between batch items). */
  dropCaches(): void {
    for (const v of this.images.values()) this.gpu.release(v.image.texture);
    this.images.clear();
    this.imageBytes = 0;
  }

  /** Close the decoders and free the cached frames of one asset (when a batch item is done with it). */
  forget(assetId: string): void {
    for (const [k, dec] of this.decoders) {
      if (k.startsWith(`${assetId}|`)) {
        this.spawnsClosed += dec.spawns;
        dec.close();
        this.decoders.delete(k);
      }
    }
    for (const [k, v] of this.videoFrames) {
      if (k.startsWith(`${assetId}|`)) {
        this.gpu.release(v.image.texture);
        this.videoFrames.delete(k);
      }
    }
  }

  assetAudio(assetId: string): Promise<{ sampleRate: number; channels: Float32Array[] } | null> {
    let p = this.audio.get(assetId);
    if (!p) {
      p = this.decodeAudio(assetId);
      this.audio.set(assetId, p);
    }
    return p;
  }

  private async decodeAudio(assetId: string) {
    const info = this.assets.get(assetId)?.info;
    if (!info || (!info.hasAudio && info.kind !== 'audio')) return null;
    await requireFfmpeg('reading audio');
    const sampleRate = 48000;
    const { stdout } = await runFfmpeg(['-loglevel', 'error', '-i', assetId, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', String(sampleRate), 'pipe:1']);
    const total = Math.floor(stdout.length / 8);
    if (total === 0) return null;
    const view = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + total * 8));
    const l = new Float32Array(total);
    const r = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      l[i] = view[i * 2];
      r[i] = view[i * 2 + 1];
    }
    return { sampleRate, channels: [l, r] };
  }

  close(): void {
    for (const d of this.decoders.values()) d.close();
    this.decoders.clear();
  }
}
