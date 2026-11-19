/**
 * Reading HAP video frames (Vidvox HAP, a QuickTime codec for playing many clips at once).
 *
 * A HAP frame is not a picture that has to be decoded like H.264: it is a texture in the compressed form graphics cards
 * read directly (S3TC / "BC" blocks of 4x4 pixels), optionally squeezed once more with Snappy. So "decoding" is only:
 * unwrap the frame (this file), hand the blocks to the graphics card (hap-video.ts), done. Every frame stands alone, which
 * is why scrubbing, looping and playing backwards cost the same as playing forwards.
 *
 * This file is pure (no DOM, no GPU): the frame container, and a plain CPU decoder of the blocks to RGBA for devices whose
 * graphics chip cannot read BC textures (most phones), for thumbnails and for tests.
 *
 * Frame layout, from the public HAP specification and checked against files written by FFmpeg (hap.test.ts):
 *   section header = 3 bytes size (little-endian) + 1 byte type; when the size is 0, four more bytes hold the real size.
 *   type of a texture section: high half = how it is packed (0xA plain, 0xB Snappy, 0xC several chunks),
 *                              low half  = the texture format (0xB DXT1, 0xE DXT5, 0xF YCoCg in DXT5, 0xC BC7, 0x1 one channel).
 *   a chunked section starts with a "decode instructions" section (type 0x01) holding tables: how each chunk is packed
 *   (0x02, one byte each: 0x0A plain, 0x0B Snappy), the size of each chunk (0x03) and optionally where each starts (0x04).
 *   type 0x0D at the top = several textures in one frame (HAP Q Alpha: the colour, then the alpha).
 * The writing side lives in encoders/hap.ts; the Snappy code is shared with it.
 */
import { snappyDecodeInto, snappyLength } from './encoders/snappy';

/**
 * What the blocks of a frame are: `bc1` (HAP), `bc3` (HAP Alpha), `ycocg-bc3` (HAP Q: brightness in the alpha channel, colour
 * difference in red and green, to be converted to RGB), `bc4` (one channel: the alpha of HAP Q Alpha, or HAP Alpha-Only),
 * `bc7` (HAP R; the graphics card can read it, the CPU decoder here cannot).
 */
export type HapFormat = 'bc1' | 'bc3' | 'ycocg-bc3' | 'bc4' | 'bc7';

export interface HapFrame {
  format: HapFormat;
  /** The compressed blocks, rows of blocks from the top of the picture down. May be a view into the frame that was passed in. */
  data: Uint8Array;
  /** HAP Q Alpha only: the alpha channel as a second texture of `bc4` blocks. */
  alpha?: Uint8Array;
}

/** Sample entry names (fourcc) of the HAP family in a QuickTime file, with the name shown to the user. */
export const HAP_NAMES: Record<string, string> = {
  Hap1: 'HAP',
  Hap5: 'HAP Alpha',
  HapY: 'HAP Q',
  HapM: 'HAP Q Alpha',
  HapA: 'HAP Alpha-Only',
  Hap7: 'HAP R',
};

/** The display name of a HAP sample entry ("Hap1" gives "HAP"), or null when the codec is not HAP. */
export function hapName(fourcc: unknown): string | null {
  return typeof fourcc === 'string' && Object.hasOwn(HAP_NAMES, fourcc) ? HAP_NAMES[fourcc] : null;
}

const FORMAT_OF: Record<number, HapFormat> = { 0x0b: 'bc1', 0x0e: 'bc3', 0x0f: 'ycocg-bc3', 0x01: 'bc4', 0x0c: 'bc7' };

/** Bytes of one 4x4 block. */
export function hapBlockBytes(format: HapFormat): number {
  return format === 'bc1' || format === 'bc4' ? 8 : 16;
}

/** Bytes of a whole texture: the picture is stored in blocks of 4x4, so both sides are rounded up to a multiple of 4. */
export function hapTextureBytes(format: HapFormat, width: number, height: number): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * hapBlockBytes(format);
}

interface Section {
  type: number;
  start: number;
  end: number;
}

const u24 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function section(b: Uint8Array, at: number, end: number): Section {
  if (at + 4 > end) throw new Error('HAP: the frame is cut short.');
  let size = u24(b, at);
  const type = b[at + 3];
  let start = at + 4;
  if (size === 0) {
    if (at + 8 > end) throw new Error('HAP: the frame is cut short.');
    size = u32(b, at + 4);
    start = at + 8;
  }
  if (start + size > end) throw new Error('HAP: the frame is cut short.');
  return { type, start, end: start + size };
}

