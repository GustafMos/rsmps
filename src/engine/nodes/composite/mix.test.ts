import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('mix', () => {
  it('cross-fades two images', async () => {
    const t = await harness();
    const a = t.solid(8, 8, [200, 0, 0, 255]);
    const b = t.solid(8, 8, [0, 0, 100, 255]);
    const px = await t.pixels((await t.run('mix', { factor: 0.5 }, { a, b })).image as never);
    expect(Math.abs(px.at(3, 3)[0] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(px.at(3, 3)[2] - 50)).toBeLessThanOrEqual(1);
    const quarter = await t.pixels((await t.run('mix', { factor: 0.25 }, { a, b })).image as never);
    expect(Math.abs(quarter.at(0, 0)[0] - 150)).toBeLessThanOrEqual(1);
  });

  it('scales B to the size of A', async () => {
    const t = await harness();
    const a = t.solid(8, 8, [0, 0, 0, 255], 2);
    const b = t.fromFn(2, 2, () => [255, 255, 255, 255]);
    const out = await t.run('mix', { factor: 1 }, { a, b });
    const img = out.image as { width: number; height: number; unit: number };
    expect([img.width, img.height, img.unit]).toEqual([8, 8, 2]);
    expect((await t.pixels(img as never)).at(5, 5)).toEqual([255, 255, 255, 255]);
  });

  it('mixes alpha too and is a no-op without B or at factor 0', async () => {
    const t = await harness();
    const a = t.solid(4, 4, [255, 0, 0, 0]);
    const b = t.solid(4, 4, [255, 0, 0, 255]);
    const px = await t.pixels((await t.run('mix', { factor: 0.5 }, { a, b })).image as never);
    expect(Math.abs(px.at(1, 1)[3] - 128)).toBeLessThanOrEqual(1);
    expect((await t.run('mix', { factor: 0.5 }, { a })).image).toBe(a);
    expect((await t.run('mix', { factor: 0 }, { a, b })).image).toBe(a);
  });

  it('takes the factor from a wired number', async () => {
    const t = await harness();
    const a = t.solid(4, 4, [0, 0, 0, 255]);
    const b = t.solid(4, 4, [200, 200, 200, 255]);
    const px = await t.pixels((await t.run('mix', {}, { a, b, factor: 0.5 })).image as never);
    expect(Math.abs(px.at(0, 0)[0] - 100)).toBeLessThanOrEqual(1);
  });
});
