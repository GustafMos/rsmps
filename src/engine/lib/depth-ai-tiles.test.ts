import { describe, expect, it } from 'vitest';
import { resizeChannels } from './depth-ai-math';
import { boxBlur, cropRgba, featherWeights, fitAffine, mergeRadius, mergeTiles, tileCrop, tileLayout, tileScale } from './depth-ai-tiles';

/** A scene defined on the unit square, so it can be "photographed" at any size and any crop: a slope, a soft hill and a 1.2% wide bar. */
function scene(u: number, v: number): number {
  const bar = Math.abs(u - 0.37) < 0.006 ? 0.6 : 0;
  return 0.8 * u + 0.4 * v + 0.3 * Math.exp(-((u - 0.7) ** 2 + (v - 0.4) ** 2) / 0.02) + bar;
}

/** What a model with a fixed resolution limit returns for a part of the scene: `w x h` samples, blurred by `blur` texels, in its own units. */
function shoot(w: number, h: number, part: { u0: number; v0: number; du: number; dv: number }, blur: number, scale = 1, shift = 0): Float32Array {
  const fine = 4; // supersample, so the thin bar is averaged into the texels it touches
  const hi = new Float32Array(w * fine * h * fine);
  for (let y = 0; y < h * fine; y++) for (let x = 0; x < w * fine; x++) hi[y * w * fine + x] = scene(part.u0 + ((x + 0.5) / (w * fine)) * part.du, part.v0 + ((y + 0.5) / (h * fine)) * part.dv);
  const out = boxBlur(resizeChannels(hi, w * fine, h * fine, w, h, 1), w, h, blur, 1);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * scale + shift;
  return out;
}

describe('tile layout', () => {
  it('2 x 2 and 3 x 3 tiles of the model size cover a map 1.6 and 2.4 times larger, the outer tiles on the border', () => {
    expect(tileScale(1)).toBe(1);
    expect(tileScale(2)).toBeCloseTo(1.6, 6);
    expect(tileScale(3)).toBeCloseTo(2.4, 6);
    for (const n of [2, 3]) {
      const l = tileLayout(518, 294, n);
      expect(l.tiles.length).toBe(n * n);
      expect(l.width).toBe(Math.round(518 * tileScale(n)));
      expect(l.height).toBe(Math.round(294 * tileScale(n)));
      expect(l.tiles[0]).toEqual({ x: 0, y: 0 });
      expect(l.tiles[n * n - 1]).toEqual({ x: l.width - 518, y: l.height - 294 });
      // neighbours overlap, and every pixel is inside at least one tile
      const covered = new Uint8Array(l.width * l.height);
      for (const t of l.tiles) for (let y = 0; y < 294; y++) covered.fill(1, (t.y + y) * l.width + t.x, (t.y + y) * l.width + t.x + 518);
      expect(covered.every((v) => v === 1)).toBe(true);
      expect(l.tiles[1].x).toBeLessThan(518 * 0.85);
    }
    expect(tileLayout(518, 294, 1)).toMatchObject({ width: 518, height: 294, tiles: [{ x: 0, y: 0 }] });
  });

  it('a tile maps to whole pixels inside the picture, whatever the picture size', () => {
    const l = tileLayout(518, 294, 3);
    for (const [sw, sh] of [[1920, 1080], [1243, 706], [300, 170], [7, 5]]) {
      for (const t of l.tiles) {
        const r = tileCrop(l, t, sw, sh);
        expect(Number.isInteger(r.x) && Number.isInteger(r.y) && r.width >= 1 && r.height >= 1).toBe(true);
        expect(r.x + r.width).toBeLessThanOrEqual(sw);
        expect(r.y + r.height).toBeLessThanOrEqual(sh);
      }
    }
    const rgba = new Uint8ClampedArray(6 * 4 * 4).map((_, i) => i % 251);
    const cut = cropRgba(rgba, 6, { x: 2, y: 1, width: 3, height: 2 });
    expect(cut.length).toBe(3 * 2 * 4);
    expect([...cut.subarray(0, 4)]).toEqual([...rgba.subarray((1 * 6 + 2) * 4, (1 * 6 + 2) * 4 + 4)]);
    expect([...cut.subarray(20, 24)]).toEqual([...rgba.subarray((2 * 6 + 4) * 4, (2 * 6 + 4) * 4 + 4)]);
  });
});

describe('fitting a tile onto the whole-picture result', () => {
  it('recovers the scale and offset the model made up for the tile', () => {
    const ref = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i * 0.37) + 0.002 * i);
    const cur = ref.map((v) => (v - 3.5) / 0.4); // ref = 0.4 * cur + 3.5
    const a = fitAffine(ref, cur);
    expect(a.scale).toBeCloseTo(0.4, 4);
    expect(a.shift).toBeCloseTo(3.5, 3);
  });

  it('is the least-squares line: no other scale / offset has a smaller error', () => {
    const ref = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i * 0.11) + ((i * 7919) % 13) * 0.01);
    const cur = Float32Array.from({ length: 2000 }, (_, i) => 2 * Math.sin(i * 0.11) + 1 + ((i * 104729) % 17) * 0.02);
    const a = fitAffine(ref, cur);
    const err = (s: number, o: number) => ref.reduce((acc, r, i) => acc + (s * cur[i] + o - r) ** 2, 0);
    const best = err(a.scale, a.shift);
    for (const [ds, dz] of [[0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01], [0.01, -0.01]]) expect(err(a.scale + ds, a.shift + dz)).toBeGreaterThan(best);
  });

  it('a tile that cannot be related to the base (flat, or running the other way) gets scale 0, so it adds nothing', () => {
    const ref = Float32Array.from({ length: 500 }, (_, i) => i / 500);
    expect(fitAffine(ref, new Float32Array(500).fill(3))).toEqual({ scale: 0, shift: expect.closeTo(0.499, 3) });
    expect(fitAffine(ref, ref.map((v) => -v)).scale).toBe(0);
    expect(fitAffine(new Float32Array(0), new Float32Array(0))).toEqual({ scale: 0, shift: 0 });
  });
});

