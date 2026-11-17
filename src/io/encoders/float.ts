/**
 * Float picture writers: Radiance HDR (.hdr, RGBE with the new run-length scheme) and a minimal OpenEXR 2 writer (scanline, half
 * float RGBA, NONE or ZIP). Input is RGBA as Float32Array or as raw half floats in a Uint16Array (the engine's rgba16float layout).
 * Convention: colour is PREMULTIPLIED by alpha (what the engine holds and what OpenEXR expects). HDR has no alpha: the premultiplied
 * colour is the picture over black.
 *
 * Specs: Radiance picture format (Greg Ward, published with the Radiance source, BSD-style licence), OpenEXR file layout
 * (openexr.com technical introduction; the OpenEXR library is BSD-3-Clause, the file format is openly documented).
 */
import { zlibSync } from 'fflate';
import { ByteWriter, concat } from './util';

export type FloatPixels = Float32Array | Uint16Array;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 -> IEEE half bits, round to nearest even. */
export function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return h;
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 31;
  const m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function toFloat(px: FloatPixels, i: number): number {
  return px instanceof Uint16Array ? halfToFloat(px[i]) : px[i];
}

// ---------------------------------------------------------------- Radiance HDR

function rgbe(r: number, g: number, b: number, out: Uint8Array, o: number): void {
  const mx = Math.max(r, g, b);
  if (!(mx > 1e-32)) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  let e = Math.floor(Math.log2(mx)) + 1;
  if (mx / 2 ** e >= 1) e++;
  else if (mx / 2 ** e < 0.5) e--;
  const k = 256 / 2 ** e;
  out[o] = Math.min(255, Math.max(0, Math.floor(r * k)));
  out[o + 1] = Math.min(255, Math.max(0, Math.floor(g * k)));
  out[o + 2] = Math.min(255, Math.max(0, Math.floor(b * k)));
  out[o + 3] = e + 128;
}

export function encodeHdr(rgba: FloatPixels, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('HDR: the pixel data does not match the size.');
  const head = new TextEncoder().encode(`#?RADIANCE\n# RSMPS\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const rle = width >= 8 && width <= 32767;
  const row = new Uint8Array(width * 4);
  const planes = new Uint8Array(width * 4);
  const out = new ByteWriter(head.length + width * height * 4 + 1024);
  out.bytes(head);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgbe(toFloat(rgba, i), toFloat(rgba, i + 1), toFloat(rgba, i + 2), row, x * 4);
    }
    if (!rle) {
      out.bytes(row);
      continue;
    }
    out.u8(2).u8(2).u8(width >> 8).u8(width & 255);
    for (let c = 0; c < 4; c++) for (let x = 0; x < width; x++) planes[c * width + x] = row[x * 4 + c];
    for (let c = 0; c < 4; c++) {
      const p = planes.subarray(c * width, (c + 1) * width);
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 127 && p[x + run] === p[x]) run++;
        if (run >= 3) {
          out.u8(128 + run).u8(p[x]);
          x += run;
        } else {
          let n = 1;
          while (x + n < width && n < 128 && !(x + n + 2 < width && p[x + n] === p[x + n + 1] && p[x + n] === p[x + n + 2])) n++;
          out.u8(n);
          for (let k = 0; k < n; k++) out.u8(p[x + k]);
          x += n;
        }
      }
    }
  }
  return out.result();
}

// ---------------------------------------------------------------- OpenEXR

export interface ExrOptions {
  compression?: 'none' | 'zip';
}

function attr(w: ByteWriter, name: string, type: string, data: Uint8Array): void {
  w.ascii(name).u8(0).ascii(type).u8(0).u32(data.length, true).bytes(data);
}

export function encodeExr(rgba: FloatPixels, width: number, height: number, opts: ExrOptions = {}): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('EXR: the pixel data does not match the size.');
  const zip = (opts.compression ?? 'zip') === 'zip';
  const lines = zip ? 16 : 1;
  const w = new ByteWriter(512);
  w.u8(0x76).u8(0x2f).u8(0x31).u8(0x01).u32(2, true);
  const ch = new ByteWriter(100);
  for (const name of ['A', 'B', 'G', 'R']) ch.ascii(name).u8(0).u32(1, true).u8(0).zeros(3).u32(1, true).u32(1, true);
  ch.u8(0);
  attr(w, 'channels', 'chlist', ch.result());
  attr(w, 'compression', 'compression', new Uint8Array([zip ? 3 : 0]));
  const box = new ByteWriter(16).u32(0, true).u32(0, true).u32(width - 1, true).u32(height - 1, true).result();
  attr(w, 'dataWindow', 'box2i', box);
  attr(w, 'displayWindow', 'box2i', box);
  attr(w, 'lineOrder', 'lineOrder', new Uint8Array([0]));
  attr(w, 'pixelAspectRatio', 'float', new ByteWriter(4).f32(1, true).result());
  attr(w, 'screenWindowCenter', 'v2f', new ByteWriter(8).f32(0, true).f32(0, true).result());
  attr(w, 'screenWindowWidth', 'float', new ByteWriter(4).f32(1, true).result());
  w.u8(0);
  const header = w.result();
  const blocks: Uint8Array[] = [];
  const stride = width * 2;
  for (let y0 = 0; y0 < height; y0 += lines) {
    const n = Math.min(lines, height - y0);
    const raw = new Uint8Array(n * 4 * stride);
    const rv = new DataView(raw.buffer);
    for (let l = 0; l < n; l++) {
      for (let c = 0; c < 4; c++) {
        // channel order in the file: A, B, G, R; ours is R, G, B, A
        const src = 3 - c;
        const base = (l * 4 + c) * stride;
        for (let x = 0; x < width; x++) {
          const i = ((y0 + l) * width + x) * 4 + src;
          rv.setUint16(base + x * 2, rgba instanceof Uint16Array ? rgba[i] : floatToHalf(rgba[i]), true);
        }
      }
    }
    let data = raw;
    if (zip) {
      const t = new Uint8Array(raw.length);
      const half = (raw.length + 1) >> 1;
      for (let i = 0, a = 0, b = half; i < raw.length; i += 2) {
        t[a++] = raw[i];
        if (i + 1 < raw.length) t[b++] = raw[i + 1];
      }
      let prev = t[0];
      for (let i = 1; i < t.length; i++) {
        const cur = t[i];
        t[i] = (cur - prev + 128) & 255;
        prev = cur;
      }
      const z = zlibSync(t, { level: 6 });
      if (z.length < raw.length) data = z;
    }
    blocks.push(new ByteWriter(8 + 0).u32(y0, true).u32(data.length, true).result(), data);
  }
  const nBlocks = blocks.length / 2;
  const table = new ByteWriter(nBlocks * 8);
  let at = header.length + nBlocks * 8;
  for (let b = 0; b < nBlocks; b++) {
    table.u64(at, true);
    at += blocks[b * 2].length + blocks[b * 2 + 1].length;
  }
  return concat([header, table.result(), ...blocks]);
}
