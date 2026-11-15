import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('crop', () => {
  it('cuts a fractional rectangle with exact pixels', async () => {
    const t = await harness();
    const src = t.fromFn(16, 8, (x, y) => [x * 10, y * 20, 0, 255], 2);
    const out = await t.run('crop', { position: [0.25, 0.5], size: [0.5, 0.5] }, { image: src });
    const img = out.image as { width: number; height: number; unit: number };
    expect([img.width, img.height, img.unit]).toEqual([8, 4, 2]);
    const px = await t.pixels(out.image as never);
    expect(px.at(0, 0)).toEqual([40, 80, 0, 255]);
    expect(px.at(7, 3)).toEqual([110, 140, 0, 255]);
  });

  it('trims pixel margins and scales them with the image unit', async () => {
    const t = await harness();
    const src = t.solid(20, 10, [9, 9, 9, 255]);
    const out = await t.run('crop', { mode: 'margins', left: 2, right: 3, top: 1, bottom: 1 }, { image: src });
    expect([(out.image as { width: number }).width, (out.image as { height: number }).height]).toEqual([15, 8]);
    // same margins at 2x resolution with unit 2 trim twice the texels
    const big = t.solid(40, 20, [9, 9, 9, 255], 2);
    const out2 = await t.run('crop', { mode: 'margins', left: 2, right: 3, top: 1, bottom: 1 }, { image: big });
    expect([(out2.image as { width: number }).width, (out2.image as { height: number }).height]).toEqual([30, 16]);
  });

  it('keeps transparency and is a no-op by default', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => [255, 0, 0, x < 4 ? 0 : 255]);
    const same = await t.run('crop', {}, { image: src });
    expect(same.image).toBe(src);
    const out = await t.run('crop', { position: [0, 0], size: [0.5, 1] }, { image: src });
    const px = await t.pixels(out.image as never);
    expect(px.width).toBe(4);
    expect(px.at(2, 2)[3]).toBe(0);
  });
});
