import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('image-to-mask', () => {
  it('extracts each channel', async () => {
    const t = await harness();
    const image = t.solid(4, 4, [200, 100, 50, 255]);
    const val = async (channel: string, invert = false) => (await t.pixels((await t.run('image-to-mask', { channel, invert }, { image })).mask as never)).at(1, 1)[0];
    expect(await val('r')).toBe(200);
    expect(await val('g')).toBe(100);
    expect(await val('b')).toBe(50);
    expect(await val('alpha')).toBe(255);
    const luma = await val('luma');
    expect(luma).toBeGreaterThan(100);
    expect(luma).toBeLessThan(150);
    expect(await val('r', true)).toBe(55);
  });

  it('reads straight colour of semi-transparent pixels and alpha as coverage', async () => {
    const t = await harness();
    const image = t.solid(4, 4, [200, 0, 0, 128]);
    const r = await t.pixels((await t.run('image-to-mask', { channel: 'r' }, { image })).mask as never);
    expect(Math.abs(r.at(0, 0)[0] - 200)).toBeLessThanOrEqual(2);
    const a = await t.pixels((await t.run('image-to-mask', { channel: 'alpha' }, { image })).mask as never);
    expect(Math.abs(a.at(0, 0)[0] - 128)).toBeLessThanOrEqual(1);
    const clear = await t.pixels((await t.run('image-to-mask', { channel: 'luma' }, { image: t.solid(2, 2, [0, 0, 0, 0]) })).mask as never);
    expect(clear.at(0, 0)[0]).toBe(0);
  });
});
