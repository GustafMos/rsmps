/**
 * The arithmetic of the AI Style Transfer node, with no GPU and no model in it (so all of it is unit-tested):
 *
 *  - WHEN: which progress a frame has, and which frames need the network at all;
 *  - HOW MUCH: the staging of a transition (whose shapes, whose style, how much of the network's picture is shown);
 *  - PACKING: pictures to and from the layout the model takes (see lib/style-ai-bridge.ts for the measured layout);
 *  - TILES: the model takes 512 x 512 only, so a larger picture is cut into overlapping tiles and the results are cross-faded;
 *  - ADAIN: the style transfer itself, done between the encoder and the decoder on the feature maps.
 */
import { STYLE_AI_MODEL } from './style-ai-bridge';

const TILE = STYLE_AI_MODEL.tile;
const STRIDE = STYLE_AI_MODEL.stride;
const CELLS = TILE / STRIDE;
const CHANNELS = STYLE_AI_MODEL.channels;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const k = clamp01((v - a) / (b - a));
  return k * k * (3 - 2 * k);
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* When                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export type StyleDrive = 'loop' | 'pingpong' | 'span';

export interface StyleTiming {
  drive: StyleDrive;
  /** 'span' only: where the transition starts and how long it is, both as a fraction of the project length. */
  start: number;
  length: number;
  frames: number;
  /** A looping project never shows "the frame after the last", so A to B runs over all its frames; otherwise the last frame is B. */
  loop: boolean;
}

/** Progress of the transition at a project frame: 0 = picture A, 1 = picture B. A job needs this to be a plain function of the frame. */
export function styleProgress(frame: number, t: StyleTiming): number {
  const n = Math.max(1, Math.round(t.frames));
  const f = Math.min(n - 1, Math.max(0, frame));
  if (t.drive === 'span') {
    const len = Math.max(1, t.length * n);
    return clamp01((f - t.start * n) / len);
  }
  const ph = t.loop ? f / n : n > 1 ? f / (n - 1) : 0;
  return t.drive === 'pingpong' ? clamp01(0.5 - 0.5 * Math.cos(ph * Math.PI * 2)) : clamp01(ph);
}

/**
 * The frames the network has to paint: from the first to the last frame whose progress is strictly between 0 and 1. Outside of them
 * the node shows picture A or B themselves, at full quality and for free. `count` 0 = nothing to do.
 */
