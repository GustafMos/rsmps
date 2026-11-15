import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('alpha-to-mask', () => {
  it('turns transparency into coverage', async () => {
    const t = await harness();
    const image = t.fromFn(4, 1, (x) => [255, 0, 0, x * 85]);
    const out = await t.run('alpha-to-mask', {}, { image });
    expect((out.mask as { kind: string }).kind).toBe('mask');
    const px = await t.pixels(out.mask as never);
    expect(px.at(0, 0)[0]).toBe(0);
    expect(Math.abs(px.at(1, 0)[0] - 85)).toBeLessThanOrEqual(1);
    expect(px.at(3, 0)[0]).toBe(255);
  });

  it('supports invert and a hard cutoff, and keeps size and unit', async () => {
    const t = await harness();
    const image = t.fromFn(4, 1, (x) => [255, 0, 0, x * 85], 2);
    const hard = await t.run('alpha-to-mask', { threshold: 0.5 }, { image });
    const px = await t.pixels(hard.mask as never);
    expect([px.at(1, 0)[0], px.at(2, 0)[0], px.at(3, 0)[0]]).toEqual([0, 255, 255]);
    expect((hard.mask as { unit: number }).unit).toBe(2);
    const inv = await t.pixels((await t.run('alpha-to-mask', { invert: true }, { image })).mask as never);
    expect(inv.at(0, 0)[0]).toBe(255);
    expect(inv.at(3, 0)[0]).toBe(0);
  });
});
