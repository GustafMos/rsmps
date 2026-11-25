import { describe, expect, it } from 'vitest';
import { STYLE_AI_MODEL } from './style-ai-bridge';
import { adainMix, colourBy, featureStats, joinFrame, mixStats, styleStages, styleTiles, whitenMix, type StyleStats } from './style-ai-math';
import {
  STYLE_LOOKS,
  crawlCycles,
  crawlField,
  describeCells,
  encodeMaterial,
  matchBasis,
  matchCells,
  materialOrigins,
  materialTiles,
  paintStyleFrame,
  seeded,
  styleLook,
  styleRecipe,
  styleScratch,
  swapCells,
} from './style-ai-swap';

// A small stand-in for the model's feature maps: 6 maps of 8 x 8 cells.
const C = 6;
const S = 8;
const N = S * S;
const D = 4;

/** Feature maps where every cell is clearly one of a few "materials" (a direction over the maps), in a given layout. */
function featuresOf(kind: (x: number, y: number) => number, seed = 1, noise = 0.05): Float32Array {
  const rnd = seeded(seed);
  const f = new Float32Array(C * N);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const k = kind(x, y);
      for (let c = 0; c < C; c++) f[c * N + y * S + x] = (c === k ? 4 : 0) + (c === (k + 1) % C ? 1.5 : 0) + rnd() * noise;
    }
  return f;
}
const stats = (f: Float32Array) => featureStats([f], S, S, C, S);
const unit: StyleStats = { mean: new Float32Array(C), std: new Float32Array(C).fill(1) };

