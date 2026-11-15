import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('pad', () => {
  it('adds transparent margins and keeps the unit', async () => {
    const t = await harness();
    const src = t.solid(4, 4, [255, 0, 0, 255], 2);
    const out = await t.run('pad', { left: 1, right: 2, top: 3, bottom: 0 }, { image: src });
    const img = out.image as { width: number; height: number; unit: number };
    expect([img.width, img.height, img.unit]).toEqual([4 + 4 + 2, 4 + 6, 2]);
    const px = await t.pixels(out.image as never);
    expect(px.at(0, 0)[3]).toBe(0);
    expect(px.at(2, 6)).toEqual([255, 0, 0, 255]);
  });

  it('fills with a colour, behind partially transparent pixels too', async () => {
    const t = await harness();
    const src = t.solid(2, 2, [255, 0, 0, 255]);
    const out = await t.pixels((await t.run('pad', { left: 2, right: 0, top: 0, bottom: 0, fill: 'color', color: [0, 0, 1, 1] }, { image: src })).image as never);
    expect(out.at(0, 0)).toEqual([0, 0, 255, 255]);
    expect(out.at(3, 1)).toEqual([255, 0, 0, 255]);
  });

  it('extends edge, mirror and repeat', async () => {
    const t = await harness();
    const src = t.fromFn(4, 1, (x) => [x * 60, 0, 0, 255]);
    const first = async (fill: string) => (await t.pixels((await t.run('pad', { left: 2, right: 0, top: 0, bottom: 0, fill }, { image: src })).image as never)).at(0, 0)[0];
    expect(await first('clamp')).toBe(0);
    expect(await first('mirror')).toBe(60);
    expect(await first('wrap')).toBe(120);
  });

  it('reaches an aspect ratio by growing the shorter side', async () => {
    const t = await harness();
    const wide = (await t.run('pad', { mode: 'aspect', ratioW: 2, ratioH: 1 }, { image: t.solid(4, 4, [9, 9, 9, 255]) })).image as { width: number; height: number };
    expect([wide.width, wide.height]).toEqual([8, 4]);
    const tall = (await t.run('pad', { mode: 'aspect', ratioW: 1, ratioH: 2 }, { image: t.solid(4, 4, [9, 9, 9, 255]) })).image as { width: number; height: number };
    expect([tall.width, tall.height]).toEqual([4, 8]);
    const px = await t.pixels(wide as never);
    expect(px.at(0, 0)[3]).toBe(0);
    expect(px.at(4, 2)).toEqual([9, 9, 9, 255]);
    const same = t.solid(8, 4, [9, 9, 9, 255]);
    expect((await t.run('pad', { mode: 'aspect', ratioW: 2, ratioH: 1 }, { image: same })).image).toBe(same);
  });

  it('scales margins with the image unit', async () => {
    const t = await harness();
    const out = (await t.run('pad', { left: 2, right: 0, top: 0, bottom: 0 }, { image: t.solid(8, 8, [1, 1, 1, 255], 2) })).image as { width: number };
    expect(out.width).toBe(12);
  });
});
