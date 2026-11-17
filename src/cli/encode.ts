/** Encoders: stills and spritesheets through sharp, video through an ffmpeg process fed raw RGBA on stdin. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { requireFfmpeg } from './ffmpeg';
import { missingEncoderMessage, parseEncoderList } from '../io/ffmpeg-encoders';
import { CODEC_TABLE, STILL_ROWS, ffmpegArgsFor, minSizeMessage, rowById, stillRow, type CodecRow, type FormatRoute } from '../io/export-codecs';
import { encodeStillOwn } from '../io/own-export';

/** The value of a still row of the format registry: png, webp, jpeg, avif, qoi, tiff, tga, bmp, exr, hdr, tiff16, dpx, ico, ppm, jp2. */
export type ImageFormat = string;

export const IMAGE_FORMATS: readonly string[] = [...STILL_ROWS.flatMap((r) => [r.value, r.id, r.ext, ...(r.aliases ?? [])])];

export function normalizeImageFormat(f: string): ImageFormat | null {
  return stillRow(f)?.value ?? null;
}

export function imageExt(f: ImageFormat): string {
  return stillRow(f)?.ext ?? f;
}

/** Write straight-alpha (or, for JPEG, over-black) RGBA pixels as an image file. */
export async function writeStill(file: string, rgba: Uint8ClampedArray, width: number, height: number, format: ImageFormat, quality: number): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const row = stillRow(format);
  if (row?.route === 'own') {
    writeFileSync(file, await encodeStillOwn(row, { rgba }, width, height));
    return;
  }
  if (row?.route === 'ffmpeg') {
    const px = row.alpha ? rgba : new Uint8ClampedArray(rgba);
    if (!row.alpha) for (let i = 3; i < px.length; i += 4) px[i] = 255;
    await ffmpegStillFile(row.id, px, width, height, file);
    return;
  }
  let img = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } });
  if (format === 'png') img = img.png({ compressionLevel: 6 });
  else if (format === 'webp') img = img.webp({ quality: Math.round(quality * 100), alphaQuality: 100 });
  else if (format === 'avif') img = img.avif({ quality: Math.round(quality * 100) });
  else img = img.removeAlpha().jpeg({ quality: Math.round(quality * 100), mozjpeg: true });
  await img.toFile(file);
}

/** Write a float still (OpenEXR, Radiance HDR, 16-bit TIFF) from half-float pixels (`Gpu.readFloat`). */
export async function writeStillFloat(file: string, half: Uint16Array, width: number, height: number, format: ImageFormat): Promise<void> {
  const row = stillRow(format);
  if (!row?.float || row.route !== 'own') throw new Error(`"${format}" is not a float picture format.`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await encodeStillOwn(row, { half }, width, height));
}

/* ------------------------------------------------------------------------------------------------ */

export type VideoCodec = string;

export interface CodecSpec {
  id: VideoCodec;
  /** Who writes it in this CLI: 'own' = the app's encoder (no FFmpeg), 'ffmpeg' = FFmpeg (the browser-only encoders of the table also go there). */
  route: FormatRoute;
  row: CodecRow;
  ext: string;
  /** True when the codec stores an alpha channel (frames are fed with straight alpha). */
  alpha: boolean;
  /** Needs even width and height. */
  even: boolean;
  /** ffmpeg encoder args (without input, audio or file), from the table in src/io/export-codecs.ts. */
  args: (bitrateMbps: number) => string[];
  /** Audio args paired with the container; empty = the file carries no sound. */
  audio: string[];
  label: string;
  /** Any one of these FFmpeg encoders is enough (see `availableEncoders`). */
  encoders: readonly string[];
  /** Takes the bitrate setting (texture formats and ProRes do not). */
  usesBitrate: boolean;
  minSize?: readonly [number, number];
}

