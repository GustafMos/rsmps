/**
 * S3TC block compressors (BC1 / BC3) and the scaled YCoCg-DXT5 variant HAP uses, plus matching decoders for tests.
 *
 * Algorithm ("fast", refine = 0): per 4x4 block, bounding box in RGB inset by 1/16 of its range, diagonal chosen from the sign of the
 * covariance with blue (J.M.P. van Waveren, "Real-Time DXT Compression"), endpoints quantised to RGB565, indices by nearest palette
 * colour. All integer arithmetic so the WGSL port in hap-gpu.ts produces the same bytes. With refine > 0 the CPU then runs that many
 * least-squares endpoint refinements and keeps the lowest-error result (CPU only).
 * Alpha blocks: 8-value mode, endpoints = block max / min.
 * Written from the public format descriptions (OpenGL EXT_texture_compression_s3tc; the YCoCg-DXT5 paper cited by the HAP spec).
 * The S3TC patents have expired.
 */
import type { Pixels } from './util';

export type DxtFormat = 'Hap1' | 'Hap5' | 'HapY';

export function blockBytes(fmt: DxtFormat): number {
  return fmt === 'Hap1' ? 8 : 16;
}
/** Size in bytes of one compressed frame (dimensions rounded up to multiples of 4). */
export function dxtFrameBytes(width: number, height: number, fmt: DxtFormat): number {
  return (Math.ceil(width / 4) * Math.ceil(height / 4)) * blockBytes(fmt);
}

const q5 = (v: number) => Math.floor((v * 62 + 255) / 510);
const q6 = (v: number) => Math.floor((v * 126 + 255) / 510);
const e5 = (v: number) => (v << 3) | (v >> 2);
const e6 = (v: number) => (v << 2) | (v >> 4);

const R = new Int32Array(16);
const G = new Int32Array(16);
const B = new Int32Array(16);
const A = new Int32Array(16);
const PAL = new Int32Array(12);

function palette(c0: number, c1: number): void {
  PAL[0] = e5(c0 >> 11);
  PAL[1] = e6((c0 >> 5) & 63);
  PAL[2] = e5(c0 & 31);
  PAL[3] = e5(c1 >> 11);
  PAL[4] = e6((c1 >> 5) & 63);
  PAL[5] = e5(c1 & 31);
  for (let k = 0; k < 3; k++) {
    PAL[6 + k] = Math.floor((2 * PAL[k] + PAL[3 + k]) / 3);
    PAL[9 + k] = Math.floor((PAL[k] + 2 * PAL[3 + k]) / 3);
  }
}

/** Indices (2 bits per pixel, pixel 0 lowest) and squared error for a palette already in PAL. */
let lastErr = 0;
function assign(): number {
  let bits = 0;
  let err = 0;
  for (let p = 0; p < 16; p++) {
    let best = 0x7fffffff;
    let bi = 0;
    for (let k = 0; k < 4; k++) {
      const dr = R[p] - PAL[k * 3];
      const dg = G[p] - PAL[k * 3 + 1];
      const db = B[p] - PAL[k * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < best) {
        best = d;
        bi = k;
      }
    }
    err += best;
    bits |= bi << (p * 2);
  }
  lastErr = err;
  return bits >>> 0;
}

function writeColor(out: Uint8Array, o: number, c0: number, c1: number, idx: number): void {
  out[o] = c0 & 255;
  out[o + 1] = c0 >> 8;
  out[o + 2] = c1 & 255;
  out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255;
  out[o + 5] = (idx >>> 8) & 255;
  out[o + 6] = (idx >>> 16) & 255;
  out[o + 7] = (idx >>> 24) & 255;
}

