import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('set-alpha', () => {
  it('multiplies existing alpha by the mask', async () => {
    const t = await harness();
    const image = t.solid(8, 8, [255, 0, 0, 200]);
    const mask = t.maskFn(8, 8, (x) => (x < 4 ? 1 : 0.5));
    const px = await t.pixels((await t.run('set-alpha', {}, { image, mask })).image as never);
    expect(px.at(1, 1)[3]).toBe(200);
    expect(Math.abs(px.at(6, 1)[3] - 100)).toBeLessThanOrEqual(1);
    expect(px.at(6, 1)[0]).toBe(255);
  });

  it('replaces alpha, with invert', async () => {
    const t = await harness();
    const image = t.solid(8, 8, [0, 255, 0, 40]);
    const mask = t.maskFn(8, 8, (x) => (x < 4 ? 1 : 0));
    const px = await t.pixels((await t.run('set-alpha', { mode: 'replace' }, { image, mask })).image as never);
    expect(px.at(1, 1)).toEqual([0, 255, 0, 255]);
    expect(px.at(6, 1)[3]).toBe(0);
    const inv = await t.pixels((await t.run('set-alpha', { mode: 'replace', invert: true }, { image, mask })).image as never);
    expect(inv.at(1, 1)[3]).toBe(0);
    expect(inv.at(6, 1)).toEqual([0, 255, 0, 255]);
  });

  it('keeps transparent input transparent when multiplying and is a no-op without a mask', async () => {
    const t = await harness();
    const clear = t.solid(4, 4, [0, 0, 0, 0]);
    const mask = t.maskFn(4, 4, () => 1);
    expect((await t.pixels((await t.run('set-alpha', {}, { image: clear, mask })).image as never)).at(1, 1)[3]).toBe(0);
    expect((await t.run('set-alpha', {}, { image: clear })).image).toBe(clear);
  });

  it('stretches a mask of another size over the image', async () => {
    const t = await harness();
    const image = t.solid(8, 8, [255, 255, 255, 255], 2);
    const mask = t.maskFn(2, 2, (x) => (x === 0 ? 1 : 0));
    const out = await t.run('set-alpha', {}, { image, mask });
    const px = await t.pixels(out.image as never);
    expect((out.image as { unit: number }).unit).toBe(2);
    expect(px.at(0, 4)[3]).toBe(255);
    expect(px.at(7, 4)[3]).toBe(0);
  });
});
