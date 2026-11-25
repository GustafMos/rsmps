/**
 * The strong half of the AI Style Transfer node: STYLE SWAP (Chen & Schmidt 2016, "Fast Patch-based Style Transfer of Arbitrary
 * Style"), done between the two networks we already have, plus what makes it move.
 *
 * AdaIN (lib/style-ai-math.ts) only gives the content's features the mean and spread of the style's: a tinted, softly repainted
 * version of the content. Style swap REPLACES every feature cell of the content by the most similar feature cell of the style picture
 * and decodes that: the picture is then literally assembled from pieces of the style picture, laid out along the content's shapes.
 *
 *  - MATCHING is on directions, not sizes (cosine similarity), after both pictures' features were brought to mean 0 and spread 1, so
 *    "what is where" is compared and not how bright or contrasty each picture is.
 *  - 512 numbers per cell are far more than the comparison needs, and 4096 x 4096 comparisons of 512 numbers would take many seconds.
 *    The features are therefore first projected on the style picture's own main directions (its first principal components):
 *    `matchBasis`. Only the comparison uses the short form; the cells that are copied are the full ones.
 *  - PIECES: a cell may continue the piece its left or upper neighbour took (the next cell of the style picture) when that is nearly
 *    as good as its own best match. Whole patches of the style picture then arrive in one piece instead of as confetti.
 *  - CRAWL: a slow wave of preference that travels over the style picture and turns in whole cycles per loop. Cells keep changing
 *    their mind about which piece they take, so the texture swarms instead of sticking, and the loop still closes.
 *
 * Also here: the LOOKS (which of all this a named look uses), the staging of a transition with them, and `paintStyleFrame`, which
 * paints one frame with whatever engine it is handed (the real networks in the app, a fake in the tests).
 *
 * No GPU and no model in this file: everything is plain arithmetic on typed arrays and is unit-tested.
 */
import { STYLE_AI_MODEL, type StyleEngine } from './style-ai-bridge';
import { addTile, colourBy, featureStats, joinFrame, mirror, mixStats, packTile, styleStages, toRgba, whitenMix, type StyleStats, type StyleTile } from './style-ai-math';

const TILE = STYLE_AI_MODEL.tile;
const STRIDE = STYLE_AI_MODEL.stride;
const CELLS = TILE / STRIDE;
const CHANNELS = STYLE_AI_MODEL.channels;

/** How many numbers a cell is compared by. A multiple of 4 (the comparison loop takes four at a time). */
export const MATCH_DIMS = 32;

/** A small repeatable random number generator (mulberry32): the same seed gives the same painting on every computer. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Where the material comes from                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Where the 512 pixel squares are taken from along one side of the style picture. Unlike the content (which must be covered, with
 * overlaps, to be put together again) the style is only looked at, so the squares are spread without overlap and there are at most
 * `max` of them: one in the middle when the side is not much longer than a square.
 */
export function materialOrigins(size: number, max = 2): number[] {
  if (size <= TILE) return [0];
  const n = Math.min(max, Math.max(1, Math.round(size / TILE)));
  const snap = (v: number) => Math.round(v / STRIDE) * STRIDE;
  if (n === 1) return [snap((size - TILE) / 2)];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(snap((i * (size - TILE)) / (n - 1)));
  return out;
}

/** The squares of a style picture of this size, row by row. */
export function materialTiles(width: number, height: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const y of materialOrigins(height)) for (const x of materialOrigins(width)) out.push({ x, y });
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The short form the cells are compared by                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The `dims` main directions of the style picture's features (principal components of the features brought to mean 0 and spread 1),
 * as `dims` rows of `channels` numbers, each of length 1 and at right angles to the others. Found by repeated multiplication with the
 * covariance (subspace iteration), which needs no library and settles in a few rounds because these features have a few very
 * strong directions. Deterministic. Only the cells that show the picture count, and of many cells every second or third.
 */