export function stylePlan(t: StyleTiming): { first: number; count: number } {
  const n = Math.max(1, Math.round(t.frames));
  let first = -1;
  let last = -1;
  for (let f = 0; f < n; f++) {
    const p = styleProgress(f, t);
    if (p > 0 && p < 1) {
      if (first < 0) first = f;
      last = f;
    }
  }
  return first < 0 ? { first: 0, count: 0 } : { first, count: last - first + 1 };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* How much                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The staging of the transition, the same order as Style Melt's: B's STYLE arrives first (A is repainted with B's colours and
 * texture), then the SHAPES change from A's to B's. Both are 0 at progress 0 and 1 at progress 1.
 */
export function styleStages(t: number): { shape: number; lead: number } {
  const x = clamp01(t);
  return { shape: smooth(0.3, 0.7, x), lead: smooth(0.02, 0.5, x) };
}

/**
 * How much of the network's picture is shown over the real pictures: 0 at both ends (so progress 0 is exactly A and progress 1 is
 * exactly B, whatever the network made of them), 1 in between. `fade` is the part of the transition each end takes to get there.
 */
export function styleMix(t: number, fade: number): number {
  const x = clamp01(t);
  const f = Math.min(0.5, Math.max(0.001, fade));
  return smooth(0, f, x) * smooth(0, f, 1 - x);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Sizes and tiles                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Size of the picture the network works on: the frame's shape, its longest side `long`, both sides a multiple of 8 (one feature
 * cell of the encoder is 8 pixels, so anything else would be cut off or padded inside a cell).
 */
export function styleWorkSize(width: number, height: number, long: number): { width: number; height: number } {
  const k = Math.max(64, long) / Math.max(1, width, height);
  const r = (v: number) => Math.max(64, Math.round((v * k) / STRIDE) * STRIDE);
  return { width: r(width), height: r(height) };
}

/**
 * Where tiles start along one side of `size` pixels. One tile when it fits (the rest of the tile is filled by mirroring). Otherwise
 * as few tiles as cover the side with at least `minOverlap` pixels shared between neighbours, evenly spread, on whole feature cells.
 */
export function tileOrigins(size: number, minOverlap = 96): number[] {
  if (size <= TILE) return [0];
  const n = Math.max(2, Math.ceil((size - minOverlap) / (TILE - minOverlap)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i === n - 1 ? size - TILE : Math.round((i * (size - TILE)) / (n - 1) / STRIDE) * STRIDE);
  return out;
}

export interface StyleTile {
  x: number;
  y: number;
  /** How much each pixel column / row of this tile counts when tiles are joined (0..1): it ramps across the part shared with a neighbour. */
  wx: Float32Array;
  wy: Float32Array;
}

function ramps(origins: number[], i: number, size: number): Float32Array {
  const w = new Float32Array(TILE);
  const o = origins[i];
  const before = i > 0 ? origins[i - 1] + TILE - o : 0; // pixels shared with the tile before
  const after = i < origins.length - 1 ? o + TILE - origins[i + 1] : 0;
  for (let p = 0; p < TILE; p++) {
    if (o + p >= size) continue; // mirrored filling: not part of the picture
    let v = 1;
    if (before > 0 && p < before) v = Math.min(v, (p + 0.5) / before);
    if (after > 0 && p >= TILE - after) v = Math.min(v, (TILE - p - 0.5) / after);
    w[p] = v;
  }
  return w;
}

/** The tiles of a `width x height` work picture, row by row. */
export function styleTiles(width: number, height: number): StyleTile[] {
  const xs = tileOrigins(width);
  const ys = tileOrigins(height);
  const out: StyleTile[] = [];
  ys.forEach((y, j) => {
    const wy = ramps(ys, j, height);
    xs.forEach((x, i) => out.push({ x, y, wx: ramps(xs, i, width), wy }));
  });
  return out;
}

/** How many tiles a picture of this size (before the long side is applied) is worked on as: the cost of a frame is this times three network runs. */
export function styleTileCount(width: number, height: number, long: number): number {
  const s = styleWorkSize(width, height, long);
  return tileOrigins(s.width).length * tileOrigins(s.height).length;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Packing                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Mirror an index into 0..n-1 without repeating the edge pixel (… 2 1 0 1 2 … n-2 n-1 n-2 …). */
export function mirror(i: number, n: number): number {
  if (n <= 1) return 0;
  const period = 2 * n - 2;
  const p = ((i % period) + period) % period;
  return p < n ? p : period - p;
}

/**
 * Bilinear resize of an RGBA picture (the engine's GPU already shrank the frame to about the right size; this only makes the two
 * pictures exactly the work size). The same array is returned when nothing has to change.
 */
export function resizeRgba(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] * (1 - tx) + src[b + k] * tx) * (1 - ty) + (src[c + k] * (1 - tx) + src[d + k] * tx) * ty;
    }
  }
  return out;
}

/**
 * One 512 x 512 tile of an RGBA picture as the encoder takes it: three planes (all red, then all green, then all blue), values 0..1,
 * no mean or spread correction. Where the tile reaches past the picture it is filled with the picture mirrored, which the network
 * reads as "more of the same" (black would be read as a hard edge and darken the style). Alpha is ignored: the frame is opaque.
 */
export function packTile(rgba: Uint8ClampedArray, width: number, height: number, ox: number, oy: number, out = new Float32Array(3 * TILE * TILE)): Float32Array {
  const n = TILE * TILE;
  const cols = new Int32Array(TILE);
  for (let x = 0; x < TILE; x++) cols[x] = mirror(ox + x, width) * 4;
  for (let y = 0; y < TILE; y++) {
    const row = mirror(oy + y, height) * width * 4;
    const o = y * TILE;
    for (let x = 0; x < TILE; x++) {
      const s = row + cols[x];
      out[o + x] = rgba[s] / 255;
      out[n + o + x] = rgba[s + 1] / 255;
      out[2 * n + o + x] = rgba[s + 2] / 255;
    }
  }
  return out;
}

/** Add one decoded tile (three planes, about 0..1) into the frame being joined: `acc` holds weighted sums (RGB interleaved), `weight` the weights. */
export function addTile(planes: Float32Array, tile: StyleTile, width: number, height: number, acc: Float32Array, weight: Float32Array): void {
  const n = TILE * TILE;
  for (let y = 0; y < TILE; y++) {
    const py = tile.y + y;
    const wy = tile.wy[y];
    if (py >= height || wy <= 0) continue;
    for (let x = 0; x < TILE; x++) {
      const px = tile.x + x;
      const w = wy * tile.wx[x];
      if (px >= width || w <= 0) continue;
      const s = y * TILE + x;
      const d = py * width + px;
      acc[d * 3] += planes[s] * w;
      acc[d * 3 + 1] += planes[n + s] * w;
      acc[d * 3 + 2] += planes[2 * n + s] * w;
      weight[d] += w;
    }
  }
}

