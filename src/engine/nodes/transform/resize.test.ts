import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('resize', () => {
  it('scales by percent and rescales the unit', async () => {
    const t = await harness();
    const out = (await t.run('resize', { mode: 'percent', percent: 50 }, { image: t.solid(32, 16, [1, 2, 3, 255], 2) })).image as { width: number; height: number; unit: number };
    expect([out.width, out.height, out.unit]).toEqual([16, 8, 1]);
  });

  it('fits height, width and long side keeping aspect', async () => {
    const t = await harness();
    const src = t.solid(40, 20, [1, 2, 3, 255]);
    const dim = async (p: Record<string, unknown>) => {
      const o = (await t.run('resize', p, { image: src })).image as { width: number; height: number };
      return [o.width, o.height];
    };
    expect(await dim({ mode: 'height', height: 10 })).toEqual([20, 10]);
    expect(await dim({ mode: 'width', width: 10 })).toEqual([10, 5]);
    expect(await dim({ mode: 'long', longSide: 80 })).toEqual([80, 40]);
    expect(await dim({ mode: 'exact', width: 7, height: 9 })).toEqual([7, 9]);
  });

  it('area average gives a clean downscale of a checkerboard', async () => {
    const t = await harness();
    const src = t.checker(16, 16, 1);
    const area = await t.pixels((await t.run('resize', { mode: 'percent', percent: 25, filter: 'area' }, { image: src })).image as never);
    expect(area.width).toBe(4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(Math.abs(area.at(x, y)[0] - 128)).toBeLessThanOrEqual(2);
    const nearest = await t.pixels((await t.run('resize', { mode: 'percent', percent: 25, filter: 'nearest' }, { image: src })).image as never);
    expect([0, 255]).toContain(nearest.at(1, 1)[0]);
  });

  it('area filter keeps partial alpha correct and nearest keeps hard pixels when enlarging', async () => {
    const t = await harness();
    const half = t.fromFn(8, 8, (x) => [255, 0, 0, x % 2 ? 255 : 0]);
    const px = await t.pixels((await t.run('resize', { mode: 'percent', percent: 50, filter: 'area' }, { image: half })).image as never);
    expect(Math.abs(px.at(1, 1)[3] - 128)).toBeLessThanOrEqual(2);
    expect(px.at(1, 1)[0]).toBe(255);
    const big = await t.pixels((await t.run('resize', { mode: 'percent', percent: 200, filter: 'nearest' }, { image: t.checker(4, 4, 1) })).image as never);
    expect(big.width).toBe(8);
    expect(big.at(0, 0)[0]).toBe(0);
    expect(big.at(1, 1)[0]).toBe(0);
    expect(big.at(2, 0)[0]).toBe(255);
  });

  it('targets are literal texels, independent of the image unit, and follow the proxy', async () => {
    const t = await harness();
    const src = t.solid(1000, 500, [1, 2, 3, 255], 2);
    const dims = async (p: Record<string, unknown>, proxy?: number) => {
      const o = (await t.run('resize', p, { image: src }, { proxy })).image as { width: number; height: number; unit: number };
      return [o.width, o.height, o.unit];
    };
    expect(await dims({ mode: 'exact', width: 512, height: 512 })).toEqual([512, 512, 2 * (512 / 1000)]);
    expect(await dims({ mode: 'exact', width: 512, height: 512 }, 0.5)).toEqual([256, 256, 2 * (256 / 1000)]);
    expect((await dims({ mode: 'width', width: 512 }))[1]).toBe(256);
    expect((await dims({ mode: 'long', longSide: 512 }, 0.5))[0]).toBe(256);
  });

  it('is a no-op at 100%', async () => {
    const t = await harness();
    const src = t.solid(8, 8, [1, 2, 3, 255]);
    expect((await t.run('resize', { percent: 100 }, { image: src })).image).toBe(src);
  });
});
