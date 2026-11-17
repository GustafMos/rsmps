/**
 * The app's own encoders (src/io/encoders) as the exporter and the CLI use them: one place that knows which pixels a format wants, how the
 * Output node's options map to encoder options, how float formats are converted from the engine's working encoding, and how big a result
 * will be. No GPU, no DOM: the callers (src/io/exporter.ts in the browser, src/cli/render.ts in Node) do the rendering and the reading back.
 *
 * Pixel rules (the same everywhere):
 *  - formats with alpha (HAP Alpha, PNG MOV, Uncompressed MOV, GIF, APNG, QOI, TGA, TIFF, ICO) get STRAIGHT alpha RGBA8;
 *  - formats without alpha (HAP, HAP Q, Motion JPEG, BMP, PPM, HDR) get the picture composited over black: premultiplied colors, alpha 255.
 *    (A half transparent pixel therefore darkens; it never turns bright. HAP / HAP Q on the GPU keep the premultiplied colors, HAP Alpha
 *    un-premultiplies, exactly like `Gpu.read(img, straight)`.)
 *  - OpenEXR / Radiance HDR are written LINEAR: the engine works in display (sRGB) encoding, so the sRGB curve is removed first.
 *    16-bit TIFF keeps the display encoding (clipped to 0..1).
 */
import { tfDecode } from '../engine/lib/color-math';
import type { PcmAudio } from '../engine/audio/api';
import { encodeFlac, encodeTiff, floatToHalf, getEncoder, halfToFloat, beginGif, beginApng, beginHap, beginMjpegMov, beginPngMov, beginRawMov, encodeAiff, type ByteSink, type EncodeSession, type JpegEncoder } from './encoders';
import { dxtFrameBytes, type DxtFormat } from './encoders/dxt';
import { type CodecRow } from './export-codecs';
import { encodeWav } from './wav';

/* ------------------------------------------------------------------ video / animated ------------------------------------------------------------------ */

export interface OwnVideoConfig {
  row: CodecRow;
  width: number;
  height: number;
  fps: number;
  /** Frames that will be added (lets a non-seekable sink work for fixed-size frames). */
  frames: number;
  /** HAP: 'fast' = GPU compression (or the CPU without refinement), 'better' = CPU least-squares refinement (slow). */
  hapQuality?: 'fast' | 'better';
  /** HAP: second-stage Snappy compression ("Smaller files"). */
  hapSnappy?: boolean;
  gif?: { palette?: 'local' | 'global'; dither?: 'none' | 'ordered' | 'floyd'; colors?: number; loop?: number };
  /** Motion JPEG quality 0..1. */
  quality?: number;
  /** Motion JPEG: the JPEG encoder (the browser's canvas by default; sharp in Node). */
  jpeg?: JpegEncoder;
  /** PCM track in a MOV (16-bit). */
  audio?: { sampleRate: number; channels: number } | null;
  sink?: ByteSink;
}

const HAP_FORMAT: Record<string, DxtFormat> = { hap: 'Hap1', 'hap-alpha': 'Hap5', 'hap-q': 'HapY' };

export function hapFormatOf(row: CodecRow): DxtFormat | null {
  return (row.own && HAP_FORMAT[row.own]) || null;
}

/** How the frame's pixels reach the encoder. */
export type FrameMode = 'hap-gpu' | 'straight' | 'over-black';

/** `gpuHap`: the GPU compressor can be used (the caller has a WebGPU device). */
export function frameModeOf(row: CodecRow, o: { hapQuality?: 'fast' | 'better' }, gpuHap: boolean): FrameMode {
  if (hapFormatOf(row) && gpuHap && o.hapQuality !== 'better') return 'hap-gpu';
  return row.alpha ? 'straight' : 'over-black';
}

