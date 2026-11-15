import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('stack', () => {
  it('layers bottom to top, fitting upper layers inside', async () => {
    const t = await harness();
    const bottom = t.solid(8, 8, [0, 0, 255, 255], 2);
    const top = t.solid(16, 8, [255, 0, 0, 255]);
    const out = await t.run('stack', {}, { images: [bottom, top] });
    const img = out.image as { width: number; height: number; unit: number };
    expect([img.width, img.height, img.unit]).toEqual([8, 8, 2]);
    const px = await t.pixels(img as never);
    expect(px.at(4, 4)).toEqual([255, 0, 0, 255]);
    expect(px.at(4, 0)).toEqual([0, 0, 255, 255]);
    expect(px.at(4, 7)).toEqual([0, 0, 255, 255]);
  });

  it('puts later layers on top and respects transparency', async () => {
    const t = await harness();
    const a = t.solid(4, 4, [255, 0, 0, 255]);
    const b = t.fromFn(4, 4, (x) => [0, 255, 0, x < 2 ? 255 : 0]);
    const c = t.solid(4, 4, [0, 0, 255, 128]);
    const px = await t.pixels((await t.run('stack', {}, { images: [a, b, c] })).image as never);
    // left: blue 50% over green; right: blue 50% over red
    expect(Math.abs(px.at(0, 0)[1] - 127)).toBeLessThanOrEqual(2);
    expect(Math.abs(px.at(0, 0)[2] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(px.at(3, 0)[0] - 127)).toBeLessThanOrEqual(2);
    expect(px.at(3, 0)[3]).toBe(255);
  });

  it('fills with cover, stretches, and passes a single layer through', async () => {
    const t = await harness();
    const bottom = t.solid(8, 8, [0, 0, 255, 255]);
    const top = t.solid(16, 8, [255, 0, 0, 255]);
    const cover = await t.pixels((await t.run('stack', { fit: 'cover' }, { images: [bottom, top] })).image as never);
    expect(cover.at(0, 0)).toEqual([255, 0, 0, 255]);
    const only = t.solid(2, 2, [1, 2, 3, 255]);
    expect((await t.run('stack', {}, { images: [only] })).image).toBe(only);
    const half = await t.pixels((await t.run('stack', { fit: 'stretch', opacity: 0.5 }, { images: [bottom, top] })).image as never);
    expect(Math.abs(half.at(0, 0)[0] - 128)).toBeLessThanOrEqual(2);
  });
});
