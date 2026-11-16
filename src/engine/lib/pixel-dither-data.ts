/**
 * Dither catalogue: threshold matrices (ordered / pattern families), diffusion kernels, the Hilbert
 * curve for Riemersma, and the CPU error-diffusion routine. Pure functions, no GPU.
 *
 * Every threshold matrix is a *bijective rank* matrix: with N cells the thresholds are exactly
 * (0.5/N, 1.5/N, ... (N-0.5)/N). That keeps the tone curve linear, so the dithered result keeps the
 * brightness of the source. (The old engine's dot / crosshatch / diagonal / "clustered" matrices were
 * not rank matrices: see the notes in pixel-dither.node.ts.)
 */
import { BLUE_NOISE_RANKS_B64 } from './pixel-blue-noise-data';
import { spaceWeights, srgbToLinear, type DitherSpace, type Rgb } from './pixel-color';

export type DitherFamily = 'ordered' | 'pattern' | 'blend' | 'diffusion' | 'none';

export interface DitherAlgorithm {
  id: string;
  label: string;
  family: DitherFamily;
}

const FAMILY_LABEL: Record<DitherFamily, string> = {
  none: 'None',
  ordered: 'Ordered',
  pattern: 'Pattern',
  blend: 'Palette blend',
  diffusion: 'Diffusion',
};

const A = (id: string, label: string, family: DitherFamily): DitherAlgorithm => ({ id, label: `${FAMILY_LABEL[family]} · ${label}`, family });

export const DITHER_ALGORITHMS: DitherAlgorithm[] = [
  A('threshold', 'Nearest colour (no dither)', 'none'),
  A('bayer-2', 'Bayer 2×2', 'ordered'),
  A('bayer-4', 'Bayer 4×4', 'ordered'),
  A('bayer-8', 'Bayer 8×8', 'ordered'),
  A('bayer-16', 'Bayer 16×16', 'ordered'),
  A('blue-noise', 'Blue noise', 'ordered'),
  A('clustered-dot-4', 'Clustered dot 4×4', 'ordered'),
  A('clustered-dot-8', 'Clustered dot 8×8', 'ordered'),
  A('white-noise', 'White noise', 'ordered'),
  A('line-horizontal', 'Horizontal lines', 'pattern'),
  A('line-vertical', 'Vertical lines', 'pattern'),
  A('line-diagonal', 'Diagonal lines', 'pattern'),
  A('checker', 'Checkerboard', 'pattern'),
  A('dots', 'Dot screen', 'pattern'),
  A('crosshatch', 'Crosshatch', 'pattern'),
  A('yliluoma', 'Yliluoma (two-colour mix)', 'blend'),
  A('floyd-steinberg', 'Floyd–Steinberg', 'diffusion'),
  A('false-floyd-steinberg', 'False Floyd–Steinberg', 'diffusion'),
  A('atkinson', 'Atkinson', 'diffusion'),
  A('jarvis', 'Jarvis–Judice–Ninke', 'diffusion'),
  A('stucki', 'Stucki', 'diffusion'),
  A('burkes', 'Burkes', 'diffusion'),
  A('sierra', 'Sierra', 'diffusion'),
  A('two-row-sierra', 'Two-row Sierra', 'diffusion'),
  A('sierra-lite', 'Sierra Lite', 'diffusion'),
  A('shiau-fan', 'Shiau–Fan', 'diffusion'),
  A('stevenson-arce', 'Stevenson–Arce', 'diffusion'),
  A('simple-2d', 'Simple 2D', 'diffusion'),
  A('riemersma', 'Riemersma (Hilbert curve)', 'diffusion'),
];

export function algorithmFamily(id: string): DitherFamily {
  return DITHER_ALGORITHMS.find((a) => a.id === id)?.family ?? 'none';
}

/* ------------------------------------------------------------------------ */
/* Threshold matrices                                                       */
/* ------------------------------------------------------------------------ */

export interface ThresholdMatrix {
  width: number;
  height: number;
  /** width*height thresholds in (0,1), row-major. */
  data: Float32Array;
}

/** Turn a "key" per cell into bijective ranks (ties broken by cell index, so deterministic). */
function ranksFromKeys(width: number, height: number, key: (x: number, y: number) => number): ThresholdMatrix {
  const n = width * height;
  const order = Array.from({ length: n }, (_, i) => i);
  const keys = order.map((i) => key(i % width, Math.floor(i / width)));
  order.sort((a, b) => keys[a] - keys[b] || a - b);
  const data = new Float32Array(n);
  order.forEach((cell, rank) => (data[cell] = (rank + 0.5) / n));
  return { width, height, data };
}