/** Every video / animated row of the codec table (src/io/export-codecs.ts), as the CLI and the desktop export know them. */
export const CODECS: Record<VideoCodec, CodecSpec> = Object.fromEntries(
  CODEC_TABLE.filter((r) => r.kind === 'video' || r.kind === 'animated').map((r) => [
    r.id,
    {
      id: r.id, route: r.route === 'own' ? ('own' as FormatRoute) : ('ffmpeg' as FormatRoute), row: r, ext: r.ext, alpha: r.alpha, even: r.even, label: r.label, encoders: r.encoders, usesBitrate: r.bitrate, minSize: r.minSize,
      args: (b: number) => r.args({ bitrateMbps: b, allKeys: false, encoders: null }),
      audio: [...(r.audio ?? [])],
    } satisfies CodecSpec,
  ]),
);

export function parseCodec(name: string): VideoCodec | null {
  const r = rowById(name);
  return r && (r.kind === 'video' || r.kind === 'animated') ? r.id : null;
}

export const CODEC_NAMES = Object.keys(CODECS).join(', ');

const encoderCache = new Map<string, Promise<Set<string>>>();

/** Encoder names of the FFmpeg in use (`ffmpeg -hide_banner -encoders`), asked once per binary. Never rejects: an unreadable answer is an empty set. */
export async function availableEncoders(): Promise<Set<string>> {
  const bin = await requireFfmpeg('video export');
  let p = encoderCache.get(bin);
  if (!p) {
    p = new Promise<Set<string>>((resolve) => {
      let out = '';
      const proc = spawn(bin, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('error', () => resolve(new Set()));
      proc.on('close', () => resolve(parseEncoderList(out)));
    });
    encoderCache.set(bin, p);
  }
  return p;
}

/** Throws a plain message when the installed FFmpeg lacks the encoder the codec needs. Formats the app writes itself need no FFmpeg. */
export async function requireEncoder(codec: CodecSpec): Promise<void> {
  if (codec.route === 'own') return;
  const have = await availableEncoders();
  if (have.size > 0 && !codec.encoders.some((e) => have.has(e))) throw new Error(missingEncoderMessage(codec.label, codec.encoders.join(' or ')));
}

export interface VideoWriterOptions {
  file: string;
  width: number;
  height: number;
  fps: number;
  codec: CodecSpec;
  bitrateMbps: number;
  /** Every frame a key frame (only for codecs that use a bitrate). */
  allKeys?: boolean;
  /** f32le stereo/mono PCM file to mux, with its layout. */
  audio?: { file: string; sampleRate: number; channels: number };
  onWarn?: (msg: string) => void;
}

/** One ffmpeg process fed raw RGBA frames with back-pressure. */
export class VideoWriter {
  private proc!: ChildProcess;
  private stderr = '';
  private exited: Promise<number | null>;
  private failed: Error | null = null;
  private draining: Promise<void> | null = null;
  private frames = 0;

  private constructor(private opts: VideoWriterOptions) {
    this.exited = Promise.resolve(null);
  }

  static async open(opts: VideoWriterOptions): Promise<VideoWriter> {
    const w = new VideoWriter(opts);
    await w.start();
    return w;
  }

  private async start(): Promise<void> {
    const { opts } = this;
    const bin = await requireFfmpeg('video export');
    await requireEncoder(opts.codec);
    const small = minSizeMessage(opts.codec.label, opts.codec.minSize, opts.width, opts.height);
    if (small) throw new Error(small);
    mkdirSync(dirname(opts.file), { recursive: true });
    const encoders = await availableEncoders();
    const args = ffmpegArgsFor(opts.codec.id, { width: opts.width, height: opts.height, fps: opts.fps, out: opts.file, bitrateMbps: opts.bitrateMbps, allKeys: opts.allKeys, audio: opts.audio && opts.codec.audio.length ? opts.audio : null, encoders: encoders.size ? encoders : null });
    const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    proc.stdin!.on('error', () => undefined); // surfaced through the exit code
    this.exited = new Promise((resolve) => {
      proc.on('error', (e) => {
        this.failed = e;
        resolve(-1);
      });
      proc.on('close', (code) => resolve(code));
    });
  }

  private err(code: number | null): Error {
    if (this.failed) return this.failed;
    const lines = this.stderr.trim().split('\n').filter(Boolean);
    return new Error(`ffmpeg (${this.opts.codec.label}) failed with exit code ${code}: ${lines.slice(-4).join(' | ')}`);
  }

  /** Write one frame of RGBA bytes; resolves once ffmpeg has accepted it (back-pressure). */
  async write(rgba: Uint8ClampedArray): Promise<void> {
    const stdin = this.proc.stdin!;
    if (stdin.destroyed || stdin.writableEnded) throw this.err(await this.exited);
    const ok = stdin.write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    this.frames++;
    if (!ok) {
      this.draining = new Promise<void>((resolve) => {
        const done = () => {
          stdin.off('drain', done);
          this.proc.off('close', done);
          resolve();
        };
        stdin.once('drain', done);
        this.proc.once('close', done);
      });
      await this.draining;
      this.draining = null;
      if (stdin.destroyed) throw this.err(await this.exited);
    }
  }

  async finish(): Promise<void> {
    this.proc.stdin!.end();
    const code = await this.exited;
    if (code !== 0) throw this.err(code);
  }

  /** Abort and delete the partial file. */
  async abort(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      /* gone */
    }
    await this.exited;
    try {
      rmSync(this.opts.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Interleave-free f32le dump of PCM (planar channels → interleaved) to a temp file for ffmpeg. */
export function writePcmFile(file: string, channels: Float32Array[]): void {
  const n = channels[0].length;
  const nch = channels.length;
  const out = new Float32Array(n * nch);
  for (let c = 0; c < nch; c++) {
    const src = channels[c];
    for (let i = 0; i < n; i++) out[i * nch + c] = src[i];
  }
  writeFileSync(file, Buffer.from(out.buffer));
}

/* ------------------------------------------------------------------------------------------------ */

function runOnce(bin: string, args: string[], input: Uint8Array | Uint8ClampedArray | null, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    proc.stdin?.on('error', () => undefined); // surfaced through the exit code
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (${what}) failed with exit code ${code}: ${err.trim().split('\n').filter(Boolean).slice(-3).join(' | ')}`))));
    if (input) proc.stdin!.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

/** One picture through FFmpeg (DPX, JPEG 2000 ...): straight RGBA in, the finished file at `out`. */
export async function ffmpegStillFile(rowId: string, rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, out: string): Promise<void> {
  const row = rowById(rowId);
  if (!row || row.kind !== 'still' || !row.encoders.length) throw new Error(`"${rowId}" is not an FFmpeg picture format.`);
  const bin = await requireFfmpeg('this picture format');
  const have = await availableEncoders();
  if (have.size > 0 && !row.encoders.some((e) => have.has(e))) throw new Error(missingEncoderMessage(row.label, row.encoders.join(' or ')));
  mkdirSync(dirname(out), { recursive: true });
  await runOnce(bin, ffmpegArgsFor(row.id, { width, height, fps: 1, out, frames: 1, encoders: have.size ? have : null }), rgba, row.label);
}

/** Sound through FFmpeg (MP3, Opus, Vorbis, ALAC, AAC ...): an f32le interleaved PCM file in, the finished file at `out`. */
export async function ffmpegSoundFile(rowId: string, pcmFile: string, sampleRate: number, channels: number, out: string): Promise<void> {
  const row = rowById(rowId);
  if (!row || row.kind !== 'audio') throw new Error(`"${rowId}" is not a sound format.`);
  const bin = await requireFfmpeg('this sound format');
  const have = await availableEncoders();
  if (have.size > 0 && !row.encoders.some((e) => have.has(e))) throw new Error(missingEncoderMessage(row.label, row.encoders.join(' or ')));
  mkdirSync(dirname(out), { recursive: true });
  await runOnce(bin, ffmpegArgsFor(row.id, { width: 0, height: 0, fps: 1, out, audio: { file: pcmFile, sampleRate, channels }, encoders: have.size ? have : null }), null, row.label);
}