export function matchBasis(tiles: readonly Float32Array[], stats: StyleStats, cellsW: number, cellsH: number, dims: number = MATCH_DIMS, channels: number = CHANNELS, cells: number = CELLS): Float32Array {
  const n = cells * cells;
  const cw = Math.min(cells, Math.max(1, cellsW));
  const ch = Math.min(cells, Math.max(1, cellsH));
  const step = Math.max(1, Math.ceil(Math.sqrt((cw * ch * tiles.length) / 1200)));
  const picks: number[] = [];
  for (let y = 0; y < ch; y += step) for (let x = 0; x < cw; x += step) picks.push(y * cells + x);
  const m = picks.length * tiles.length;
  // The samples, one row per cell, already at mean 0 and spread 1.
  const z = new Float32Array(m * channels);
  tiles.forEach((f, t) => {
    for (let c = 0; c < channels; c++) {
      const k = 1 / stats.std[c];
      const mean = stats.mean[c];
      const o = c * n;
      for (let s = 0; s < picks.length; s++) z[(t * picks.length + s) * channels + c] = (f[o + picks[s]] - mean) * k;
    }
  });
  const d = Math.min(dims, channels);
  const rnd = seeded(0x51ed270b);
  const q = new Float64Array(d * channels);
  for (let i = 0; i < q.length; i++) q[i] = rnd() - 0.5;
  const proj = new Float64Array(m);
  const next = new Float64Array(d * channels);
  const ortho = (a: Float64Array) => {
    for (let i = 0; i < d; i++) {
      const oi = i * channels;
      for (let attempt = 0; attempt < 4; attempt++) {
        // Gram-Schmidt, twice: once is not exact enough when two directions are nearly the same.
        for (let twice = 0; twice < 2; twice++) {
          for (let j = 0; j < i; j++) {
            const oj = j * channels;
            let dot = 0;
            for (let c = 0; c < channels; c++) dot += a[oi + c] * a[oj + c];
            for (let c = 0; c < channels; c++) a[oi + c] -= dot * a[oj + c];
          }
        }
        let len = 0;
        for (let c = 0; c < channels; c++) len += a[oi + c] * a[oi + c];
        len = Math.sqrt(len);
        if (len > 1e-9) {
          for (let c = 0; c < channels; c++) a[oi + c] /= len;
          break;
        }
        // Nothing left of it (the picture has fewer directions than asked for, e.g. a flat colour): any other direction will do.
        for (let c = 0; c < channels; c++) a[oi + c] = rnd() - 0.5;
      }
    }
  };
  ortho(q);
  // Multiplying by the covariance = project every sample on the direction, then sum the samples by that projection (no 512 x 512 table needed).
  for (let round = 0; round < 7; round++) {
    for (let i = 0; i < d; i++) {
      const oi = i * channels;
      for (let s = 0; s < m; s++) {
        const os = s * channels;
        let dot = 0;
        for (let c = 0; c < channels; c++) dot += z[os + c] * q[oi + c];
        proj[s] = dot;
      }
      for (let c = 0; c < channels; c++) next[oi + c] = 0;
      for (let s = 0; s < m; s++) {
        const os = s * channels;
        const p = proj[s];
        if (p === 0) continue;
        for (let c = 0; c < channels; c++) next[oi + c] += z[os + c] * p;
      }
    }
    q.set(next);
    ortho(q);
  }
  const out = new Float32Array(dims * channels);
  out.set(q);
  return out;
}

/**
 * Every cell of a feature map in the short form: `dims` numbers per cell (cell after cell), each cell of length 1 so that a plain
 * product of two cells is their cosine similarity. `stats` brings the features to mean 0 and spread 1 first; pass null when they
 * already are. A cell with nothing in it stays all zero (it then matches nothing in particular).
 */