describe('style swap: the short form cells are compared by', () => {
  it('the random numbers are the same for the same seed', () => {
    const a = seeded(7);
    const b = seeded(7);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seeded(8)()).not.toBe(xs[0]);
  });

  it('the basis is a set of directions of length 1 at right angles, the same on every call', () => {
    const f = featuresOf((x, y) => (x + 2 * y) % 5);
    const st = stats(f);
    const basis = matchBasis([f], st, S, S, D, C, S);
    for (let i = 0; i < D; i++)
      for (let j = 0; j <= i; j++) {
        let dot = 0;
        for (let c = 0; c < C; c++) dot += basis[i * C + c] * basis[j * C + c];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 5);
      }
    expect([...matchBasis([f], st, S, S, D, C, S)]).toEqual([...basis]);
  });

  it('the first direction is the one the features vary along most', () => {
    // Two maps move together strongly, the others carry only a little noise.
    const rnd = seeded(3);
    const f = new Float32Array(C * N);
    for (let i = 0; i < N; i++) {
      const v = rnd() * 2 - 1;
      f[i] = 5 * v;
      f[N + i] = -5 * v;
      for (let c = 2; c < C; c++) f[c * N + i] = rnd() * 0.01;
    }
    // Compared as they are (no bringing to spread 1, which would make every map count the same).
    const basis = matchBasis([f], unit, S, S, 2, C, S);
    expect(Math.abs(basis[0])).toBeCloseTo(Math.SQRT1_2, 2);
    expect(basis[0] * basis[1]).toBeLessThan(0);
    for (let c = 2; c < C; c++) expect(Math.abs(basis[c])).toBeLessThan(0.02);
  });

  it('a flat picture (no direction at all) still gives a usable basis instead of NaN', () => {
    const f = new Float32Array(C * N).fill(0.5);
    const basis = matchBasis([f], stats(f), S, S, D, C, S);
    expect(basis.every((v) => Number.isFinite(v))).toBe(true);
    const cells = describeCells(f, stats(f), basis, new Float32Array(N * D), D, C, N);
    expect(cells.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('a described cell has length 1, so the product of two cells is their cosine', () => {
    const f = featuresOf((x) => x % 6);
    const st = stats(f);
    const d = describeCells(f, st, matchBasis([f], st, S, S, D, C, S), new Float32Array(N * D), D, C, N);
    for (const i of [0, 9, 63]) {
      let len = 0;
      for (let k = 0; k < D; k++) len += d[i * D + k] ** 2;
      expect(len).toBeCloseTo(1, 4);
    }
    // cells of the same material point the same way, of another material not
    const dot = (i: number, j: number) => {
      let v = 0;
      for (let k = 0; k < D; k++) v += d[i * D + k] * d[j * D + k];
      return v;
    };
    expect(dot(0, 6)).toBeGreaterThan(0.95);
    expect(dot(0, 1)).toBeLessThan(0.5);
  });
});

describe('style swap: matching and swapping', () => {
  const layoutStyle = (x: number, y: number) => (x < 4 ? (y < 4 ? 0 : 1) : y < 4 ? 2 : 3);
  // No noise: a map that held nothing but noise would be blown up to full size when the features are brought to spread 1.
  const style = featuresOf(layoutStyle, 11, 0);
  const sst = stats(style);
  const basis = matchBasis([style], sst, S, S, D, C, S);
  const sd = describeCells(style, sst, basis, new Float32Array(N * D), D, C, N);
  const describe_ = (f: Float32Array) => describeCells(f, sst, basis, new Float32Array(N * D), D, C, N);

  it('every content cell gets a style cell of its own material, wherever that lies in the style picture', () => {
    // the content has the same four materials in vertical stripes
    const layoutContent = (x: number) => x >> 1;
    const content = featuresOf(layoutContent, 5);
    const idx = matchCells(describe_(content), S, S, [sd], S, S, null, 0, new Int32Array(N), D, S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const j = idx[y * S + x];
        expect(layoutStyle(j % S, Math.floor(j / S))).toBe(layoutContent(x));
      }
  });

  it('only the cells that show the picture are matched, and only against cells that show the style', () => {
    const content = featuresOf((x) => x >> 1, 5);
    const idx = matchCells(describe_(content), 6, 3, [sd], 4, S, null, 0, new Int32Array(N), D, S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const j = idx[y * S + x];
        if (x >= 6 || y >= 3) expect(j).toBe(-1);
        else expect(j % S).toBeLessThan(4);
      }
  });

  it('"pieces" carries on the neighbour’s piece: a picture matched against itself is found whole, not as scattered look-alikes', () => {
    // one material everywhere: every style cell is as good as any other, so without pieces every cell takes the first one
    const flat = featuresOf(() => 2, 21, 0);
    const fst = stats(flat);
    const fb = matchBasis([flat], fst, S, S, D, C, S);
    const fd = describeCells(flat, fst, fb, new Float32Array(N * D), D, C, N);
    const steps = (idx: Int32Array) => {
      let n = 0;
      for (let y = 0; y < S; y++) for (let x = 1; x < S; x++) if (idx[y * S + x] === idx[y * S + x - 1] + 1) n++;
      return n;
    };
    const alone = matchCells(fd, S, S, [fd], S, S, null, 0, new Int32Array(N), D, S);
    const together = matchCells(fd, S, S, [fd], S, S, null, 1, new Int32Array(N), D, S);
    expect(steps(together)).toBeGreaterThan(steps(alone));
    expect(steps(together)).toBeGreaterThanOrEqual(40);
  });

  it('a preference for some style cells (the crawl) moves the choice to them, within the same material', () => {
    const content = featuresOf(() => 0, 5, 0);
    const bias = new Float32Array(N);
    bias[2 * S + 1] = 0.2; // a cell of material 0 (top left quarter)
    bias[6 * S + 6] = 0.2; // a cell of material 3: similarity is far lower, the preference is not enough
    const idx = matchCells(describe_(content), S, S, [sd], S, S, bias, 0, new Int32Array(N), D, S);
    expect([...idx].every((j) => j === 2 * S + 1)).toBe(true);
  });

  it('with several style tiles the answer says which tile', () => {
    const other = featuresOf(() => 4, 9);
    const od = describe_(other);
    const content = featuresOf(() => 4, 6);
    const idx = matchCells(describe_(content), S, S, [sd, od], S, S, null, 0, new Int32Array(N), D, S);
    expect([...idx].every((j) => j >= N && j < 2 * N)).toBe(true);
  });

  it('swapping puts the style’s own cells in place, by the amount; the mirrored filling repeats the picture’s cells', () => {
    const base = new Float32Array(C * N).fill(1);
    const idx = new Int32Array(N).fill(-1);
    // a picture of 4 x 4 cells in the tile: cell (x, y) takes the style cell (y, x)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) idx[y * S + x] = x * S + y;
    const full = swapCells(base, idx, [style], 4, 4, 1, new Float32Array(C * N), C, S);
    const half = swapCells(base, idx, [style], 4, 4, 0.5, new Float32Array(C * N), C, S);
    for (const c of [0, 3]) {
      expect(full[c * N + 1 * S + 3]).toBe(style[c * N + 3 * S + 1]);
      expect(half[c * N + 1 * S + 3]).toBeCloseTo((1 + style[c * N + 3 * S + 1]) / 2, 5);
      // cell (5, 0) is filling: the mirror image of (1, 0)... (4 5 6 = 2 1 0)
      expect(full[c * N + 5]).toBe(full[c * N + 1]);
      expect(full[c * N + 6 * S]).toBe(full[c * N]);
    }
    expect([...swapCells(base, idx, [style], 4, 4, 0, new Float32Array(C * N), C, S)]).toEqual([...base]);
  });

  it('the squares the style picture is looked at through: one in the middle, or two spread out, never more', () => {
    expect(materialOrigins(288)).toEqual([0]);
    expect(materialOrigins(512)).toEqual([0]);
    expect(materialOrigins(576)).toEqual([32]);
    expect(materialOrigins(1024)).toEqual([0, 512]);
    expect(materialOrigins(1792)).toEqual([0, 1280]);
    expect(materialTiles(1024, 576)).toEqual([{ x: 0, y: 32 }, { x: 512, y: 32 }]);
    expect(materialTiles(256, 144).length).toBe(1);
  });
});

describe('style swap: crawl', () => {
  it('turns a whole number of times over the project, at least once', () => {
    expect(crawlCycles(0.5)).toBe(1);
    expect(crawlCycles(8)).toBe(2);
    expect(crawlCycles(14)).toBe(4);
    expect(Number.isInteger(crawlCycles(13.3))).toBe(true);
  });

  it('amount 0 is no preference at all; the field is bounded by the amount', () => {
    const out = new Float32Array(N).fill(9);
    expect([...crawlField(0.3, 0, 2, 1, out, S)].every((v) => v === 0)).toBe(true);
    for (const amount of [0.5, 1]) {
      const f = crawlField(0.3, amount, 2, 1, new Float32Array(N), S);
      expect(Math.max(...[...f].map(Math.abs))).toBeLessThanOrEqual(amount * amount * 0.24 + 1e-6);
      expect(Math.max(...[...f].map(Math.abs))).toBeGreaterThan(0.01 * amount);
    }
  });

  it('the end of the loop is its beginning, and in between it is something else', () => {
    for (const cycles of [1, 3]) {
      const at = (phase: number) => [...crawlField(phase, 1, cycles, 2, new Float32Array(2 * N), S)];
      const a = at(0);
      const b = at(1);
      const mid = at(0.37);
      expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThan(1e-5);
      expect(Math.max(...a.map((v, i) => Math.abs(v - mid[i])))).toBeGreaterThan(0.05);
      // one frame of a 48 frame loop further is a small step, not a jump
      const next = at(1 / 48);
      expect(Math.max(...a.map((v, i) => Math.abs(v - next[i])))).toBeLessThan(0.12);
    }
  });

  it('the tiles of a style picture do not get the same field', () => {
    const f = crawlField(0.2, 1, 1, 2, new Float32Array(2 * N), S);
    expect([...f.subarray(0, N)]).not.toEqual([...f.subarray(N)]);
  });
});

describe('looks and staging', () => {
  const custom = { look: 'custom', material: 0.4, pieces: 0.2, push: 1.5, passes: 3, crawl: 0.1 };

  it('a named look ignores the custom numbers; Custom uses them, cut to their ranges', () => {
    expect(styleLook({ ...custom, look: 'painterly' })).toEqual(STYLE_LOOKS.painterly);
    expect(styleLook({ ...custom, look: 'hallucination' })).toEqual(STYLE_LOOKS.hallucination);
    expect(styleLook(custom)).toEqual({ material: 0.4, pieces: 0.2, push: 1.5, passes: 3, crawl: 0.1 });
    expect(styleLook({ ...custom, material: 7, passes: 9, push: -1 })).toMatchObject({ material: 1, passes: 3, push: 0 });
    // the mildest look swaps nothing and runs once; the strongest swaps everything, more than once, and moves
    expect(STYLE_LOOKS.painterly).toMatchObject({ material: 0, passes: 1, crawl: 0, push: 1 });
    expect(STYLE_LOOKS.hallucination.material).toBe(1);
    expect(STYLE_LOOKS.hallucination.passes).toBeGreaterThan(1);
    expect(STYLE_LOOKS.hallucination.crawl).toBeGreaterThan(0);
  });

  it('Painterly between two pictures is exactly the staging the node always had', () => {
    for (const t of [0, 0.1, 0.3, 0.5, 0.77, 1]) {
      const st = styleStages(t);
      expect(styleRecipe(t, 'pair', STYLE_LOOKS.painterly)).toEqual({ shape: st.shape, lead: st.lead, swap: 0, passes: 1, crawl: 0 });
    }
  });

  it('between two pictures: nothing at A, B’s own features at B, and with the swap the shapes of B come later', () => {
    for (const look of [STYLE_LOOKS.material, STYLE_LOOKS.hallucination, { material: 0.5, pieces: 0, push: 2, passes: 3, crawl: 1 }]) {
      expect(styleRecipe(0, 'pair', look)).toEqual({ shape: 0, lead: 0, swap: 0, passes: 1, crawl: look.crawl });
      // shape 1, statistics exactly B's (not over-applied), no wandering: B painted with B
      expect(styleRecipe(1, 'pair', look)).toMatchObject({ shape: 1, lead: 1, passes: 1, crawl: 0 });
    }
    const mid = styleRecipe(0.5, 'pair', STYLE_LOOKS.hallucination);
    expect(mid.shape).toBe(0);
    expect(mid.swap).toBe(1);
    expect(mid.passes).toBe(STYLE_LOOKS.hallucination.passes);
    expect(mid.lead).toBeCloseTo(STYLE_LOOKS.hallucination.push, 6);
    expect(styleStages(0.5).shape).toBeCloseTo(0.5, 9);
    // shapes never go back
    let last = 0;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const s = styleRecipe(t, 'pair', STYLE_LOOKS.material).shape;
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('with a Style picture: A and B are untouched at the ends and fully the style’s in the middle', () => {
    const look = STYLE_LOOKS.hallucination;
    for (const t of [0, 1]) expect(styleRecipe(t, 'style', look)).toMatchObject({ lead: 0, swap: 0, passes: 1 });
    expect(styleRecipe(0, 'style', look).shape).toBe(0);
    expect(styleRecipe(1, 'style', look).shape).toBe(1);
    expect(styleRecipe(0.5, 'style', look)).toMatchObject({ swap: 1, passes: look.passes, crawl: look.crawl });
    expect(styleRecipe(0.5, 'style', look).lead).toBeCloseTo(look.push, 6);
    // the same going in and coming out
    expect(styleRecipe(0.2, 'style', look).swap).toBeCloseTo(styleRecipe(0.8, 'style', look).swap, 6);
  });

  it('held: the whole look on every frame', () => {
    const look = STYLE_LOOKS.hallucination;
    for (const t of [0, 0.5, 1]) expect(styleRecipe(t, 'hold', look)).toEqual({ shape: 0, lead: look.push, swap: 1, passes: look.passes, crawl: look.crawl });
  });
});

describe('the two halves of AdaIN, and statistics in between', () => {
  it('whitenMix then colourBy is adainMix', () => {
    const fa = featuresOf((x) => x % 3, 2);
    const fb = featuresOf((x, y) => (x + y) % 4, 3);
    const sa = stats(fa);
    const sb = stats(fb);
    for (const [shape, lead] of [[0, 1], [0.3, 0.6], [1, 1]]) {
      const want = adainMix(shape < 1 ? fa : null, shape > 0 ? fb : null, sa, sb, shape, lead, new Float32Array(C * N), C, S);
      const z = whitenMix(shape < 1 ? fa : null, shape > 0 ? fb : null, sa, sb, shape, new Float32Array(C * N), C, S);
      const got = colourBy(z, mixStats(sa, sb, lead), new Float32Array(C * N), C, S);
      for (let i = 0; i < want.length; i += 7) expect(got[i]).toBeCloseTo(want[i], 4);
    }
  });

  it('statistics can be over-applied, and a spread never reaches zero', () => {
    const a: StyleStats = { mean: Float32Array.of(1, 0), std: Float32Array.of(1, 1) };
    const b: StyleStats = { mean: Float32Array.of(3, 0), std: Float32Array.of(0.5, 2) };
    expect([...mixStats(a, b, 0.5).mean]).toEqual([2, 0]);
    expect([...mixStats(a, b, 2).mean]).toEqual([5, 0]);
    expect(mixStats(a, b, 2).std[0]).toBeCloseTo(0.001, 6);
    expect(mixStats(a, b, 2).std[1]).toBe(3);
  });
});

describe('painting one frame (a stand-in for the networks: the encoder shrinks by 8, the decoder enlarges by 8)', () => {
  const T = STYLE_AI_MODEL.tile;
  const CELLS = T / STYLE_AI_MODEL.stride;
  const cells = CELLS * CELLS;
  const n = T * T;
  const log = { encodes: 0, decodes: 0 };
  const engine = {
    async encode(rgb: Float32Array) {
      log.encodes++;
      const out = new Float32Array(STYLE_AI_MODEL.channels * cells);
      for (let c = 0; c < 3; c++) for (let y = 0; y < CELLS; y++) for (let x = 0; x < CELLS; x++) out[c * cells + y * CELLS + x] = rgb[c * n + y * 8 * T + x * 8];
      return out;
    },
    async decode(f: Float32Array) {
      log.decodes++;
      const out = new Float32Array(3 * n);
      for (let c = 0; c < 3; c++) for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) out[c * n + y * T + x] = f[c * cells + (y >> 3) * CELLS + (x >> 3)];
      return out;
    },
  };
  const W = 512;
  const H = 256;
  const picture = (fn: (x: number, y: number) => [number, number, number], w = W, h = H) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...fn(x, y), 255], (y * w + x) * 4);
    return px;
  };

  it('the swap builds the picture from the style’s colours only; passes cost two runs each and a fraction of a pass is a blend', async () => {
    const scratch = styleScratch();
    const tiles = styleTiles(W, H);
    // content: dark left, bright right. style: stripes of pure red and pure blue.
    const a = { feats: [await engine.encode(new Float32Array(3 * n).map((_, i) => ((i % T) < 256 ? 0.2 : 0.8)))], stats: null as unknown as StyleStats };
    a.stats = featureStats(a.feats, W / 8, H / 8);
    const material = await encodeMaterial(engine, picture((x) => ((x >> 5) % 2 ? [255, 0, 0] : [0, 0, 255])), W, H, scratch.input);
    expect([material.cw, material.ch, material.feats.length]).toEqual([64, 32, 1]);
    const run = async (passes: number) => {
      log.encodes = log.decodes = 0;
      const out = await paintStyleFrame({ engine, width: W, height: H, tiles, a, b: null, base: a.stats, material, recipe: { shape: 0, lead: 1, swap: 1, passes, crawl: 0 }, pieces: 0, bias: null, scratch });
      return { rgb: joinFrame(out.acc, out.weight, null, 0), runs: out.runs, ...log };
    };
    const one = await run(1);
    expect([one.runs, one.encodes, one.decodes]).toEqual([1, 0, 1]);
    // every pixel is one of the style's two colours: red or blue, never the content's grey
    for (const i of [0, 100 * W + 30, 200 * W + 400, 255 * W + 511]) {
      const [r, g, b] = [one.rgb[i * 3], one.rgb[i * 3 + 1], one.rgb[i * 3 + 2]];
      expect(g).toBeCloseTo(0, 5);
      expect(Math.abs(r - b)).toBeCloseTo(1, 5);
    }
    // the content's two halves took different material
    expect(one.rgb[(100 * W + 30) * 3]).not.toBe(one.rgb[(100 * W + 400) * 3]);
    const two = await run(2);
    expect([two.runs, two.encodes, two.decodes]).toEqual([3, 1, 2]);
    const between = await run(1.25);
    expect(between.runs).toBe(3);
    for (const i of [5, 3000, 90000]) expect(between.rgb[i]).toBeCloseTo(one.rgb[i] + (two.rgb[i] - one.rgb[i]) * 0.25, 5);
    // the short forms of the material are made once and kept
    expect(material.desc?.length).toBe(1);
  });
});
