import { describe, expect, it } from 'vitest';
import { STYLE_AI_MODEL } from './style-ai-bridge';
import { adainMix, addTile, featureStats, joinFrame, mirror, packTile, resizeRgba, styleMix, stylePlan, styleProgress, styleStages, styleTileCount, styleTiles, styleWorkSize, tileOrigins, toRgba, type StyleTiming } from './style-ai-math';

const T = STYLE_AI_MODEL.tile;
const timing = (o: Partial<StyleTiming> = {}): StyleTiming => ({ drive: 'loop', start: 0.25, length: 0.5, frames: 12, loop: true, ...o });

describe('when: progress of a frame', () => {
  it('A to B over the loop: a looping project starts at A and never shows B itself; a one-way project ends exactly on B', () => {
    expect(styleProgress(0, timing())).toBe(0);
    expect(styleProgress(6, timing())).toBeCloseTo(0.5, 6);
    expect(styleProgress(11, timing())).toBeCloseTo(11 / 12, 6);
    expect(styleProgress(11, timing({ loop: false }))).toBe(1);
    expect(styleProgress(0, timing({ frames: 1, loop: false }))).toBe(0);
  });
  it('A to B and back: B in the middle, A again at the wrap', () => {
    const t = timing({ drive: 'pingpong' });
    expect(styleProgress(0, t)).toBe(0);
    expect(styleProgress(6, t)).toBeCloseTo(1, 6);
    expect(styleProgress(3, t)).toBeCloseTo(0.5, 6);
    expect(styleProgress(9, t)).toBeCloseTo(0.5, 6);
  });
  it('a part of the project: A before it, B after it', () => {
    const t = timing({ drive: 'span' }); // starts at frame 3, six frames long
    expect([0, 3].map((f) => styleProgress(f, t))).toEqual([0, 0]);
    expect(styleProgress(6, t)).toBeCloseTo(0.5, 6);
    expect([9, 11].map((f) => styleProgress(f, t))).toEqual([1, 1]);
    expect(styleProgress(99, t)).toBe(1); // past the end: the last frame
  });
});

describe('when: the frames the network paints', () => {
  it('only the frames strictly between A and B', () => {
    expect(stylePlan(timing({ drive: 'span' }))).toEqual({ first: 4, count: 5 });
    expect(stylePlan(timing())).toEqual({ first: 1, count: 11 });
    expect(stylePlan(timing({ loop: false }))).toEqual({ first: 1, count: 10 });
    // there and back: the B frame in the middle lies inside the range and is simply part of it
    expect(stylePlan(timing({ drive: 'pingpong' }))).toEqual({ first: 1, count: 11 });
  });
  it('nothing to do when no frame lies between', () => {
    expect(stylePlan(timing({ frames: 1 })).count).toBe(0);
    expect(stylePlan(timing({ drive: 'span', start: 1, length: 0.5 })).count).toBe(0);
  });
});

describe('how much', () => {
  it('style leads, shapes follow, both from 0 to 1', () => {
    expect(styleStages(0)).toEqual({ shape: 0, lead: 0 });
    expect(styleStages(1)).toEqual({ shape: 1, lead: 1 });
    const mid = styleStages(0.4);
    expect(mid.lead).toBeGreaterThan(mid.shape);
    expect(styleStages(0.5).lead).toBe(1);
    expect(styleStages(0.3).shape).toBe(0);
    for (let t = 0; t < 1; t += 0.05) expect(styleStages(t + 0.05).shape).toBeGreaterThanOrEqual(styleStages(t).shape);
  });
  it('the painting is not shown at the ends and fully shown in between', () => {
    expect(styleMix(0, 0.15)).toBe(0);
    expect(styleMix(1, 0.15)).toBe(0);
    expect(styleMix(0.5, 0.15)).toBe(1);
    expect(styleMix(0.15, 0.15)).toBe(1);
    expect(styleMix(0.075, 0.15)).toBeCloseTo(0.5, 6);
    expect(styleMix(0.925, 0.15)).toBeCloseTo(0.5, 6);
    expect(styleMix(0.25, 0.5)).toBeCloseTo(0.5, 6); // the longest fade: still 1 in the very middle
    expect(styleMix(0.5, 0.5)).toBe(1);
  });
});

