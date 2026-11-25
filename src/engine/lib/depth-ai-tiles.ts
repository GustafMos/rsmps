/**
 * "High detail" for the AI depth model, pure maths (no GPU, no model, no DOM).
 *
 * Why tiles: the model sees at most a few hundred pixels on its long side, so hair, fingers and wires are smaller than what it can
 * resolve. Running it again on overlapping parts of the picture, each part at the model's full size, shows it those things two or three
 * times larger. But a part of a picture has no idea where it sits in the whole scene (the model's numbers are relative, and a tile that
 * holds only a wall invents a depth range for it), so a tile is never trusted for the overall depth:
 *
 *  1. the whole-picture run (the "base") decides the depth order of the scene;
 *  2. every tile is fitted onto the base by one scale and one offset (least squares over the tile, `fitAffine`);
 *  3. what is left of the difference to the base is removed where it is SLOW (a wide blur of base minus tile is added back), so the base
 *     keeps every large shape and the tile adds only what is finer than that blur: its sharp edges and thin things;
 *  4. tiles are cross-faded over their overlap (`featherWeights`), so no seam shows.
 *
 * This is the idea of patch-based depth refinement (Miangoleh et al., "Boosting Monocular Depth Estimation Models to High-Resolution via
 * Content-Adaptive Multi-Resolution Merging", 2021) in its simplest form: a fixed grid and a linear merge instead of a merging network.
 *
 * The blur in step 3 is deliberately wide (a twelfth of the tile). A narrow one leaves a glow around every object: the base's own edges
 * are soft, and with a narrow blur that softness counts as "slow difference" and is put back next to the tile's sharp edge.
 */
import { resizeChannels, type Affine } from './depth-ai-math';

/** Part of each side that neighbouring tiles share, relative to a grid without overlap. */
export const TILE_OVERLAP = 0.25;

/** How much larger than the model's own output the detailed map is, per side: 1.6 for 2 x 2 tiles, 2.4 for 3 x 3. */
export function tileScale(n: number): number {
  return n <= 1 ? 1 : n / (1 + TILE_OVERLAP);
}

export interface TileLayout {
  /** Tiles per side. */
  n: number;
  /** Size of the detailed map. */
  width: number;
  height: number;
  /** Size of one tile in the detailed map: the model's output size, so a tile needs no resampling. */
  tileWidth: number;
  tileHeight: number;
  /** Top-left corner of every tile in the detailed map, row by row. */
  tiles: { x: number; y: number }[];
}

/** The grid for a model output of `w x h` and `n x n` tiles: the tiles are spread evenly and the outer ones touch the picture's border. */
export function tileLayout(w: number, h: number, n: number): TileLayout {
  const count = Math.max(1, Math.round(n));
  if (count === 1) return { n: 1, width: w, height: h, tileWidth: w, tileHeight: h, tiles: [{ x: 0, y: 0 }] };
  const s = tileScale(count);
  const width = Math.max(w + 1, Math.round(w * s));
  const height = Math.max(h + 1, Math.round(h * s));
  const tiles: { x: number; y: number }[] = [];
  for (let ty = 0; ty < count; ty++) {
    for (let tx = 0; tx < count; tx++) tiles.push({ x: Math.round((tx * (width - w)) / (count - 1)), y: Math.round((ty * (height - h)) / (count - 1)) });
  }
  return { n: count, width, height, tileWidth: w, tileHeight: h, tiles };
}

/** The part of a `srcWidth x srcHeight` picture a tile covers (whole pixels, inside the picture). */
export function tileCrop(layout: TileLayout, tile: { x: number; y: number }, srcWidth: number, srcHeight: number): { x: number; y: number; width: number; height: number } {
  const width = Math.max(1, Math.min(srcWidth, Math.round((layout.tileWidth * srcWidth) / layout.width)));
  const height = Math.max(1, Math.min(srcHeight, Math.round((layout.tileHeight * srcHeight) / layout.height)));
  const x = Math.max(0, Math.min(srcWidth - width, Math.round((tile.x * srcWidth) / layout.width)));
  const y = Math.max(0, Math.min(srcHeight - height, Math.round((tile.y * srcHeight) / layout.height)));
  return { x, y, width, height };
}

/** Cut a rectangle out of RGBA bytes. */
export function cropRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, rect: { x: number; y: number; width: number; height: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * width + rect.x) * 4;
    out.set(rgba.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

/**
 * Plain least squares `scale * cur + shift ~ ref` over (a sample of) all pixels. Unlike `alignAffine` (frame to frame, where part of the
 * picture may really have changed) nothing is trimmed: base and tile show the same thing at the same moment, and every pixel counts.
 * A tile that cannot be related to the base (flat, or its depth runs the other way) gets scale 0: it then adds nothing and the base shows.
 */
export function fitAffine(ref: ArrayLike<number>, cur: ArrayLike<number>, maxSamples = 65536): Affine {
  const n = Math.min(ref.length, cur.length);
  const step = Math.max(1, Math.floor(n / maxSamples));
  let m = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += step) {
    if (!Number.isFinite(ref[i]) || !Number.isFinite(cur[i])) continue;
    mx += cur[i];
    my += ref[i];
    m++;
  }
  if (!m) return { scale: 0, shift: 0 };
  mx /= m;
  my /= m;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += step) {
    if (!Number.isFinite(ref[i]) || !Number.isFinite(cur[i])) continue;
    const dx = cur[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ref[i] - my);
  }
  const scale = sxx > 1e-12 * m ? Math.max(0, sxy / sxx) : 0;
  return { scale, shift: my - scale * mx };
}