export function beginOwnVideo(c: OwnVideoConfig): EncodeSession {
  const { row, width, height, fps, sink } = c;
  if (row.route !== 'own' || !row.own) throw new Error(`${row.label} is not written by the app itself.`);
  const audio = c.audio ? { sampleRate: c.audio.sampleRate, channels: Math.min(2, Math.max(1, c.audio.channels)), bits: 16 as const } : undefined;
  const base = { width, height, fps };
  const hap = hapFormatOf(row);
  if (hap) return beginHap({ ...base, format: hap, snappy: c.hapSnappy !== false, refine: c.hapQuality === 'better' ? 2 : 0, audio, sink, frames: c.frames });
  switch (row.own) {
    case 'mov-mjpeg':
      return beginMjpegMov({ ...base, quality: c.quality ?? 0.92, jpeg: c.jpeg, audio, sink });
    case 'mov-png':
      return beginPngMov({ ...base, audio, sink });
    case 'mov-raw':
      return beginRawMov({ ...base, audio, sink, declaredPayload: sink && !sink.seekable && !audio ? c.frames * width * height * 4 : undefined });
    case 'gif':
      return beginGif({ ...base, colors: c.gif?.colors ?? 256, dither: c.gif?.dither ?? 'ordered', palette: c.gif?.palette ?? 'local', loop: c.gif?.loop ?? 0 });
    case 'apng':
      return beginApng({ ...base, loop: c.gif?.loop ?? 0 });
  }
  throw new Error(`${row.label}: no encoder named "${row.own}".`);
}

/** Rows whose file is a MOV the muxer can stream to a sink. */
export function streamsToSink(row: CodecRow): boolean {
  return row.route === 'own' && row.kind === 'video';
}

/** Upper-ish estimate of the finished file, bytes. Used for the pre-flight check; the real size is reported afterwards. */
export function estimateBytes(row: CodecRow, o: { width: number; height: number; frames: number; hapSnappy?: boolean }): number {
  const px = o.width * o.height;
  const hap = hapFormatOf(row);
  if (hap) return Math.round((dxtFrameBytes(o.width, o.height, hap) + 8) * o.frames * (o.hapSnappy !== false ? 0.65 : 1));
  switch (row.own) {
    case 'mov-raw':
      return px * 4 * o.frames;
    case 'mov-png':
      return Math.round(px * 4 * 0.5 * o.frames);
    case 'mov-mjpeg':
      return Math.round(px * 0.5 * o.frames);
    default:
      return Math.round(px * 0.3 * o.frames); // GIF, APNG: very content dependent
  }
}

/** The limit above which an in-memory result is refused (bytes). */
export const MEMORY_LIMIT = 1.5e9;

export function tooBigMessage(bytes: number): string {
  return `This export would need ${(bytes / 1e9).toFixed(1)} GB of memory in the browser. Use a smaller size, HAP "Smaller files", the desktop app, or an image sequence.`;
}

/* ------------------------------------------------------------------ stills ------------------------------------------------------------------ */

/** Linear light from a half-float display-encoded channel, cached for every possible half value. */
let linLut: Float32Array | null = null;
function lin(h: number): number {
  if (!linLut) {
    linLut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      const v = halfToFloat(i);
      linLut[i] = Number.isFinite(v) ? (v < 0 ? -tfDecode('srgb', -v) : tfDecode('srgb', v)) : 0;
    }
  }
  return linLut[h];
}

/**
 * Engine half-float pixels (premultiplied, display encoded, from `Gpu.readFloat`) to scene-linear floats.
 * `keepAlpha`: straight color is linearised and premultiplied again (OpenEXR convention). Without alpha the picture is composited over
 * black first, in the encoding it is shown in, then linearised (Radiance HDR).
 */
export function engineHalfToLinear(half: Uint16Array, keepAlpha: boolean): Float32Array {
  const n = half.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 4) {
    const a = Math.min(1, Math.max(0, halfToFloat(half[i + 3])));
    if (!keepAlpha || a >= 1) {
      out[i] = lin(half[i]);
      out[i + 1] = lin(half[i + 1]);
      out[i + 2] = lin(half[i + 2]);
      out[i + 3] = keepAlpha ? a : 1;
    } else if (a > 0) {
      for (let k = 0; k < 3; k++) {
        const p = halfToFloat(half[i + k]) / a; // straight, display encoded
        out[i + k] = (p < 0 ? -tfDecode('srgb', -p) : tfDecode('srgb', p)) * a;
      }
      out[i + 3] = a;
    }
  }
  return out;
}

