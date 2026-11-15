import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('mosaic', () => {
  it('turns each block into one flat colour (the block average) and keeps the size', async () => {
    const t = await harness();
    // 16x16, left half black / right half white; 8px blocks align with the halves, 16px blocks average both.
    const img = t.fromFn(16, 16, (x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = (await t.run('mosaic', { block: 8 }, { image: img })).image as { width: number; height: number };
    expect([out.width, out.height]).toEqual([16, 16]);
    const px = await t.pixels(out as never);
    expect(px.at(3, 3)[0]).toBeLessThan(4);
    expect(px.at(12, 12)[0]).toBeGreaterThan(251);
    const coarse = await t.pixels((await t.run('mosaic', { block: 16 }, { image: img })).image as never);
    expect(Math.abs(coarse.at(2, 2)[0] - 128)).toBeLessThan(6);
    expect(coarse.at(2, 2)[0]).toBe(coarse.at(13, 13)[0]);
  });

  it('is flat inside every block', async () => {
    const t = await harness();
    const img = t.fromFn(32, 32, (x, y) => [(x * 8) & 255, (y * 8) & 255, 100, 255]);
    const px = await t.pixels((await t.run('mosaic', { block: 8 }, { image: img })).image as never);
    let varying = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (px.data[(y * 32 + x) * 4] !== px.data[((y - (y % 8)) * 32 + (x - (x % 8))) * 4]) varying++;
    expect(varying).toBe(0);
  });

  it('block size is a length: same look at 2x resolution with unit 2', async () => {
    const t = await harness();
    const small = t.scene(64, 64, 1);
    const big = t.scene(128, 128, 2);
    const a = (await t.run('mosaic', { block: 8 }, { image: small })).image as never;
    const b = (await t.run('mosaic', { block: 8 }, { image: big })).image as never;
    const pa = await t.pixels(a);
    const pb = await t.pixels(b);
    let worst = 0;
    for (let y = 4; y < 64; y += 8) for (let x = 4; x < 64; x += 8) worst = Math.max(worst, Math.abs(pa.at(x, y)[0] - pb.at(x * 2, y * 2)[0]));
    expect(worst).toBeLessThan(8);
  });

  it('keeps transparent blocks transparent', async () => {
    const t = await harness();
    const img = t.fromFn(16, 16, (x) => (x < 8 ? [0, 0, 0, 0] : [200, 0, 0, 255]));
    const px = await t.pixels((await t.run('mosaic', { block: 8 }, { image: img })).image as never);
    expect(px.at(2, 2)[3]).toBe(0);
    expect(px.at(12, 2)).toEqual([200, 0, 0, 255]);
  });
});

describe('mosaic on coarse grids', () => {
  it('block is at least one whole texel at unit 0.25', async () => {
    const t = await harness();
    const img = t.fromFn(8, 8, (x) => (x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]), 0.25);
    const px = await t.pixels((await t.run('mosaic', { block: 2, mode: 'center' }, { image: img })).image as never);
    // 2 * 0.25 = 0.5 texel -> clamped to 1: image unchanged, no smearing or NaN.
    expect(px.at(0, 0)[0]).toBe(0);
    expect(px.at(1, 0)[0]).toBe(255);
  });
});
