import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

describe('paint-mask', () => {
  it('rasterises strokes, supports erase and invert', async () => {
    const t = await harness();
    const ref = t.solid(64, 64, [0, 0, 0, 255]);
    const strokes = [{ points: [[0.2, 0.5], [0.8, 0.5]], radius: 0.08, add: true }];
    const px = await t.pixels((await t.run('paint-mask', { strokes }, { image: ref })).mask as never);
    expect(px.at(32, 32)[0]).toBe(255);
    expect(px.at(32, 20)[0]).toBe(0);
    expect(px.at(2, 32)[0]).toBe(0);
    const erased = await t.pixels((await t.run('paint-mask', { strokes: [...strokes, { points: [[0.5, 0.5]], radius: 0.06, add: false }] }, { image: ref })).mask as never);
    expect(erased.at(32, 32)[0]).toBe(0);
    expect(erased.at(16, 32)[0]).toBe(255);
    const inv = await t.pixels((await t.run('paint-mask', { strokes, invert: true }, { image: ref })).mask as never);
    expect(inv.at(32, 32)[0]).toBe(0);
  });

  it('handles many segments (several passes) and malformed input', async () => {
    const t = await harness();
    const ref = t.solid(64, 64, [0, 0, 0, 255]);
    const pts: number[][] = [];
    for (let i = 0; i < 600; i++) pts.push([0.1 + (i % 100) * 0.008, 0.2 + Math.floor(i / 100) * 0.12]);
    const px = await t.pixels((await t.run('paint-mask', { strokes: [{ points: pts, radius: 0.03 }] }, { image: ref })).mask as never);
    expect(px.at(32, 13)[0]).toBeGreaterThan(200);
    const bad = await t.pixels((await t.run('paint-mask', { strokes: [{ nope: 1 }, null, { points: 'x' }] }, { image: ref })).mask as never);
    expect(bad.at(10, 10)[0]).toBe(0);
  });

  it('grows painted regions over similar colours but stops at edges', async () => {
    const t = await harness();
    // Left half red with a green square, right half blue.
    const img = t.fromFn(64, 64, (x, y) => (x >= 32 ? [30, 60, 220, 255] : x > 8 && x < 18 && y > 8 && y < 18 ? [40, 200, 60, 255] : [220, 40, 40, 255]));
    const strokes = [{ points: [[0.25, 0.55], [0.3, 0.6]], radius: 0.03 }];
    const plain = await t.pixels((await t.run('paint-mask', { strokes }, { image: img })).mask as never);
    expect(plain.at(5, 40)[0]).toBe(0);
    const grown = await t.pixels((await t.run('paint-mask', { strokes, grow: true, tolerance: 0.1, reach: 80 }, { image: img })).mask as never);
    expect(grown.at(5, 40)[0]).toBeGreaterThan(200); // red region filled
    expect(grown.at(25, 60)[0]).toBeGreaterThan(200);
    expect(grown.at(50, 40)[0]).toBeLessThan(30); // stops at the blue half
    expect(grown.at(12, 12)[0]).toBeLessThan(30); // stops at the green square
  });
});
