import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('flip', () => {
  const make = (t: Awaited<ReturnType<typeof harness>>) => t.fromFn(4, 2, (x, y) => [x * 50, y * 100, 0, x === 0 && y === 0 ? 128 : 255]);

  it('flips horizontally and vertically', async () => {
    const t = await harness();
    const h = await t.pixels((await t.run('flip', { horizontal: true }, { image: make(t) })).image as never);
    expect(h.at(0, 0)[0]).toBe(150);
    expect(h.at(3, 0)[3]).toBeGreaterThan(120);
    const v = await t.pixels((await t.run('flip', { vertical: true }, { image: make(t) })).image as never);
    expect(v.at(1, 0)).toEqual([50, 100, 0, 255]);
  });

  it('turns 90, 180 and 270 degrees clockwise', async () => {
    const t = await harness();
    const r90 = await t.pixels((await t.run('flip', { rotate: '90' }, { image: make(t) })).image as never);
    expect([r90.width, r90.height]).toEqual([2, 4]);
    // source top-left (alpha 128) goes to top-right
    expect(Math.abs(r90.at(1, 0)[3] - 128)).toBeLessThanOrEqual(1);
    expect(r90.at(0, 0)).toEqual([0, 100, 0, 255]);
    const r180 = await t.pixels((await t.run('flip', { rotate: '180' }, { image: make(t) })).image as never);
    expect(Math.abs(r180.at(3, 1)[3] - 128)).toBeLessThanOrEqual(1);
    const r270 = await t.pixels((await t.run('flip', { rotate: '270' }, { image: make(t) })).image as never);
    expect([r270.width, r270.height]).toEqual([2, 4]);
    expect(Math.abs(r270.at(0, 3)[3] - 128)).toBeLessThanOrEqual(1);
    expect(r270.at(0, 0)).toEqual([150, 0, 0, 255]);
  });

  it('is a no-op by default', async () => {
    const t = await harness();
    const src = make(t);
    expect((await t.run('flip', {}, { image: src })).image).toBe(src);
  });
});