describe('sizes and tiles', () => {
  it('the work picture keeps the shape of the frame, on whole feature cells', () => {
    expect(styleWorkSize(1920, 1080, 512)).toEqual({ width: 512, height: 288 });
    expect(styleWorkSize(1080, 1920, 768)).toEqual({ width: 432, height: 768 });
    expect(styleWorkSize(640, 640, 896)).toEqual({ width: 896, height: 896 });
    expect(styleWorkSize(32, 16, 512)).toEqual({ width: 512, height: 256 });
  });
  it('one tile when the side fits, otherwise as few as cover it with a real overlap', () => {
    expect(tileOrigins(288)).toEqual([0]);
    expect(tileOrigins(512)).toEqual([0]);
    expect(tileOrigins(768)).toEqual([0, 256]);
    expect(tileOrigins(896)).toEqual([0, 384]);
    expect(tileOrigins(1024)).toEqual([0, 256, 512]);
    for (const size of [520, 640, 768, 896, 1024, 1536]) {
      const o = tileOrigins(size);
      expect(o[0]).toBe(0);
      expect(o[o.length - 1]).toBe(size - T);
      for (let i = 1; i < o.length; i++) {
        expect(o[i] % 8).toBe(0);
        expect(o[i - 1] + T - o[i]).toBeGreaterThanOrEqual(96);
      }
    }
  });
  it('says what a frame costs', () => {
    expect(styleTileCount(1920, 1080, 512)).toBe(1);
    expect(styleTileCount(1920, 1080, 768)).toBe(2);
    expect(styleTileCount(1920, 1080, 896)).toBe(2);
    expect(styleTileCount(1080, 1080, 896)).toBe(4);
  });
  it('tile weights: every pixel of the picture is covered, the weights of neighbours add up to 1, the filling counts for nothing', () => {
    for (const [w, h] of [[512, 288], [768, 432], [896, 896]]) {
      const sum = new Float32Array(w);
      const tiles = styleTiles(w, h);
      for (const t of tiles.filter((q) => q.y === 0)) for (let x = 0; x < T; x++) if (t.x + x < w) sum[t.x + x] += t.wx[x];
      for (let x = 0; x < w; x++) expect(sum[x]).toBeCloseTo(1, 5);
      // rows past the picture (mirrored filling) have weight 0
      if (h < T) expect(tiles[0].wy[h]).toBe(0);
      expect(tiles[0].wy[0]).toBe(1);
    }
  });
});

describe('packing', () => {
  it('mirror: the edge pixel is not repeated', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => mirror(i, 4))).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect(mirror(-1, 4)).toBe(1);
    expect(mirror(7, 1)).toBe(0);
  });
  it('a tile is three planes (R, G, B) of values 0..1, with no mean or spread correction', () => {
    const w = 600;
    const h = 520;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x % 256, y % 256, 255, 7], (y * w + x) * 4);
    const t = packTile(rgba, w, h, 88, 8);
    const n = T * T;
    expect(t.length).toBe(3 * n);
    // pixel (10, 20) of the tile = pixel (98, 28) of the picture
    expect(t[20 * T + 10]).toBeCloseTo(98 / 255, 6);
    expect(t[n + 20 * T + 10]).toBeCloseTo(28 / 255, 6);
    expect(t[2 * n + 20 * T + 10]).toBe(1);
    expect(Math.max(...t.subarray(0, 1000))).toBeLessThanOrEqual(1);
  });
  it('a picture smaller than the tile is continued mirrored, not with black', () => {
    const w = 512;
    const h = 288;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([y % 256, 0, 0, 255], (y * w + x) * 4);
    const t = packTile(rgba, w, h, 0, 0);
    expect(t[287 * T]).toBeCloseTo((287 % 256) / 255, 6);
    expect(t[288 * T]).toBeCloseTo((286 % 256) / 255, 6); // row 288 = row 286
    expect(t[511 * T]).toBeCloseTo((63 % 256) / 255, 6); // row 511 = row 574 - 511 = 63
  });
  it('resize: the same array when nothing changes, bilinear otherwise', () => {
    const src = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255]);
    expect(resizeRgba(src, 2, 1, 2, 1)).toBe(src);
    const out = resizeRgba(src, 2, 1, 4, 1);
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...out.subarray(12, 16)]).toEqual([200, 100, 50, 255]);
    expect(out[4]).toBe(50); // a quarter of the way
    expect(out[8]).toBe(150);
  });
  it('joining one tile gives back its picture part; overshoot is cut off when it becomes 8 bit', () => {
    const w = 512;
    const h = 288;
    const planes = new Float32Array(3 * T * T);
    planes.fill(0.5, 0, T * T);
    planes.fill(-0.3, T * T, 2 * T * T);
    planes.fill(1.4, 2 * T * T);
    const acc = new Float32Array(w * h * 3);
    const weight = new Float32Array(w * h);
    addTile(planes, styleTiles(w, h)[0], w, h, acc, weight);
    const rgb = joinFrame(acc, weight, null, 0.8);
    expect(rgb.length).toBe(w * h * 3);
    const px = toRgba(rgb, w, h);
    expect([...px.subarray(0, 4)]).toEqual([128, 0, 255, 255]);
    expect([...px.subarray(px.length - 4)]).toEqual([128, 0, 255, 255]);
  });
  it('two tiles are cross-faded where they overlap', () => {
    const w = 768;
    const h = 512;
    const tiles = styleTiles(w, h);
    const acc = new Float32Array(w * h * 3);
    const weight = new Float32Array(w * h);
    addTile(new Float32Array(3 * T * T).fill(0), tiles[0], w, h, acc, weight);
    addTile(new Float32Array(3 * T * T).fill(1), tiles[1], w, h, acc, weight);
    const rgb = joinFrame(acc, weight, null, 0);
    const at = (x: number) => rgb[(100 * w + x) * 3];
    expect(at(100)).toBe(0);
    expect(at(700)).toBe(1);
    expect(at(383)).toBeGreaterThan(0.45);
    expect(at(384)).toBeLessThan(0.55);
    for (let x = 257; x < 512; x++) expect(at(x)).toBeGreaterThanOrEqual(at(x - 1));
  });
  it('steady blends a frame with the one before it and keeps the result for the next', () => {
    const one = (v: number) => ({ acc: new Float32Array(3).fill(v), weight: new Float32Array(1).fill(1) });
    const a = one(1);
    const first = joinFrame(a.acc, a.weight, null, 0.5);
    expect(first[0]).toBe(1); // nothing before the first frame
    const b = one(0);
    const second = joinFrame(b.acc, b.weight, first, 0.5);
    expect(second).toBe(first);
    expect(second[0]).toBeCloseTo(0.5, 6);
    const c = one(0);
    expect(joinFrame(c.acc, c.weight, second, 0.5)[0]).toBeCloseTo(0.25, 6);
    const d = one(1);
    expect(joinFrame(d.acc, d.weight, second, 0)[0]).toBe(1); // 0 = every frame by itself
  });
});

