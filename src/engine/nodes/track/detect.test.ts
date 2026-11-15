import { describe, expect, it } from 'vitest';
import { squaresSource, TestGraph } from '../../lib/track-testutil';
import { harness } from '../../testing';
import type { RegionsValue } from '../../types';

const NO_PAD = { blur: 0, mergeDistance: 0, padding: 0, minSize: 0.01 };
const near = (a: number[], b: number[], tol: number) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(tol));

/** Black frame with a big and a small white square, in normalised coordinates, at any resolution. */
function twoSquares(t: Awaited<ReturnType<typeof harness>>, size: number, unit = 1) {
  return t.fromFn(
    size,
    size,
    (x, y) => {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const big = u >= 0.15 && u < 0.35 && v >= 0.15 && v < 0.35;
      const small = u >= 0.6 && u < 0.7 && v >= 0.7 && v < 0.8;
      return big || small ? [255, 255, 255, 255] : [0, 0, 0, 255];
    },
    unit,
  );
}

describe('detect-blobs', () => {
  it('finds bright squares, biggest first, with correct boxes', async () => {
    const t = await harness();
    const out = await t.run('detect-blobs', NO_PAD, { image: twoSquares(t, 64) });
    const r = (out.regions as RegionsValue).items;
    expect(r).toHaveLength(2);
    near(r[0].box, [0.15, 0.15, 0.35, 0.35], 0.012);
    near(r[1].box, [0.6, 0.7, 0.7, 0.8], 0.012);
    expect(r[0].label).toBe('blob');
    expect(r[0].score).toBeGreaterThan(0.9);
    const m = await t.pixels(out.mask as never);
    expect(m.at(16, 16)[0]).toBeGreaterThan(200);
    expect(m.at(2, 60)[0]).toBeLessThan(10);
  });

  it('finds dark spots and respects size limits, count and order', async () => {
    const t = await harness();
    const inv = t.fromFn(64, 64, (x, y) => ((x > 8 && x < 20 && y > 8 && y < 20) || (x > 40 && x < 44 && y > 40 && y < 44) ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const dark = (await t.run('detect-blobs', { ...NO_PAD, mode: 'dark' }, { image: inv })).regions as RegionsValue;
    expect(dark.items).toHaveLength(2);
    const onlyBig = (await t.run('detect-blobs', { ...NO_PAD, mode: 'dark', minSize: 1 }, { image: inv })).regions as RegionsValue;
    expect(onlyBig.items).toHaveLength(1);
    const left = (await t.run('detect-blobs', { ...NO_PAD, mode: 'dark', sort: 'left', maxCount: 1 }, { image: inv })).regions as RegionsValue;
    expect(left.items).toHaveLength(1);
    const none = (await t.run('detect-blobs', { ...NO_PAD, maxSize: 0.5 }, { image: twoSquares(t, 64) })).regions as RegionsValue;
    expect(none.items).toHaveLength(0);
  });

  it('merges regions that are close together', async () => {
    const t = await harness();
    const img = twoSquares(t, 64);
    const far = (await t.run('detect-blobs', { ...NO_PAD, mergeDistance: 0.6 }, { image: img })).regions as RegionsValue;
    expect(far.items).toHaveLength(1);
    near(far.items[0].box, [0.15, 0.15, 0.7, 0.8], 0.02);
  });

  it('gives (nearly) the same normalised boxes at 2x resolution', async () => {
    const t = await harness();
    const a = ((await t.run('detect-blobs', { padding: 0.01 }, { image: twoSquares(t, 64, 1) })).regions as RegionsValue).items;
    const b = ((await t.run('detect-blobs', { padding: 0.01 }, { image: twoSquares(t, 128, 2) })).regions as RegionsValue).items;
    expect(b).toHaveLength(a.length);
    a.forEach((r, i) => near(r.box, b[i].box, 0.02));
  });

  it('finds saturated spots but ignores grey', async () => {
    const t = await harness();
    const img = t.fromFn(64, 64, (x, y) => (x > 10 && x < 30 && y > 10 && y < 30 ? [255, 0, 0, 255] : x > 40 && y > 40 ? [200, 200, 200, 255] : [20, 20, 20, 255]));
    const r = ((await t.run('detect-blobs', { ...NO_PAD, mode: 'saturated', threshold: 0.7 }, { image: img })).regions as RegionsValue).items;
    expect(r).toHaveLength(1);
    near(r[0].box, [10 / 64, 10 / 64, 30 / 64, 30 / 64], 0.03);
  });
});

describe('detect-color', () => {
  it('finds only the picked colour', async () => {
    const t = await harness();
    const img = t.fromFn(64, 64, (x, y) => (x > 10 && x < 26 && y > 10 && y < 26 ? [250, 20, 20, 255] : x > 40 && y > 40 ? [20, 20, 250, 255] : [30, 30, 30, 255]));
    const red = (await t.run('detect-color', { ...NO_PAD, color: [1, 0.08, 0.08, 1], label: 'marker' }, { image: img })).regions as RegionsValue;
    expect(red.items).toHaveLength(1);
    expect(red.items[0].label).toBe('marker');
    near(red.items[0].box, [11 / 64, 11 / 64, 26 / 64, 26 / 64], 0.03);
    const blue = (await t.run('detect-color', { ...NO_PAD, color: [0.08, 0.08, 1, 1] }, { image: img })).regions as RegionsValue;
    expect(blue.items).toHaveLength(1);
    expect(blue.items[0].box[0]).toBeGreaterThan(0.6);
  });

  it('tolerance widens the match', async () => {
    const t = await harness();
    const img = t.fromFn(64, 64, (x) => (x < 32 ? [230, 40, 40, 255] : [200, 90, 60, 255]));
    const strict = (await t.run('detect-color', { ...NO_PAD, color: [0.9, 0.16, 0.16, 1], tolerance: 0.05 }, { image: img })).regions as RegionsValue;
    const loose = (await t.run('detect-color', { ...NO_PAD, color: [0.9, 0.16, 0.16, 1], tolerance: 0.3, maxSize: 100 }, { image: img })).regions as RegionsValue;
    expect(strict.items[0].box[2]).toBeLessThan(0.6);
    expect(loose.items[0].box[2]).toBeGreaterThan(0.95);
  });
});

describe('detect-motion', () => {
  it('boxes the moving square and ignores a still scene', async () => {
    const t = await harness([
      squaresSource('test-mover', 64, (f) => [{ cx: 0.25 + 0.03 * f, cy: 0.5, hs: 0.1, color: [255, 255, 255] }]),
      squaresSource('test-still', 64, () => [{ cx: 0.5, cy: 0.5, hs: 0.1, color: [255, 255, 255] }]),
    ]);
    const g = new TestGraph(t);
    const src = g.add('test-mover');
    const det = g.add('detect-motion', { frames: 1, blur: 0, padding: 0, threshold: 0.2, minSize: 0.01, mergeDistance: 0.3 });
    g.wire(src, 'image', det, 'image');
    const r = await g.regions(det, 5);
    expect(r).toHaveLength(1);
    // Square centre at frame 5 = 0.4; the box spans the previous and current position.
    const cx = (r[0].box[0] + r[0].box[2]) / 2;
    expect(cx).toBeGreaterThan(0.3);
    expect(cx).toBeLessThan(0.45);
    expect(r[0].box[1]).toBeGreaterThan(0.3);
    expect(r[0].box[3]).toBeLessThan(0.7);

    const g2 = new TestGraph(t);
    const s2 = g2.add('test-still');
    const d2 = g2.add('detect-motion', { frames: 1, blur: 0 });
    g2.wire(s2, 'image', d2, 'image');
    expect(await g2.regions(d2, 3)).toHaveLength(0);
  });

  it('also finds motion on the first frame (compares with the next one)', async () => {
    const t = await harness([squaresSource('test-mover2', 64, (f) => [{ cx: 0.25 + 0.03 * f, cy: 0.5, hs: 0.1, color: [255, 255, 255] }])]);
    const g = new TestGraph(t);
    const src = g.add('test-mover2');
    const det = g.add('detect-motion', { frames: 1, blur: 0, threshold: 0.2, minSize: 0.01, mergeDistance: 0.3 });
    g.wire(src, 'image', det, 'image');
    expect((await g.regions(det, 0)).length).toBeGreaterThan(0);
  });

  it('wraps around the loop when the project loops', async () => {
    // Square jumps only between the last and first frame of a 4-frame loop.
    const t = await harness([squaresSource('test-jump', 64, (f) => [{ cx: f % 4 === 0 ? 0.7 : 0.3, cy: 0.5, hs: 0.1, color: [255, 255, 255] }])]);
    const g = new TestGraph(t, { loop: true, duration: 0.4, fps: 10 });
    const src = g.add('test-jump');
    const det = g.add('detect-motion', { frames: 1, blur: 0, threshold: 0.2, minSize: 0.01, mergeDistance: 0.3 });
    g.wire(src, 'image', det, 'image');
    expect((await g.regions(det, 0)).length).toBe(1); // 0 vs frame 3 (wrapped): jump
    expect((await g.regions(det, 2)).length).toBe(0); // 2 vs 1: still
  });
});

describe('regions-from-mask', () => {
  it('turns every island of a mask into a region', async () => {
    const t = await harness();
    const m = t.maskFn(64, 64, (x, y) => ((x >= 8 && x < 24 && y >= 8 && y < 24) || (x >= 40 && x < 48 && y >= 30 && y < 50) ? 1 : 0));
    const r = ((await t.run('regions-from-mask', { padding: 0, mergeDistance: 0, label: 'thing' }, { mask: m })).regions as RegionsValue).items;
    expect(r).toHaveLength(2);
    expect(r[0].label).toBe('thing');
    near(r[0].box, [8 / 64, 8 / 64, 24 / 64, 24 / 64], 0.012);
    near(r[1].box, [40 / 64, 30 / 64, 48 / 64, 50 / 64], 0.012);
  });

  it('thresholds soft masks and survives a 2x copy', async () => {
    const t = await harness();
    const soft = (size: number, unit: number) => t.maskFn(size, size, (x, y) => Math.max(0, 1 - Math.hypot(x / size - 0.5, y / size - 0.5) * 4), unit);
    const a = ((await t.run('regions-from-mask', { threshold: 0.5 }, { mask: soft(64, 1) })).regions as RegionsValue).items;
    const b = ((await t.run('regions-from-mask', { threshold: 0.5 }, { mask: soft(128, 2) })).regions as RegionsValue).items;
    expect(a).toHaveLength(1);
    near(a[0].box, b[0].box, 0.02);
    const low = ((await t.run('regions-from-mask', { threshold: 0.1, padding: 0 }, { mask: soft(64, 1) })).regions as RegionsValue).items;
    expect(low[0].box[2] - low[0].box[0]).toBeGreaterThan(a[0].box[2] - a[0].box[0]);
  });
});