/** One texture section, unpacked. */
function texture(b: Uint8Array, s: Section): { format: HapFormat; data: Uint8Array } {
  const format = FORMAT_OF[s.type & 0x0f];
  if (!format) throw new Error(`HAP: this kind of HAP (texture type 0x${(s.type & 0x0f).toString(16)}) is not supported.`);
  const packing = s.type >> 4;
  if (packing === 0x0a) return { format, data: b.subarray(s.start, s.end) };
  if (packing === 0x0b) {
    const src = b.subarray(s.start, s.end);
    const data = new Uint8Array(snappyLength(src));
    snappyDecodeInto(src, data, 0);
    return { format, data };
  }
  if (packing !== 0x0c) throw new Error(`HAP: unknown frame packing 0x${packing.toString(16)}.`);

  // Several chunks, written so that players with many processor cores can unpack them side by side.
  const instr = section(b, s.start, s.end);
  if (instr.type !== 0x01) throw new Error('HAP: a chunked frame without its chunk tables.');
  let packings: Section | null = null;
  let sizes: Section | null = null;
  let offsets: Section | null = null;
  for (let at = instr.start; at < instr.end; ) {
    const t = section(b, at, instr.end);
    if (t.type === 0x02) packings = t;
    else if (t.type === 0x03) sizes = t;
    else if (t.type === 0x04) offsets = t;
    at = t.end;
  }
  if (!packings || !sizes) throw new Error('HAP: a chunked frame without its chunk tables.');
  const count = packings.end - packings.start;
  if (count < 1 || sizes.end - sizes.start !== count * 4 || (offsets && offsets.end - offsets.start !== count * 4)) throw new Error('HAP: the chunk tables do not agree.');
  const chunks: { src: Uint8Array; snappy: boolean; bytes: number }[] = [];
  let total = 0;
  let running = instr.end;
  for (let i = 0; i < count; i++) {
    const size = u32(b, sizes.start + i * 4);
    const from = offsets ? instr.end + u32(b, offsets.start + i * 4) : running;
    if (from + size > s.end) throw new Error('HAP: the frame is cut short.');
    running = from + size;
    const kind = b[packings.start + i];
    if (kind !== 0x0a && kind !== 0x0b) throw new Error(`HAP: unknown chunk packing 0x${kind.toString(16)}.`);
    const src = b.subarray(from, from + size);
    const bytes = kind === 0x0b ? snappyLength(src) : size;
    chunks.push({ src, snappy: kind === 0x0b, bytes });
    total += bytes;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    if (c.snappy) snappyDecodeInto(c.src, data, o);
    else data.set(c.src, o);
    o += c.bytes;
  }
  return { format, data };
}

/**
 * Unwrap one HAP frame (one sample of the video track) into its compressed blocks. With `size` given, a frame whose
 * blocks do not cover the picture is refused here instead of showing garbage later. Throws a readable Error for damaged
 * frames and for kinds of HAP this app does not read.
 */