function bayer(size: number): ThresholdMatrix {
  let m = [0];
  let dim = 1;
  while (dim < size) {
    const nd = dim * 2;
    const next = new Array<number>(nd * nd).fill(0);
    for (let y = 0; y < dim; y++) {
      for (let x = 0; x < dim; x++) {
        const v = m[y * dim + x] * 4;
        next[y * nd + x] = v;
        next[y * nd + x + dim] = v + 2;
        next[(y + dim) * nd + x] = v + 3;
        next[(y + dim) * nd + x + dim] = v + 1;
      }
    }
    m = next;
    dim = nd;
  }
  const n = size * size;
  return { width: size, height: size, data: Float32Array.from(m, (v) => (v + 0.5) / n) };
}

function decodeBase64(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Map<string, number>([...chars].map((c, i) => [c, i]));
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    acc = ((acc << 6) | (lookup.get(ch) ?? 0)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

function blueNoise(): ThresholdMatrix {
  const bytes = decodeBase64(BLUE_NOISE_RANKS_B64);
  const n = 64 * 64;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = ((bytes[i * 2] | (bytes[i * 2 + 1] << 8)) + 0.5) / n;
  return { width: 64, height: 64, data };
}

const periodic = (v: number, period: number): number => {
  const m = ((v % period) + period) % period;
  return Math.min(m, period - m);
};

/** Threshold matrix for an algorithm id, or null when it does not use one (white noise, diffusion, none). */
export function thresholdMatrix(id: string): ThresholdMatrix | null {
  switch (id) {
    case 'bayer-2':
      return bayer(2);
    case 'bayer-4':
      return bayer(4);
    case 'bayer-8':
    case 'yliluoma':
      return bayer(8);
    case 'bayer-16':
      return bayer(16);
    case 'blue-noise':
      return blueNoise();
    case 'clustered-dot-4':
      // Classic 45° halftone cell: the dot grows from the centre.
      return {
        width: 4,
        height: 4,
        data: Float32Array.from([12, 5, 6, 13, 4, 0, 1, 7, 11, 3, 2, 8, 15, 10, 9, 14], (v) => (v + 0.5) / 16),
      };
    case 'clustered-dot-8':
      // Euclidean spot function at 45°: dots at the centre and corners, growing until they merge.
      return ranksFromKeys(
        8,
        8,
        (x, y) => -(Math.cos((2 * Math.PI * (x + 0.5)) / 8) + Math.cos((2 * Math.PI * (y + 0.5)) / 8)) + 1e-4 * Math.sin(x * 12.9898 + y * 78.233),
      );
    case 'line-horizontal':
      // 4 rows per line; each row fills in a checker order, so mid-tones are dotted lines.
      return ranksFromKeys(2, 4, (x, y) => y * 2 + ((x + y) & 1));
    case 'line-vertical':
      return ranksFromKeys(4, 2, (x, y) => x * 2 + ((x + y) & 1));
    case 'line-diagonal':
      return ranksFromKeys(4, 4, (x, y) => ((x + y) & 3) * 4 + (x & 3));
    case 'checker': {
      // One colour of the board first (ordered by a Bayer 4x4 among themselves), then the other.
      const b = bayer(4).data;
      return ranksFromKeys(4, 4, (x, y) => ((x + y) & 1) * 100 + b[y * 4 + x]);
    }
    case 'dots': {
      // Round dot screen, 6x6 cell, one dot at the centre.
      const c = 2.5;
      return ranksFromKeys(6, 6, (x, y) => Math.hypot(x - c, y - c) + 1e-3 * Math.atan2(y - c, x - c));
    }
    case 'crosshatch': {
      // Two diagonal line sets; line cells come first, ties broken by Bayer 8x8 so the tone ramp stays smooth.
      const b = bayer(8).data;
      return ranksFromKeys(8, 8, (x, y) => Math.min(periodic(x + y, 8), periodic(x - y, 8)) + 0.5 * b[y * 8 + x]);
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Diffusion                                                                 */
/* ------------------------------------------------------------------------ */

interface Kernel {
  divisor: number;
  taps: [number, number, number][]; // dx, dy, weight
}

export const DIFFUSION_KERNELS: Record<string, Kernel> = {
  'floyd-steinberg': { divisor: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { divisor: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  jarvis: {
    divisor: 48,
    taps: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
  },
  stucki: {
    divisor: 42,
    taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
  },
  burkes: { divisor: 32, taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]] },
  sierra: { divisor: 32, taps: [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]] },
  'two-row-sierra': { divisor: 16, taps: [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]] },
  'sierra-lite': { divisor: 4, taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
  // Shiau-Fan (1993): half of the error goes right, the rest below-left.
  'shiau-fan': { divisor: 16, taps: [[1, 0, 8], [-3, 1, 1], [-2, 1, 1], [-1, 1, 2], [0, 1, 4]] },
  'simple-2d': { divisor: 2, taps: [[1, 0, 1], [0, 1, 1]] },
  'false-floyd-steinberg': { divisor: 8, taps: [[1, 0, 3], [0, 1, 3], [1, 1, 2]] },
  // Stevenson-Arce (1985), hexagonal-grid kernel with reach 3.
  'stevenson-arce': { divisor: 200, taps: [[2, 0, 32], [-3, 1, 12], [-1, 1, 26], [1, 1, 30], [3, 1, 16], [-2, 2, 12], [0, 2, 26], [2, 2, 12], [-3, 3, 5], [-1, 3, 12], [1, 3, 12], [3, 3, 5]] },
};

/**
 * Wavefront skew for left-to-right diffusion: the smallest k such that every tap lands strictly later in
 * time t = x + k*y than its source (dx + k*dy >= 1). Pixels with equal t never feed each other.
 */
export function wavefrontSkew(kernel: { taps: [number, number, number][] }): number {
  let k = 1;
  for (const [dx, dy] of kernel.taps) if (dy > 0) k = Math.max(k, Math.ceil((1 - dx) / dy));
  return k;
}

/** Hilbert curve: cell (x, y) of the curve step `d` on an n×n grid (n a power of two). */
export function hilbertD2xy(n: number, d: number): [number, number] {
  const v = hilbertPacked(n, d);
  return [v & 0xffff, v >>> 16];
}

/** Same as hilbertD2xy, packed as x | (y << 16) so a loop over the whole curve allocates nothing. */
function hilbertPacked(n: number, d: number): number {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return x | (y << 16);
}

/** Pixel indices (y * width + x) in Hilbert-curve order, for Riemersma. */
export function hilbertOrder(width: number, height: number): Uint32Array {
  let side = 1;
  while (side < Math.max(width, height)) side *= 2;
  const out = new Uint32Array(width * height);
  let k = 0;
  for (let d = 0; d < side * side; d++) {
    const v = hilbertPacked(side, d);
    const x = v & 0xffff;
    const y = v >>> 16;
    if (x < width && y < height) out[k++] = y * width + x;
  }
  return out;
}

export interface DiffuseOptions {
  algorithm: string;
  strength: number;
  space: DitherSpace;
  serpentine: boolean;
  /** Palette colours, sRGB 0..1. */
  palette: Rgb[];
}

/**
 * Keep the working colour inside a sane range so error cannot run away with tiny palettes.
 * (Allocation-free on purpose: the CPU paths run per pixel and garbage collection pauses are best avoided.)
 */
function clampWork(v: Float32Array, o: number, space: DitherSpace): void {
  if (space === 'oklab') {
    v[o] = Math.min(1, Math.max(0, v[o]));
    v[o + 1] = Math.min(0.5, Math.max(-0.5, v[o + 1]));
    v[o + 2] = Math.min(0.5, Math.max(-0.5, v[o + 2]));
  } else {
    v[o] = Math.min(1, Math.max(0, v[o]));
    v[o + 1] = Math.min(1, Math.max(0, v[o + 1]));
    v[o + 2] = Math.min(1, Math.max(0, v[o + 2]));
  }
}

/** sRGB 0..1 → working space, written into `out` at `o`. */
function toSpaceInto(r: number, g: number, b: number, space: DitherSpace, out: Float32Array, o: number): void {
  if (space === 'srgb') {
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    return;
  }
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  if (space === 'linear') {
    out[o] = lr;
    out[o + 1] = lg;
    out[o + 2] = lb;
    return;
  }
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/**
 * Error diffusion on straight RGBA8 (CPU). Sequential by nature. Returns a new array; alpha is copied,
 * fully transparent pixels are left alone and take no part in the error flow.
 */
export function diffuseImage(rgba: Uint8ClampedArray, width: number, height: number, opts: DiffuseOptions): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const pal = opts.palette;
  const n = pal.length;
  if (n === 0) return out;
  const space = opts.space;
  const strength = Math.min(1, Math.max(0, opts.strength));
  const ps = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) toSpaceInto(pal[i][0], pal[i][1], pal[i][2], space, ps, i * 3);
  const wt = spaceWeights(space);
  const wx = wt[0];
  const wy = wt[1];
  const wz = wt[2];
  const pr = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pr[i * 3 + c] = Math.round(pal[i][c] * 255);

  // Source colours in working space, once.
  const base = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) toSpaceInto(rgba[p * 4] / 255, rgba[p * 4 + 1] / 255, rgba[p * 4 + 2] / 255, space, base, p * 3);

  const w = new Float32Array(3);
  const nearest = (): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const a = w[0] - ps[i * 3];
      const b = w[1] - ps[i * 3 + 1];
      const c = w[2] - ps[i * 3 + 2];
      const d = wx * a * a + wy * b * b + wz * c * c;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const write = (p: number, idx: number): void => {
    out[p * 4] = pr[idx * 3];
    out[p * 4 + 1] = pr[idx * 3 + 1];
    out[p * 4 + 2] = pr[idx * 3 + 2];
  };

  if (opts.algorithm === 'riemersma') {
    const LEN = 16;
    const weights = new Float32Array(LEN);
    let total = 0;
    for (let k = 0; k < LEN; k++) {
      weights[k] = Math.pow(16, -k / (LEN - 1));
      total += weights[k];
    }
    for (let k = 0; k < LEN; k++) weights[k] /= total;
    const history = new Float32Array(LEN * 3); // ring buffer, newest at `head`
    let head = 0;
    let count = 0;
    let side = 1;
    while (side < Math.max(width, height)) side *= 2;
    for (let d = 0; d < side * side; d++) {
      const v = hilbertPacked(side, d);
      const x = v & 0xffff;
      const y = v >>> 16;
      if (x >= width || y >= height) continue;
      const p = y * width + x;
      if (rgba[p * 4 + 3] === 0) continue;
      w[0] = base[p * 3];
      w[1] = base[p * 3 + 1];
      w[2] = base[p * 3 + 2];
      for (let k = 0; k < count; k++) {
        const h = ((head - k + LEN) % LEN) * 3;
        w[0] += history[h] * weights[k];
        w[1] += history[h + 1] * weights[k];
        w[2] += history[h + 2] * weights[k];
      }
      clampWork(w, 0, space);
      const idx = nearest();
      write(p, idx);
      head = (head + 1) % LEN;
      history[head * 3] = (w[0] - ps[idx * 3]) * strength;
      history[head * 3 + 1] = (w[1] - ps[idx * 3 + 1]) * strength;
      history[head * 3 + 2] = (w[2] - ps[idx * 3 + 2]) * strength;
      if (count < LEN) count++;
    }
    return out;
  }

  const kernel = DIFFUSION_KERNELS[opts.algorithm];
  if (!kernel) {
    for (let p = 0; p < width * height; p++) {
      if (rgba[p * 4 + 3] === 0) continue;
      w[0] = base[p * 3];
      w[1] = base[p * 3 + 1];
      w[2] = base[p * 3 + 2];
      write(p, nearest());
    }
    return out;
  }
  const taps = kernel.taps;
  const err = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const reverse = opts.serpentine && (y & 1) === 1;
    const dir = reverse ? -1 : 1;
    for (let k = 0; k < width; k++) {
      const x = reverse ? width - 1 - k : k;
      const p = y * width + x;
      if (rgba[p * 4 + 3] === 0) continue;
      w[0] = base[p * 3] + err[p * 3];
      w[1] = base[p * 3 + 1] + err[p * 3 + 1];
      w[2] = base[p * 3 + 2] + err[p * 3 + 2];
      clampWork(w, 0, space);
      const idx = nearest();
      write(p, idx);
      const e0 = (w[0] - ps[idx * 3]) * strength;
      const e1 = (w[1] - ps[idx * 3 + 1]) * strength;
      const e2 = (w[2] - ps[idx * 3 + 2]) * strength;
      for (let t = 0; t < taps.length; t++) {
        const nx = x + taps[t][0] * dir;
        const ny = y + taps[t][1];
        if (nx < 0 || nx >= width || ny >= height) continue;
        const q = (ny * width + nx) * 3;
        const f = taps[t][2] / kernel.divisor;
        err[q] += e0 * f;
        err[q + 1] += e1 * f;
        err[q + 2] += e2 * f;
      }
    }
  }
  return out;
}