/** BC1 colour block from R/G/B (the 16 pixels in the module scratch arrays). `lockBlue` >= 0 forces both endpoints' blue to that value. */
function colorBlock(out: Uint8Array, o: number, refine: number, lockBlue: number): void {
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  for (let p = 0; p < 16; p++) {
    if (R[p] < minR) minR = R[p];
    if (R[p] > maxR) maxR = R[p];
    if (G[p] < minG) minG = G[p];
    if (G[p] > maxG) maxG = G[p];
    if (B[p] < minB) minB = B[p];
    if (B[p] > maxB) maxB = B[p];
  }
  const midR = minR + maxR;
  const midG = minG + maxG;
  const midB = minB + maxB;
  let covXZ = 0;
  let covYZ = 0;
  for (let p = 0; p < 16; p++) {
    const bz = 2 * B[p] - midB;
    covXZ += (2 * R[p] - midR) * bz;
    covYZ += (2 * G[p] - midG) * bz;
  }
  const insR = (maxR - minR) >> 4;
  const insG = (maxG - minG) >> 4;
  const insB = (maxB - minB) >> 4;
  minR += insR; maxR -= insR; minG += insG; maxG -= insG; minB += insB; maxB -= insB;
  if (covXZ < 0) { const t = minR; minR = maxR; maxR = t; }
  if (covYZ < 0) { const t = minG; minG = maxG; maxG = t; }
  const pack = (r: number, g: number, b: number) => (q5(r) << 11) | (q6(g) << 5) | (lockBlue >= 0 ? q5(lockBlue) : q5(b));
  let c0 = pack(maxR, maxG, maxB);
  let c1 = pack(minR, minG, minB);
  if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }
  if (c0 === c1) {
    writeColor(out, o, c0, c1, 0);
    return;
  }
  palette(c0, c1);
  let idx = assign();
  let bestErr = lastErr;
  let bc0 = c0;
  let bc1 = c1;
  let bidx = idx;
  for (let it = 0; it < refine && bestErr > 0; it++) {
    // Least squares for the two endpoints given the current indices (weights 1, 0 / 0, 1 / 2/3, 1/3 / 1/3, 2/3).
    let aa = 0, bb = 0, ab = 0;
    const sx = [0, 0, 0], sy = [0, 0, 0];
    for (let p = 0; p < 16; p++) {
      const k = (idx >>> (p * 2)) & 3;
      const wb = k === 0 ? 0 : k === 1 ? 1 : k === 2 ? 1 / 3 : 2 / 3;
      const wa = 1 - wb;
      aa += wa * wa;
      bb += wb * wb;
      ab += wa * wb;
      sx[0] += wa * R[p]; sx[1] += wa * G[p]; sx[2] += wa * B[p];
      sy[0] += wb * R[p]; sy[1] += wb * G[p]; sy[2] += wb * B[p];
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-9) break;
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const ep = [0, 0, 0, 0, 0, 0];
    for (let c = 0; c < 3; c++) {
      ep[c] = clamp((sx[c] * bb - sy[c] * ab) / det);
      ep[3 + c] = clamp((sy[c] * aa - sx[c] * ab) / det);
    }
    let n0 = pack(ep[0], ep[1], ep[2]);
    let n1 = pack(ep[3], ep[4], ep[5]);
    if (n0 < n1) { const t = n0; n0 = n1; n1 = t; }
    if (n0 === n1 || (n0 === c0 && n1 === c1)) break;
    c0 = n0;
    c1 = n1;
    palette(c0, c1);
    idx = assign();
    if (lastErr < bestErr) {
      bestErr = lastErr;
      bc0 = c0;
      bc1 = c1;
      bidx = idx;
    }
  }
  writeColor(out, o, bc0, bc1, bidx);
}

/** DXT5 alpha block from the A scratch array. */
function alphaBlock(out: Uint8Array, o: number): void {
  let mn = 255;
  let mx = 0;
  for (let p = 0; p < 16; p++) {
    if (A[p] < mn) mn = A[p];
    if (A[p] > mx) mx = A[p];
  }
  out[o] = mx;
  out[o + 1] = mn;
  if (mx === mn) {
    out.fill(0, o + 2, o + 8);
    return;
  }
  const pal = [mx, mn, 0, 0, 0, 0, 0, 0];
  for (let k = 2; k < 8; k++) pal[k] = Math.floor(((8 - k) * mx + (k - 1) * mn) / 7);
  let lo = 0;
  let hi = 0;
  for (let p = 0; p < 16; p++) {
    let best = 0x7fffffff;
    let bi = 0;
    for (let k = 0; k < 8; k++) {
      const d = Math.abs(A[p] - pal[k]);
      if (d < best) {
        best = d;
        bi = k;
      }
    }
    const bit = p * 3;
    if (bit < 24) lo |= bi << bit;
    else hi |= bi << (bit - 24);
  }
  out[o + 2] = lo & 255;
  out[o + 3] = (lo >> 8) & 255;
  out[o + 4] = (lo >> 16) & 255;
  out[o + 5] = hi & 255;
  out[o + 6] = (hi >> 8) & 255;
  out[o + 7] = (hi >> 16) & 255;
}

/** The YCoCg scale a block of Co/Cg (offset 128) needs: 4, 2 or 1. */
export function ycocgScale(maxDev: number): number {
  return maxDev < 32 ? 4 : maxDev < 64 ? 2 : 1;
}

export interface DxtOptions {
  /** Least-squares refinements per colour block (CPU only; 0 = the algorithm the GPU path implements). Default 2. */
  refine?: number;
}

/**
 * Compress one RGBA8 (straight alpha) frame into `out` (length dxtFrameBytes). Edge pixels are replicated when the size is not a
 * multiple of 4. Hap1 ignores alpha.
 */
