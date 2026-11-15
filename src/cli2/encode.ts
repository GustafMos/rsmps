/** Encoders: stills and spritesheets through sharp, video through an ffmpeg process fed raw RGBA on stdin. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { requireFfmpeg } from './ffmpeg';

export type ImageFormat = 'png' | 'webp' | 'jpeg';

export const IMAGE_FORMATS: readonly string[] = ['png', 'webp', 'jpeg', 'jpg'];

export function normalizeImageFormat(f: string): ImageFormat | null {
  const v = f.toLowerCase();
  if (v === 'jpg' || v === 'jpeg') return 'jpeg';
  if (v === 'png' || v === 'webp') return v;
  return null;
}

export function imageExt(f: ImageFormat): string {
  return f === 'jpeg' ? 'jpg' : f;
}

/** Write straight-alpha (or, for JPEG, over-black) RGBA pixels as an image file. */
export async function writeStill(file: string, rgba: Uint8ClampedArray, width: number, height: number, format: ImageFormat, quality: number): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  let img = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } });
  if (format === 'png') img = img.png({ compressionLevel: 6 });
  else if (format === 'webp') img = img.webp({ quality: Math.round(quality * 100), alphaQuality: 100 });
  else img = img.removeAlpha().jpeg({ quality: Math.round(quality * 100), mozjpeg: true });
  await img.toFile(file);
}

/* ------------------------------------------------------------------------------------------------ */

export type VideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores' | 'prores4444' | 'qtrle' | 'png' | 'webm-alpha';

export interface CodecSpec {
  id: VideoCodec;
  ext: 'mp4' | 'webm' | 'mov';
  /** True when the codec stores an alpha channel (frames are fed with straight alpha). */
  alpha: boolean;
  /** Needs even width and height. */
  even: boolean;
  /** ffmpeg input pixel format / encoder args (without bitrate). */
  args: (bitrateMbps: number) => string[];
  audio: string[];
  label: string;
}

const AAC = ['-c:a', 'aac', '-b:a', '192k'];
const PCM = ['-c:a', 'pcm_s16le'];

export const CODECS: Record<VideoCodec, CodecSpec> = {
  h264: {
    id: 'h264', ext: 'mp4', alpha: false, even: true, label: 'H.264',
    args: (b) => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', `${b}M`, '-movflags', '+faststart'],
    audio: AAC,
  },
  hevc: {
    id: 'hevc', ext: 'mp4', alpha: false, even: true, label: 'H.265',
    args: (b) => ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-b:v', `${b}M`, '-movflags', '+faststart'],
    audio: AAC,
  },
  vp9: {
    id: 'vp9', ext: 'webm', alpha: false, even: true, label: 'VP9',
    args: (b) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', `${b}M`],
    audio: ['-c:a', 'libopus', '-b:a', '160k'],
  },
  av1: {
    id: 'av1', ext: 'mp4', alpha: false, even: true, label: 'AV1',
    args: (b) => ['-c:v', 'libaom-av1', '-pix_fmt', 'yuv420p', '-b:v', `${b}M`, '-cpu-used', '6', '-strict', 'experimental', '-movflags', '+faststart'],
    audio: AAC,
  },
  prores: {
    id: 'prores', ext: 'mov', alpha: false, even: false, label: 'ProRes 422 HQ',
    args: () => ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'ap10'],
    audio: PCM,
  },
  prores4444: {
    id: 'prores4444', ext: 'mov', alpha: true, even: false, label: 'ProRes 4444 + alpha',
    args: () => ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'ap10'],
    audio: PCM,
  },
  qtrle: {
    id: 'qtrle', ext: 'mov', alpha: true, even: false, label: 'QuickTime Animation + alpha',
    args: () => ['-c:v', 'qtrle', '-pix_fmt', 'argb'],
    audio: PCM,
  },
  png: {
    id: 'png', ext: 'mov', alpha: true, even: false, label: 'PNG in MOV + alpha',
    args: () => ['-c:v', 'png', '-pix_fmt', 'rgba'],
    audio: PCM,
  },
  'webm-alpha': {
    id: 'webm-alpha', ext: 'webm', alpha: true, even: true, label: 'VP9 WebM + alpha',
    args: (b) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', `${b}M`],
    audio: ['-c:a', 'libopus', '-b:a', '160k'],
  },
};

const ALIASES: Record<string, VideoCodec> = {
  avc: 'h264', h264: 'h264', 'h.264': 'h264', x264: 'h264',
  hevc: 'hevc', h265: 'hevc', 'h.265': 'hevc', x265: 'hevc',
  vp9: 'vp9', av1: 'av1',
  prores: 'prores', prores422: 'prores', prores4444: 'prores4444', 'prores-4444': 'prores4444',
  qtrle: 'qtrle', animation: 'qtrle', png: 'png', 'mov-png': 'png', 'png-mov': 'png',
  'webm-alpha': 'webm-alpha', webmalpha: 'webm-alpha', 'vp9-alpha': 'webm-alpha',
};

export function parseCodec(name: string): VideoCodec | null {
  return ALIASES[name.toLowerCase()] ?? null;
}

export const CODEC_NAMES = Object.keys(CODECS).join(', ');

export interface VideoWriterOptions {
  file: string;
  width: number;
  height: number;
  fps: number;
  codec: CodecSpec;
  bitrateMbps: number;
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
    mkdirSync(dirname(opts.file), { recursive: true });
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.width}x${opts.height}`, '-r', String(opts.fps), '-i', 'pipe:0'];
    if (opts.audio) args.push('-f', 'f32le', '-ar', String(opts.audio.sampleRate), '-ac', String(opts.audio.channels), '-i', opts.audio.file);
    args.push('-map', '0:v');
    if (opts.audio) args.push('-map', '1:a');
    args.push('-r', String(opts.fps), ...opts.codec.args(opts.bitrateMbps));
    if (opts.audio) args.push(...opts.codec.audio, '-shortest');
    args.push(opts.file);
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