describe('AdaIN', () => {
  // Small feature maps for the tests: 2 channels of 4 x 4 cells.
  const C = 2;
  const N = 4;
  const feat = (f: (c: number, i: number) => number) => Float32Array.from({ length: C * N * N }, (_, k) => f(Math.floor(k / (N * N)), k % (N * N)));
  const fa = feat((c, i) => (c === 0 ? i : 10 + 2 * (i % 4)));
  const fb = feat((c, i) => (c === 0 ? 100 - 3 * i : (i * 7) % 5));
  const sa = featureStats([fa], N, N, C, N);
  const sb = featureStats([fb], N, N, C, N);
  const out = () => new Float32Array(C * N * N);

  it('measures mean and spread per feature map, over the picture cells only', () => {
    expect(sa.mean[0]).toBeCloseTo(7.5, 5);
    expect(sa.std[0]).toBeCloseTo(Math.sqrt(21.25 + 1e-5), 4);
    // only the left 2 x 2 cells: 0, 1, 4, 5
    const part = featureStats([fa], 2, 2, C, N);
    expect(part.mean[0]).toBeCloseTo(2.5, 5);
    // two tiles count together
    expect(featureStats([fa, fa], N, N, C, N).mean[0]).toBeCloseTo(7.5, 5);
    // a flat map does not divide by zero
    expect(featureStats([new Float32Array(C * N * N)], N, N, C, N).std[0]).toBeGreaterThan(0);
  });
  it('shape 0, style 0 is picture A unchanged; shape 1, style 1 is picture B unchanged', () => {
    const a = adainMix(fa, fb, sa, sb, 0, 0, out(), C, N);
    const b = adainMix(fa, fb, sa, sb, 1, 1, out(), C, N);
    for (let i = 0; i < fa.length; i++) {
      expect(a[i]).toBeCloseTo(fa[i], 3);
      expect(b[i]).toBeCloseTo(fb[i], 3);
    }
  });
  it('shape 0, style 1 is A’s arrangement with B’s mean and spread: the style transfer of the paper', () => {
    const o = adainMix(fa, fb, sa, sb, 0, 1, out(), C, N);
    const so = featureStats([o], N, N, C, N);
    for (let c = 0; c < C; c++) {
      expect(so.mean[c]).toBeCloseTo(sb.mean[c], 3);
      expect(so.std[c]).toBeCloseTo(sb.std[c], 2);
    }
    // the arrangement is A's: channel 0 of A rises with the cell index, so does the result
    for (let i = 1; i < N * N; i++) expect(o[i]).toBeGreaterThan(o[i - 1]);
  });
  it('half way, the statistics are half way', () => {
    const o = adainMix(fa, fb, sa, sb, 0, 0.5, out(), C, N);
    expect(featureStats([o], N, N, C, N).mean[0]).toBeCloseTo((sa.mean[0] + sb.mean[0]) / 2, 3);
  });
  it('a picture whose weight is zero need not be given', () => {
    const withBoth = adainMix(fa, fb, sa, sb, 0, 1, out(), C, N);
    const onlyA = adainMix(fa, null, sa, sb, 0, 1, out(), C, N);
    const onlyB = adainMix(null, fb, sb, sb, 1, 1, out(), C, N);
    for (let i = 0; i < fa.length; i++) {
      expect(onlyA[i]).toBeCloseTo(withBoth[i], 4);
      expect(onlyB[i]).toBeCloseTo(fb[i], 3);
    }
  });
});