export function parseHapFrame(frame: Uint8Array, size?: { width: number; height: number }): HapFrame {
  const top = section(frame, 0, frame.length);
  let out: HapFrame;
  if (top.type === 0x0d) {
    // Several textures: the picture first, a one-channel alpha after it (HAP Q Alpha). The order is not promised, so sort by format.
    const parts: { format: HapFormat; data: Uint8Array }[] = [];
    for (let at = top.start; at < top.end; ) {
      const s = section(frame, at, top.end);
      parts.push(texture(frame, s));
      at = s.end;
    }
    const colour = parts.find((p) => p.format !== 'bc4') ?? parts[0];
    if (!colour) throw new Error('HAP: an empty frame.');
    const alpha = parts.find((p) => p !== colour && p.format === 'bc4');
    out = { ...colour, ...(alpha ? { alpha: alpha.data } : {}) };
  } else out = texture(frame, top);
  if (size) {
    if (out.data.length < hapTextureBytes(out.format, size.width, size.height)) throw new Error('HAP: the frame is smaller than the picture it should hold.');
    if (out.alpha && out.alpha.length < hapTextureBytes('bc4', size.width, size.height)) throw new Error('HAP: the frame is smaller than the picture it should hold.');
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* CPU decoding of the blocks                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** The 8 values of a one-channel block (the alpha of DXT5, and BC4): two stored ends and the steps between them. */
function ramp(d: Uint8Array, o: number, out: Uint8Array): void {
  const a0 = d[o];
  const a1 = d[o + 1];
  out[0] = a0;
  out[1] = a1;
  if (a0 > a1) for (let k = 2; k < 8; k++) out[k] = ((8 - k) * a0 + (k - 1) * a1) / 7;
  else {
    for (let k = 2; k < 6; k++) out[k] = ((6 - k) * a0 + (k - 1) * a1) / 5;
    out[6] = 0;
    out[7] = 255;
  }
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Decode a HAP frame to RGBA bytes of the real picture size, top row first. Straight alpha, or premultiplied with
 * `premultiply` (what the engine's textures hold). HAP and HAP Q are opaque. Slower than letting the graphics card read the
 * blocks, but it works everywhere. HAP R (BC7) is refused: only a graphics card can read it.
 */
export function hapToRgba(frame: HapFrame, width: number, height: number, opts: { premultiply?: boolean } = {}): Uint8Array {
  const { format, data } = frame;
  if (format === 'bc7') throw new Error('HAP R (BC7) can only be played on a graphics card that reads BC textures.');
  if (data.length < hapTextureBytes(format, width, height)) throw new Error('HAP: the frame is smaller than the picture it should hold.');
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  const size = hapBlockBytes(format);
  const out = new Uint8Array(width * height * 4);
  const colour = format !== 'bc4';
  const ownAlpha = format === 'bc3' || format === 'ycocg-bc3' || format === 'bc4'; // the block starts with a one-channel part
  const ycocg = format === 'ycocg-bc3';
  const extra = frame.alpha && frame.alpha.length >= hapTextureBytes('bc4', width, height) ? frame.alpha : null;
  const pal = new Uint8Array(12); // 4 colours, r g b
  const one = new Uint8Array(8); // the channel stored in the block itself
  const two = new Uint8Array(8); // the separate alpha texture of HAP Q Alpha
  let black3 = false;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const block = by * bw + bx;
      const o = block * size;
      let lo = 0;
      let hi = 0;
      if (ownAlpha) {
        ramp(data, o, one);
        lo = u24(data, o + 2);
        hi = u24(data, o + 5);
      }
      let lo2 = 0;
      let hi2 = 0;
      if (extra) {
        ramp(extra, block * 8, two);
        lo2 = u24(extra, block * 8 + 2);
        hi2 = u24(extra, block * 8 + 5);
      }
      let idx = 0;
      if (colour) {
        const co = ownAlpha ? o + 8 : o;
        const c0 = data[co] | (data[co + 1] << 8);
        const c1 = data[co + 2] | (data[co + 3] << 8);
        // 5-6-5 bits widened to 8 by repeating the top bits, as graphics cards do
        pal[0] = ((c0 >> 11) << 3) | (c0 >> 13);
        pal[1] = (((c0 >> 5) & 63) << 2) | ((c0 >> 9) & 3);
        pal[2] = ((c0 & 31) << 3) | ((c0 & 31) >> 2);
        pal[3] = ((c1 >> 11) << 3) | (c1 >> 13);
        pal[4] = (((c1 >> 5) & 63) << 2) | ((c1 >> 9) & 3);
        pal[5] = ((c1 & 31) << 3) | ((c1 & 31) >> 2);
        // DXT1 alone has a second mode (first colour not larger than the second): one middle colour, and black
        black3 = format === 'bc1' && c0 <= c1;
        for (let c = 0; c < 3; c++) {
          if (black3) {
            pal[6 + c] = (pal[c] + pal[3 + c]) >> 1;
            pal[9 + c] = 0;
          } else {
            pal[6 + c] = (2 * pal[c] + pal[3 + c]) / 3;
            pal[9 + c] = (pal[c] + 2 * pal[3 + c]) / 3;
          }
        }
        idx = u32(data, co + 4);
      }
      const yEnd = Math.min(4, height - by * 4);
      const xEnd = Math.min(4, width - bx * 4);
      for (let y = 0; y < yEnd; y++) {
        let i = ((by * 4 + y) * width + bx * 4) * 4;
        for (let x = 0; x < xEnd; x++, i += 4) {
          const p = y * 4 + x;
          const k = ((idx >>> (p * 2)) & 3) * 3;
          const v = ownAlpha ? one[p < 8 ? (lo >> (p * 3)) & 7 : (hi >> ((p - 8) * 3)) & 7] : 255;
          let r: number;
          let g: number;
          let b: number;
          let a = 255;
          if (!colour) r = g = b = v; // a single channel is shown as grey
          else if (ycocg) {
            // red = orange-blue difference, green = green-purple difference, both stretched by the factor kept in blue; alpha = brightness
            const scale = pal[k + 2] / 8 + 1;
            const co = (pal[k] - 128) / scale;
            const cg = (pal[k + 1] - 128) / scale;
            r = clamp8(v + co - cg);
            g = clamp8(v + cg);
            b = clamp8(v - co - cg);
            if (extra) a = two[p < 8 ? (lo2 >> (p * 3)) & 7 : (hi2 >> ((p - 8) * 3)) & 7];
          } else {
            r = pal[k];
            g = pal[k + 1];
            b = pal[k + 2];
            if (format === 'bc3') a = v;
          }
          if (opts.premultiply && a < 255) {
            r = Math.round((r * a) / 255);
            g = Math.round((g * a) / 255);
            b = Math.round((b * a) / 255);
          }
          out[i] = r;
          out[i + 1] = g;
          out[i + 2] = b;
          out[i + 3] = a;
        }
      }
    }
  }
  return out;
}
