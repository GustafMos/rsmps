import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('tint pulls colours toward the tint colour', async () => {
  const t = await harness();
  const src = t.solid(4, 4, [128, 128, 128, 255]);
  const px = await t.pixels((await t.run('tint', { color: [1, 0, 0, 1], amount: 1, preserveLuma: false }, { image: src })).image as never);
  expect(px.at(1, 1).slice(0, 3)).toEqual([255, 0, 0]);
});

it('keeps brightness when asked and preserves alpha', async () => {
  const t = await harness();
  const src = t.solid(4, 4, [128, 128, 128, 255]);
  const px = await t.pixels((await t.run('tint', { color: [1, 0.5, 0.2, 1], amount: 1, preserveLuma: true }, { image: src })).image as never);
  const [r, g, b] = px.at(1, 1);
  expect(r).toBeGreaterThan(b);
  expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(110);
  expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeLessThan(146);
  const clear = await t.pixels((await t.run('tint', {}, { image: t.solid(4, 4, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(1, 1)[3]).toBe(0);
});