/** Engine half-float pixels to straight 16-bit RGBA (display encoded, clipped to 0..1) for TIFF. */
export function engineHalfToStraight16(half: Uint16Array): Uint16Array {
  const n = half.length;
  const out = new Uint16Array(n);
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 65535);
  for (let i = 0; i < n; i += 4) {
    const a = Math.min(1, Math.max(0, halfToFloat(half[i + 3])));
    if (a > 0) {
      out[i] = q(halfToFloat(half[i]) / a);
      out[i + 1] = q(halfToFloat(half[i + 1]) / a);
      out[i + 2] = q(halfToFloat(half[i + 2]) / a);
    }
    out[i + 3] = q(a);
  }
  return out;
}

/** What a still row needs from the renderer. */
export function stillInput(row: CodecRow): 'rgba8' | 'half' {
  return row.float ? 'half' : 'rgba8';
}

export interface StillOptions {
  /** ICO sizes, default [16, 32, 48, 64, 128, 256] limited by the picture. */
  icoSizes?: number[];
  /** Downscaling method for ICO sizes. Default 'nearest' (pixel art stays hard). */
  icoScale?: 'nearest' | 'box';
}

const joinParts = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * One still file from an own encoder. `rgba` for 8-bit rows (straight alpha), `half` (from `Gpu.readFloat`) for float rows.
 * Opaque rows (BMP, PPM) composite straight alpha over black themselves.
 */
export async function encodeStillOwn(row: CodecRow, px: { rgba?: Uint8Array | Uint8ClampedArray; half?: Uint16Array }, width: number, height: number, o: StillOptions = {}): Promise<Uint8Array> {
  if (row.route !== 'own' || !row.own) throw new Error(`${row.label} is not written by the app itself.`);
  if (row.float) {
    if (!px.half) throw new Error(`${row.label} needs float pixels.`);
    if (row.own === 'tiff16') return encodeTiff(engineHalfToStraight16(px.half), width, height, { compression: 'deflate' });
    const f = engineHalfToLinear(px.half, row.alpha);
    const enc = getEncoder(row.own)!;
    const s = enc.begin({ width, height });
    await s.addFrame(f as unknown as Uint8Array);
    return joinParts(await s.finish());
  }
  if (!px.rgba) throw new Error(`${row.label} needs RGBA pixels.`);
  const enc = getEncoder(row.own);
  if (!enc) throw new Error(`${row.label}: no encoder named "${row.own}".`);
  // `alpha`: BMP writes 24-bit over black when the row has no alpha; the others ignore it
  const s = enc.begin({ width, height, sizes: o.icoSizes, scale: o.icoScale, alpha: row.alpha });
  await s.addFrame(px.rgba);
  return joinParts(await s.finish());
}

export { floatToHalf };

/* ------------------------------------------------------------------ audio ------------------------------------------------------------------ */

const AUDIO_BITS: Record<string, 16 | 24 | 32> = { wav: 16, wav24: 24, wav32f: 32, aiff: 16, aiff24: 24, flac: 16, flac24: 24 };

/** A sound file from an own encoder (blob parts). */
export function encodeAudioOwn(row: CodecRow, pcm: PcmAudio): Uint8Array[] {
  const bits = AUDIO_BITS[row.id];
  if (row.route !== 'own' || !bits) throw new Error(`${row.label} is not written by the app itself.`);
  switch (row.own) {
    case 'wav':
      return [encodeWav(pcm, bits)];
    case 'aiff':
      return [encodeAiff(pcm, bits as 16 | 24)];
    case 'flac':
      return encodeFlac(pcm.channels, { sampleRate: pcm.sampleRate, bits: bits as 16 | 24 });
  }
  throw new Error(`${row.label}: no encoder.`);
}