/** A blur close to a Gaussian: `passes` box means of `radius` pixels in each direction, edges repeated. Returns a new array. */
export function boxBlur(src: Float32Array, width: number, height: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(0, Math.round(radius));
  const a = Float32Array.from(src);
  if (r < 1) return a;
  const b = new Float32Array(a.length);
  const line = (from: Float32Array, to: Float32Array, start: number, stride: number, len: number) => {
    // running sum over a window of 2r + 1, the ends of the line repeated
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += from[start + Math.min(len - 1, Math.max(0, k)) * stride];
    const inv = 1 / (2 * r + 1);
    for (let i = 0; i < len; i++) {
      to[start + i * stride] = sum * inv;
      sum += from[start + Math.min(len - 1, i + r + 1) * stride] - from[start + Math.max(0, i - r) * stride];
    }
  };
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) line(a, b, y * width, 1, width);
    for (let x = 0; x < width; x++) line(b, a, x, width, height);
  }
  return a;
}

/**
 * Cross-fade weights of one tile, as a row and a column (the weight of a pixel is `wx[x] * wy[y]`): 1 in the middle, a ramp over the
 * strip it shares with its neighbour, and NO ramp on a side that is the picture's border (nothing else covers those pixels).
 */
export function featherWeights(layout: TileLayout, tile: { x: number; y: number }): { wx: Float32Array; wy: Float32Array } {
  const axis = (pos: number, size: number, total: number): Float32Array => {
    const w = new Float32Array(size).fill(1);
    if (layout.n <= 1) return w;
    const overlap = Math.max(1, Math.round(size - (total - size) / (layout.n - 1)));
    for (let i = 0; i < Math.min(size, overlap); i++) {
      const t = (i + 0.5) / overlap;
      if (pos > 0) w[i] *= t;
      if (pos + size < total) w[size - 1 - i] *= t;
    }
    return w;
  };
  return { wx: axis(tile.x, layout.tileWidth, layout.width), wy: axis(tile.y, layout.tileHeight, layout.height) };
}

/** Radius of the wide blur that splits "large shapes, from the base" from "detail, from the tile", in tile pixels. */
export function mergeRadius(layout: TileLayout): number {
  return Math.max(2, Math.round(Math.max(layout.tileWidth, layout.tileHeight) / 12));
}

/**
 * The detailed map: the base enlarged to the layout's size, with every tile's fine detail laid over it (see the top of the file).
 * `base` is the whole-picture output (`tileWidth x tileHeight`), `tiles[i]` the output for `layout.tiles[i]` at the same size.
 * The result is in the BASE's units, so everything after it (frame-to-frame alignment, the clip range, smoothing in time) works as before.
 */
export function mergeTiles(base: Float32Array, layout: TileLayout, tiles: readonly Float32Array[]): { data: Float32Array; affines: Affine[] } {
  const { width: W, height: H, tileWidth: w, tileHeight: h } = layout;
  const up = resizeChannels(base, w, h, W, H, 1);
  if (layout.n <= 1) return { data: up, affines: [] };
  const acc = new Float32Array(W * H);
  const wsum = new Float32Array(W * H);
  const ref = new Float32Array(w * h);
  const diff = new Float32Array(w * h);
  const radius = mergeRadius(layout);
  const affines: Affine[] = [];
  layout.tiles.forEach((tile, k) => {
    const t = tiles[k];
    for (let y = 0; y < h; y++) ref.set(up.subarray((tile.y + y) * W + tile.x, (tile.y + y) * W + tile.x + w), y * w);
    const aff = fitAffine(ref, t);
    affines.push(aff);
    for (let i = 0; i < w * h; i++) diff[i] = ref[i] - (aff.scale * t[i] + aff.shift);
    const slow = boxBlur(diff, w, h, radius);
    const { wx, wy } = featherWeights(layout, tile);
    for (let y = 0; y < h; y++) {
      const row = (tile.y + y) * W + tile.x;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const wt = wx[x] * wy[y];
        acc[row + x] += wt * (aff.scale * t[i] + aff.shift + slow[i]);
        wsum[row + x] += wt;
      }
    }
  });
  // every pixel is covered by at least one tile with a weight above zero; the base is the answer if rounding ever leaves a gap
  for (let i = 0; i < acc.length; i++) acc[i] = wsum[i] > 1e-6 ? acc[i] / wsum[i] : up[i];
  return { data: acc, affines };
}