export function describeCells(f: Float32Array, stats: StyleStats | null, basis: Float32Array, out: Float32Array, dims: number = MATCH_DIMS, channels: number = CHANNELS, n: number = CELLS * CELLS): Float32Array {
  const row = new Float32Array(n);
  for (let d = 0; d < dims; d++) {
    row.fill(0);
    let offset = 0;
    for (let c = 0; c < channels; c++) {
      const w = basis[d * channels + c];
      if (w === 0) continue;
      const k = stats ? w / stats.std[c] : w;
      if (stats) offset += k * stats.mean[c];
      const o = c * n;
      for (let i = 0; i < n; i++) row[i] += k * f[o + i];
    }
    for (let i = 0; i < n; i++) out[i * dims + d] = row[i] - offset;
  }
  for (let i = 0; i < n; i++) {
    const o = i * dims;
    let len = 0;
    for (let d = 0; d < dims; d++) len += out[o + d] * out[o + d];
    if (len > 1e-20) {
      const k = 1 / Math.sqrt(len);
      for (let d = 0; d < dims; d++) out[o + d] *= k;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Crawl                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * How often the crawl turns over the whole project: about `perSecond` times a second, but a WHOLE number of times (at least one),
 * so the last frame of a loop leads into the first.
 */
export function crawlCycles(seconds: number, perSecond = 0.25): number {
  return Math.max(1, Math.round(Math.max(0, seconds) * perSecond));
}

/**
 * The crawl: for every cell of the style picture, how much it is preferred at this moment (added to its similarity with whatever
 * asks). Four waves travel over the style picture in different directions; `phase` is the position in the project (0..1) and every
 * wave turns a whole number of times over it, so phase 0 and phase 1 are the same field. `amount` 0 = no preference (all zero).
 * One tile's cells after the other; the tiles lie side by side in the field so their waves differ.
 */
export function crawlField(phase: number, amount: number, cycles: number, tiles: number, out: Float32Array, cells: number = CELLS): Float32Array {
  const n = cells * cells;
  if (!(amount > 0)) return out.fill(0, 0, tiles * n);
  const rnd = seeded(0x0c4a71);
  const k = Math.max(1, Math.round(cycles));
  const waves: { ux: number; uy: number; turn: number; shift: number }[] = [];
  for (let w = 0; w < 4; w++) {
    const angle = rnd() * Math.PI * 2;
    // Wavelengths of 5 to 14 cells: pieces of 40 to 110 pixels of the style picture come into favour together.
    const length = 5 + rnd() * 9;
    waves.push({ ux: Math.cos(angle) / length, uy: Math.sin(angle) / length, turn: k * (w % 2 ? -1 : 1) * (1 + (w >> 1)), shift: rnd() });
  }
  // Small on purpose: many cells of a style picture are nearly as good as the best one, so a little preference already moves a lot.
  const gain = (amount * amount * 0.24) / waves.length;
  for (let t = 0; t < tiles; t++) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        let v = 0;
        for (const w of waves) v += Math.cos(2 * Math.PI * (w.ux * (x + t * 37) + w.uy * (y + t * 11) + w.turn * phase + w.shift));
        out[t * n + y * cells + x] = v * gain;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Matching and swapping                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * For every cell of the content (only the `cw x ch` cells that show the picture), the cell of the style picture that resembles it
 * most. `content` and every entry of `style` are short forms from `describeCells`; the style may be several tiles, of which the
 * `sw x sh` cells from each corner count. `bias` (from `crawlField`, or null) is added to a style cell's similarity. The answer for
 * content cell i is `out[i]` = tile * cells * cells + cell; cells outside `cw x ch` get -1.
 *
 * `pieces` (0..1) lets a cell continue its left or upper neighbour's piece (the style cell next to the one the neighbour took) when
 * that is no worse than its own best match by more than `pieces * 0.5`: 0 = every cell for itself, 1 = large pieces of the style
 * picture are carried over whole.
 */
export function matchCells(content: Float32Array, cw: number, ch: number, style: readonly Float32Array[], sw: number, sh: number, bias: Float32Array | null, pieces: number, out: Int32Array, dims: number = MATCH_DIMS, cells: number = CELLS): Int32Array {
  const n = cells * cells;
  out.fill(-1);
  const dot = (i: number, s: Float32Array, j: number) => {
    let v = 0;
    const a = i * dims;
    const b = j * dims;
    for (let d = 0; d < dims; d++) v += content[a + d] * s[b + d];
    return v;
  };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cells + x;
      const a = i * dims;
      let best = -Infinity;
      let at = -1;
      for (let t = 0; t < style.length; t++) {
        const s = style[t];
        const bo = t * n;
        for (let sy = 0; sy < sh; sy++) {
          let j = sy * cells;
          let b = j * dims;
          for (let sx = 0; sx < sw; sx++, j++) {
            let v = bias ? bias[bo + j] : 0;
            for (let d = 0; d < dims; d += 4, b += 4) v += content[a + d] * s[b] + content[a + d + 1] * s[b + 1] + content[a + d + 2] * s[b + 2] + content[a + d + 3] * s[b + 3];
            if (v > best) {
              best = v;
              at = bo + j;
            }
          }
        }
      }
      // Continue a neighbour's piece when that costs little. Row by row, so pieces grow to the right and downwards.
      if (pieces > 0) {
        const slack = pieces * 0.5;
        let take = -1;
        let taken = best - slack;
        for (let side = 0; side < 2; side++) {
          const from = side === 0 ? (x > 0 ? out[i - 1] : -1) : y > 0 ? out[i - cells] : -1;
          if (from < 0) continue;
          const t = Math.floor(from / n);
          const j = from - t * n;
          const jx = (j % cells) + (side === 0 ? 1 : 0);
          const jy = Math.floor(j / cells) + (side === 0 ? 0 : 1);
          if (jx >= sw || jy >= sh) continue;
          const cand = jy * cells + jx;
          const v = dot(i, style[t], cand) + (bias ? bias[t * n + cand] : 0);
          if (v >= taken) {
            taken = v;
            take = t * n + cand;
          }
        }
        if (take >= 0) at = take;
      }
      out[i] = at;
    }
  }
  return out;
}

/**
 * Put the style picture's cells in the content's places: `out` = `base` + (the matched style cell - `base`) * `amount`, for all 512
 * maps. `base` is what the cell would be without the swap (the AdaIN features); `amount` 1 = made of the style picture's cells
 * only. The cells outside the picture (the mirrored filling of a tile) repeat the picture's cells mirrored, as the filling itself
 * does. `out` may be `base`.
 */
export function swapCells(base: Float32Array, index: Int32Array, style: readonly Float32Array[], cw: number, ch: number, amount: number, out: Float32Array, channels: number = CHANNELS, cells: number = CELLS): Float32Array {
  const n = cells * cells;
  const k = Math.min(1, Math.max(0, amount));
  // Per cell of the tile: which cell of the picture it shows (itself, or its mirror image), and where that one's material is.
  const tile = new Int32Array(n);
  const cell = new Int32Array(n);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const m = index[mirror(y, ch) * cells + mirror(x, cw)];
      tile[y * cells + x] = m < 0 ? -1 : Math.floor(m / n);
      cell[y * cells + x] = m < 0 ? 0 : m % n;
    }
  }
  for (let c = 0; c < channels; c++) {
    const o = c * n;
    for (let i = 0; i < n; i++) {
      const b = base[o + i];
      out[o + i] = tile[i] < 0 ? b : b + (style[tile[i]][o + cell[i]] - b) * k;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Looks and staging                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What a look is made of. Every look is only a set of these five numbers; "Custom" lets the user set them. */
export interface StyleLook {
  /** 0 = AdaIN only (colours and brush texture), 1 = every cell replaced by a cell of the style picture. */
  material: number;
  /** How readily a cell continues its neighbour's piece of the style picture (0..1). */
  pieces: number;
  /** How far the style's mean and spread are applied: 1 = exactly, above 1 = over-applied. */
  push: number;
  /** How often the result goes through the networks (1..3). */
  passes: number;
  /** How much the choice of pieces wanders from frame to frame (0 = steady). */
  crawl: number;
}

export const STYLE_LOOKS = {
  /** What the node did before it had looks. Old projects keep this one. */
  painterly: { material: 0, pieces: 0, push: 1, passes: 1, crawl: 0 },
  material: { material: 1, pieces: 0.6, push: 1, passes: 1, crawl: 0 },
  hallucination: { material: 1, pieces: 0.8, push: 1.25, passes: 2, crawl: 0.45 },
} as const satisfies Record<string, StyleLook>;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => {
  const k = clamp((v - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

/** The look a node's settings mean: one of the fixed ones, or the custom numbers (cut to their ranges). */
export function styleLook(p: { look: string; material: number; pieces: number; push: number; passes: number; crawl: number }): StyleLook {
  if (p.look === 'painterly' || p.look === 'material' || p.look === 'hallucination') return STYLE_LOOKS[p.look];
  return { material: clamp(p.material, 0, 1), pieces: clamp(p.pieces, 0, 1), push: clamp(p.push, 0, 2), passes: clamp(Math.round(p.passes), 1, 3), crawl: clamp(p.crawl, 0, 1) };
}

/**
 * Who paints whom:
 *  - 'pair'  A is repainted with B, then becomes B (the transition between two pictures);
 *  - 'style' A and B are both repainted with a third picture in the middle of the transition (A, the style's dream, B);
 *  - 'hold'  no transition: A is repainted the whole time.
 */
export type StyleMode = 'pair' | 'style' | 'hold';

export interface StyleRecipe {
  /** Whose shapes: 0 = A's, 1 = B's. */
  shape: number;
  /** How far the statistics go from the content's own to the material's (above 1 = over-applied). */
  lead: number;
  /** How much of each cell is the style picture's cell (0..1). */
  swap: number;
  /** Passes through the networks, with a fraction: 1.5 = half way between the result of one pass and of two. */
  passes: number;
  crawl: number;
}

/**
 * What a frame at progress `t` of the transition is made with. Everything strong fades in from the ends, so that the painting
 * leaves from picture A and arrives at picture B: at `t` 0 a 'pair' or 'style' recipe changes nothing, and at `t` 1 a 'pair' recipe
 * gives B's own features. The 'painterly' look in 'pair' mode is exactly the staging the node always had.
 */
export function styleRecipe(t: number, mode: StyleMode, look: StyleLook): StyleRecipe {
  if (mode === 'hold') return { shape: 0, lead: look.push, swap: look.material, passes: look.passes, crawl: look.crawl };
  const st = styleStages(t);
  const x = clamp(t, 0, 1);
  // 0 at both ends, 1 over the middle part.
  const middle = smooth(0.02, 0.38, x) * smooth(0.02, 0.38, 1 - x);
  if (mode === 'style') return { shape: st.shape, lead: middle * look.push, swap: middle * look.material, passes: 1 + (look.passes - 1) * middle, crawl: look.crawl };
  // Over-applying B's style and wandering between B's pieces must be gone when the shapes are B's: B painted with B is B.
  // With the swap, a cell of B matches itself perfectly, so B would be there the moment its shapes get any say. Its shapes therefore
  // come later the more of the picture is swapped: the middle of the transition is then A, built from pieces of B.
  const shape = st.shape + (smooth(0.5, 0.88, x) - st.shape) * look.material;
  const own = 1 - shape;
  return { shape, lead: st.lead * (1 + (look.push - 1) * own), swap: st.lead * look.material, passes: 1 + (look.passes - 1) * middle, crawl: look.crawl * own };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* One frame                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A picture as the networks see it: the features of its tiles and its statistics. */
export interface StyleFeatures {
  feats: Float32Array[];
  stats: StyleStats;
}

/** The picture the material is taken from: its features, how many cells of each tile show it, and (made when first needed) its short forms. */
export interface StyleMaterial extends StyleFeatures {
  cw: number;
  ch: number;
  basis?: Float32Array;
  desc?: Float32Array[];
}

/** Buffers of the frame painter, made once per job: nothing of this size is allocated per tile. */
export interface StyleScratch {
  z: Float32Array;
  mixed: Float32Array;
  desc: Float32Array;
  index: Int32Array;
  input: Float32Array<ArrayBuffer>;
}

export function styleScratch(): StyleScratch {
  const n = CELLS * CELLS;
  return { z: new Float32Array(CHANNELS * n), mixed: new Float32Array(CHANNELS * n), desc: new Float32Array(n * MATCH_DIMS), index: new Int32Array(n), input: new Float32Array(3 * TILE * TILE) };
}

export interface StyleFrameJob {
  engine: Pick<StyleEngine, 'encode' | 'decode'>;
  signal?: AbortSignal;
  /** Called between runs of the network (the job lets the app breathe there and stops when cancelled). */
  tick?: () => Promise<void>;
  /** The work picture and its tiles. */
  width: number;
  height: number;
  tiles: readonly StyleTile[];
  /** The two contents; null where the recipe gives it no weight. */
  a: StyleFeatures | null;
  b: StyleFeatures | null;
  /** The statistics the frame has where the material has no say yet (`recipe.lead` 0). */
  base: StyleStats;
  material: StyleMaterial;
  recipe: StyleRecipe;
  pieces: number;
  /** From `crawlField`, for the material's tiles; null = steady. */
  bias: Float32Array | null;
  scratch: StyleScratch;
}

/**
 * Paint one frame: the weighted sums of its decoded tiles (`acc`, `weight`: finish with `joinFrame`). Per pass and tile: the content
 * with its style taken out, the material's statistics put on, the cells swapped for the material's, decoded. A further pass takes the
 * picture just painted as its content, which moves the result further from the real picture each time. A fraction of a pass is a
 * blend of the pictures before and after it, so the number of passes can rise smoothly over a transition.
 */
export async function paintStyleFrame(job: StyleFrameJob): Promise<{ acc: Float32Array; weight: Float32Array; runs: number }> {
  const { engine, signal, tiles, width, height, material, recipe, scratch } = job;
  const cw = Math.min(CELLS, width / STRIDE);
  const ch = Math.min(CELLS, height / STRIDE);
  const target = mixStats(job.base, material.stats, recipe.lead);
  const swap = clamp(recipe.swap, 0, 1);
  if (swap > 0 && !material.desc) {
    const basis = matchBasis(material.feats, material.stats, material.cw, material.ch);
    material.basis = basis;
    material.desc = material.feats.map((f) => describeCells(f, material.stats, basis, new Float32Array(CELLS * CELLS * MATCH_DIMS)));
  }
  const passes = clamp(recipe.passes, 1, 3);
  const whole = Math.ceil(passes - 1e-6);
  let content: StyleFeatures | null = null;
  let before: Float32Array | null = null;
  let acc: Float32Array = new Float32Array(0);
  let weight: Float32Array = new Float32Array(0);
  let runs = 0;
  for (let pass = 1; pass <= whole; pass++) {
    if (pass > 1) {
      // The picture just painted becomes the content.
      const rgba = toRgba(joinFrame(acc, weight, null, 0), width, height);
      const feats: Float32Array[] = [];
      for (const tile of tiles) {
        await job.tick?.();
        feats.push(await engine.encode(packTile(rgba, width, height, tile.x, tile.y, scratch.input), signal));
        runs++;
      }
      content = { feats, stats: featureStats(feats, width / STRIDE, height / STRIDE) };
      before = acc;
    }
    acc = new Float32Array(width * height * 3);
    weight = new Float32Array(width * height);
    for (let k = 0; k < tiles.length; k++) {
      await job.tick?.();
      if (content) whitenMix(content.feats[k], null, content.stats, content.stats, 0, scratch.z);
      else whitenMix(job.a && recipe.shape < 1 ? job.a.feats[k] : null, job.b && recipe.shape > 0 ? job.b.feats[k] : null, (job.a ?? job.b)!.stats, (job.b ?? job.a)!.stats, recipe.shape, scratch.z);
      if (swap > 0) {
        describeCells(scratch.z, null, material.basis!, scratch.desc);
        matchCells(scratch.desc, cw, ch, material.desc!, material.cw, material.ch, job.bias, job.pieces, scratch.index);
        colourBy(scratch.z, target, scratch.mixed);
        swapCells(scratch.mixed, scratch.index, material.feats, cw, ch, swap, scratch.mixed);
      } else colourBy(scratch.z, target, scratch.mixed);
      addTile(await engine.decode(scratch.mixed, signal), tiles[k], width, height, acc, weight);
      runs++;
    }
  }
  const part = passes - (whole - 1);
  if (before && part < 1) for (let i = 0; i < acc.length; i++) acc[i] = before[i] + (acc[i] - before[i]) * part;
  return { acc, weight, runs };
}

type Encoder = Pick<StyleEngine, 'encode'>;

/** A content picture (already at the work size) through the encoder, tile by tile. */
export async function encodeContent(engine: Encoder, rgba: Uint8ClampedArray, width: number, height: number, tiles: readonly { x: number; y: number }[], input: Float32Array<ArrayBuffer>, signal?: AbortSignal, tick?: () => Promise<void>): Promise<StyleFeatures> {
  const feats: Float32Array[] = [];
  for (const tile of tiles) {
    await tick?.();
    feats.push(await engine.encode(packTile(rgba, width, height, tile.x, tile.y, input), signal));
  }
  return { feats, stats: featureStats(feats, width / STRIDE, height / STRIDE) };
}

/** The picture the material is taken from (at whatever size "Texture size" made it) through the encoder: at most four squares of it. */
export async function encodeMaterial(engine: Encoder, rgba: Uint8ClampedArray, width: number, height: number, input: Float32Array<ArrayBuffer>, signal?: AbortSignal, tick?: () => Promise<void>): Promise<StyleMaterial> {
  const f = await encodeContent(engine, rgba, width, height, materialTiles(width, height), input, signal, tick);
  return { ...f, cw: Math.min(CELLS, width / STRIDE), ch: Math.min(CELLS, height / STRIDE) };
}