export function compressDxt(rgba: Pixels, width: number, height: number, fmt: DxtFormat, out: Uint8Array, opts: DxtOptions = {}): void {
  const refine = opts.refine ?? 2;
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  const bsz = blockBytes(fmt);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, o += bsz) {
      for (let p = 0; p < 16; p++) {
        const x = Math.min(width - 1, bx * 4 + (p & 3));
        const y = Math.min(height - 1, by * 4 + (p >> 2));
        const i = (y * width + x) * 4;
        R[p] = rgba[i];
        G[p] = rgba[i + 1];
        B[p] = rgba[i + 2];
        A[p] = rgba[i + 3];
      }
      if (fmt === 'Hap1') {
        colorBlock(out, o, refine, -1);
      } else if (fmt === 'Hap5') {
        alphaBlock(out, o);
        colorBlock(out, o + 8, refine, -1);
      } else {
        let dev = 0;
        for (let p = 0; p < 16; p++) {
          const r = R[p], g = G[p], b = B[p];
          const y = (r + 2 * g + b + 2) >> 2;
          const co = Math.max(1, Math.min(255, ((r - b) >> 1) + 128));
          const cg = Math.max(1, Math.min(255, ((2 * g - r - b) >> 2) + 128));
          A[p] = y;
          R[p] = co;
          G[p] = cg;
          dev = Math.max(dev, Math.abs(co - 128), Math.abs(cg - 128));
        }
        const s = ycocgScale(dev);
        const blue = (s - 1) * 8;
        for (let p = 0; p < 16; p++) {
          R[p] = Math.max(0, Math.min(255, (R[p] - 128) * s + 128));
          G[p] = Math.max(0, Math.min(255, (G[p] - 128) * s + 128));
          B[p] = blue;
        }
        alphaBlock(out, o);
        colorBlock(out, o + 8, refine, blue);
      }
    }
  }
}

/** Decode a compressed frame back to straight RGBA8 of the real size (Hap1 alpha = 255). */
export function decompressDxt(data: Uint8Array, width: number, height: number, fmt: DxtFormat): Uint8Array {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  const bsz = blockBytes(fmt);
  const out = new Uint8Array(width * height * 4);
  const pal = new Int32Array(16);
  const apal = new Int32Array(8);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * bsz;
      const co = fmt === 'Hap1' ? o : o + 8;
      const c0 = data[co] | (data[co + 1] << 8);
      const c1 = data[co + 2] | (data[co + 3] << 8);
      palette(c0, c1);
      for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) pal[k * 4 + c] = PAL[k * 3 + c];
      let transparentBlack = false;
      if (fmt === 'Hap1' && c0 <= c1) {
        for (let c = 0; c < 3; c++) {
          pal[8 + c] = (PAL[c] + PAL[3 + c]) >> 1;
        }
        transparentBlack = true;
      }
      const idx = (data[co + 4] | (data[co + 5] << 8) | (data[co + 6] << 16) | (data[co + 7] << 24)) >>> 0;
      let a0 = 0, a1 = 0, abits = 0n;
      if (fmt !== 'Hap1') {
        a0 = data[o];
        a1 = data[o + 1];
        for (let k = 0; k < 6; k++) abits |= BigInt(data[o + 2 + k]) << BigInt(8 * k);
        apal[0] = a0;
        apal[1] = a1;
        if (a0 > a1) for (let k = 2; k < 8; k++) apal[k] = Math.floor(((8 - k) * a0 + (k - 1) * a1) / 7);
        else {
          for (let k = 2; k < 6; k++) apal[k] = Math.floor(((6 - k) * a0 + (k - 1) * a1) / 5);
          apal[6] = 0;
          apal[7] = 255;
        }
      }
      for (let p = 0; p < 16; p++) {
        const x = bx * 4 + (p & 3);
        const y = by * 4 + (p >> 2);
        if (x >= width || y >= height) continue;
        const k = (idx >>> (p * 2)) & 3;
        let r = pal[k * 4], g = pal[k * 4 + 1], b = pal[k * 4 + 2];
        let a = 255;
        if (transparentBlack && k === 3) {
          r = g = b = 0;
          a = 0;
        }
        if (fmt !== 'Hap1') a = apal[Number((abits >> BigInt(p * 3)) & 7n)];
        const i = (y * width + x) * 4;
        if (fmt === 'HapY') {
          const scale = b / 8 + 1;
          const dco = (r - 128) / scale;
          const dcg = (g - 128) / scale;
          const yy = a;
          out[i] = clamp8(yy + dco - dcg);
          out[i + 1] = clamp8(yy + dcg);
          out[i + 2] = clamp8(yy - dco - dcg);
          out[i + 3] = 255;
        } else {
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

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Peak signal-to-noise ratio over RGB (and alpha when `alpha`), 8-bit. Infinity when identical. */
export function psnr(a: Pixels, b: Pixels, alpha = false): number {
  let se = 0;
  let n = 0;
  const ch = alpha ? 4 : 3;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < ch; c++) {
      const d = a[i + c] - b[i + c];
      se += d * d;
      n++;
    }
  }
  if (se === 0) return Infinity;
  return 10 * Math.log10((255 * 255 * n) / se);
}