/**
 * Finish a joined frame: divide by the weights, and steady it against the frame before. `steady` 0 = each frame by itself (it
 * flickers: the network repaints every frame from nothing), towards 1 = mostly the frame before (calm, but moving things leave a
 * trail). `previous` is updated in place to this frame, so the next call continues from it; pass null for the first frame.
 * Returns the frame as RGB floats, about 0..1 (not clamped).
 */
export function joinFrame(acc: Float32Array, weight: Float32Array, previous: Float32Array | null, steady: number): Float32Array {
  const s = previous ? Math.min(0.95, Math.max(0, steady)) : 0;
  const out = previous ?? new Float32Array(acc.length);
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i] > 0 ? 1 / weight[i] : 0;
    for (let k = 0; k < 3; k++) {
      const v = acc[i * 3 + k] * w;
      out[i * 3 + k] = s > 0 ? v + (out[i * 3 + k] - v) * s : v;
    }
  }
  return out;
}

/** RGB floats (about 0..1, overshoot is cut off) to opaque 8 bit RGBA. */
export function toRgba(rgb: Float32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = rgb[i * 3] * 255; // a clamped array rounds and cuts off by itself
    out[i * 4 + 1] = rgb[i * 3 + 1] * 255;
    out[i * 4 + 2] = rgb[i * 3 + 2] * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* AdaIN                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Per feature map: its mean and its spread. This pair is what the network "sees" as the style of a picture. */
export interface StyleStats {
  mean: Float32Array;
  std: Float32Array;
}

/**
 * The style of a picture from its tiles' features (each 512 maps of 64 x 64). Only the cells that show the picture are counted
 * (`cellsW x cellsH` from the tile's corner), not the mirrored filling. `channels` and `cells` are parameters only for the tests.
 */
export function featureStats(tiles: readonly Float32Array[], cellsW: number, cellsH: number, channels: number = CHANNELS, cells: number = CELLS): StyleStats {
  const mean = new Float32Array(channels);
  const std = new Float32Array(channels);
  const cw = Math.min(cells, Math.max(1, cellsW));
  const ch = Math.min(cells, Math.max(1, cellsH));
  const count = cw * ch * Math.max(1, tiles.length);
  for (let c = 0; c < channels; c++) {
    let sum = 0;
    let sq = 0;
    for (const f of tiles) {
      for (let y = 0; y < ch; y++) {
        const o = (c * cells + y) * cells;
        for (let x = 0; x < cw; x++) {
          const v = f[o + x];
          sum += v;
          sq += v * v;
        }
      }
    }
    const m = sum / count;
    mean[c] = m;
    // The small constant is the one the model was trained with: a flat map must not divide by zero.
    std[c] = Math.sqrt(Math.max(0, sq / count - m * m) + 1e-5);
  }
  return { mean, std };
}

/**
 * The style transfer step. Every feature map of a picture is first brought to mean 0 and spread 1 ("what is where", with the style
 * taken out); the two pictures are blended in that form by `shape` (0 = A's content, 1 = B's); the result is then given a mean and a
 * spread between A's and B's by `lead` (0 = A's style, 1 = B's).
 *   shape 0, lead 0 = A's features unchanged; shape 0, lead 1 = A painted like B; shape 1, lead 1 = B's features unchanged.
 * `fa` / `fb` may be null where their weight is zero (the job then does not have to run the encoder for that picture's tile).
 */
export function adainMix(fa: Float32Array | null, fb: Float32Array | null, sa: StyleStats, sb: StyleStats, shape: number, lead: number, out: Float32Array, channels: number = CHANNELS, cells: number = CELLS): Float32Array {
  const n = cells * cells;
  const wb = fb ? (fa ? clamp01(shape) : 1) : 0;
  const wa = fa ? 1 - wb : 0;
  const l = clamp01(lead);
  for (let c = 0; c < channels; c++) {
    const mean = sa.mean[c] + (sb.mean[c] - sa.mean[c]) * l;
    const std = sa.std[c] + (sb.std[c] - sa.std[c]) * l;
    const ka = wa / sa.std[c];
    const kb = wb / sb.std[c];
    const ma = sa.mean[c];
    const mb = sb.mean[c];
    const o = c * n;
    if (fa && fb && wa > 0 && wb > 0) for (let i = 0; i < n; i++) out[o + i] = ((fa[o + i] - ma) * ka + (fb[o + i] - mb) * kb) * std + mean;
    else if (fa && wa > 0) for (let i = 0; i < n; i++) out[o + i] = (fa[o + i] - ma) * ka * std + mean;
    else if (fb) for (let i = 0; i < n; i++) out[o + i] = (fb[o + i] - mb) * kb * std + mean;
  }
  return out;
}