describe('blur and cross-fade', () => {
  it('the blur keeps a constant and the mean, and spreads a point', () => {
    const flat = boxBlur(new Float32Array(20 * 10).fill(0.7), 20, 10, 3);
    expect(Math.max(...flat) - Math.min(...flat)).toBeLessThan(1e-6);
    const dot = new Float32Array(41 * 41);
    dot[20 * 41 + 20] = 1;
    const b = boxBlur(dot, 41, 41, 2);
    expect(b.reduce((p, q) => p + q, 0)).toBeCloseTo(1, 4);
    expect(b[20 * 41 + 20]).toBeLessThan(0.2);
    expect(b[20 * 41 + 24]).toBeGreaterThan(0);
    expect(boxBlur(dot, 41, 41, 0)).toEqual(dot);
  });

  it('weights fade over the shared strip, not on the picture border, and neighbours add up to an even cover', () => {
    const l = tileLayout(100, 60, 2);
    const a = featherWeights(l, l.tiles[0]);
    const b = featherWeights(l, l.tiles[1]);
    expect(a.wx[0]).toBe(1); // left border of the picture: no fade
    expect(a.wx[99]).toBeLessThan(0.05); // inner edge: faded out
    expect(b.wx[0]).toBeLessThan(0.05);
    expect(b.wx[99]).toBe(1);
    expect(a.wy[0]).toBe(1);
    // across the overlap the two ramps mirror each other
    const off = l.tiles[1].x;
    for (let x = off; x < 100; x++) expect(a.wx[x] + b.wx[x - off]).toBeCloseTo(1, 5);
  });
});

describe('merging tiles onto the base', () => {
  const W = 120;
  const H = 72;
  for (const n of [2, 3]) {
    it(`${n} x ${n}: fine detail comes from the tiles, the depth order from the base, although every tile has its own scale and offset`, () => {
      const l = tileLayout(W, H, n);
      const blur = 2; // the model's resolution limit, in ITS texels: the same for the whole picture and for a tile
      const base = shoot(W, H, { u0: 0, v0: 0, du: 1, dv: 1 }, blur, 2.5, -1);
      const tiles = l.tiles.map((t, k) => shoot(W, H, { u0: t.x / l.width, v0: t.y / l.height, du: W / l.width, dv: H / l.height }, blur, 0.5 + 0.37 * k, 3 - k));
      const { data, affines } = mergeTiles(base, l, tiles);
      expect(data.length).toBe(l.width * l.height);
      // each tile's made-up scale is undone (base units = 2.5 x scene)
      affines.forEach((a, k) => expect(a.scale * (0.5 + 0.37 * k)).toBeGreaterThan(1.5));
      const truth = (x: number, y: number) => 2.5 * scene((x + 0.5) / l.width, (y + 0.5) / l.height) - 1;
      const up = resizeChannels(base, W, H, l.width, l.height, 1);
      // 1. the thin bar: closer to the truth than the enlarged base, and taller
      const y = Math.round(l.height * 0.8);
      const bx = Math.round(0.37 * l.width - 0.5);
      const peak = (a: Float32Array) => a[y * l.width + bx] - (a[y * l.width + bx - 12] + a[y * l.width + bx + 12]) / 2;
      expect(peak(data)).toBeGreaterThan(peak(up) * 1.3);
      // 2. overall: not further from the truth than the base anywhere smooth, and no seam: neighbours never jump
      let errM = 0;
      let errB = 0;
      let jump = 0;
      for (let yy = 0; yy < l.height; yy++) {
        for (let x = 0; x < l.width; x++) {
          const i = yy * l.width + x;
          errM += Math.abs(data[i] - truth(x, yy));
          errB += Math.abs(up[i] - truth(x, yy));
          if (x > 0 && Math.abs(x - bx) > 8) jump = Math.max(jump, Math.abs(data[i] - data[i - 1]));
        }
      }
      expect(errM).toBeLessThan(errB);
      expect(jump).toBeLessThan(0.08); // the slope itself is 2.5 * 0.8 / width per pixel; a seam would be a step of tenths
    });
  }

  it('a tile the model got wrong at large scale cannot bend the base: only what is finer than the merge blur comes through', () => {
    const l = tileLayout(W, H, 2);
    const base = shoot(W, H, { u0: 0, v0: 0, du: 1, dv: 1 }, 2);
    const tiles = l.tiles.map((t) => {
      const good = shoot(W, H, { u0: t.x / l.width, v0: t.y / l.height, du: W / l.width, dv: H / l.height }, 2);
      // a slow, wrong bulge over the whole tile (a part without context invents such things)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) good[y * W + x] += 0.5 * Math.sin((Math.PI * x) / W) * Math.sin((Math.PI * y) / H);
      return good;
    });
    const { data } = mergeTiles(base, l, tiles);
    const up = resizeChannels(base, W, H, l.width, l.height, 1);
    // compare at the scale of the merge blur: the large shapes are the base's
    const r = mergeRadius(l);
    const a = boxBlur(data, l.width, l.height, r);
    const b = boxBlur(up, l.width, l.height, r);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThan(0.08); // the bulge was 0.5
  });

  it('Standard is the base, unchanged', () => {
    const base = shoot(40, 20, { u0: 0, v0: 0, du: 1, dv: 1 }, 1);
    expect(mergeTiles(base, tileLayout(40, 20, 1), []).data).toEqual(base);
  });
});
