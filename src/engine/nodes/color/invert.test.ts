import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('invert flips colours and keeps alpha', async () => {
  const t = await harness();
  const out = await t.run('invert', {}, { image: t.solid(8, 8, [200, 100, 0, 255]) });
  const px = await t.pixels(out.image as never);
  expect(px.at(2, 2)[0]).toBeCloseTo(55, -1);
  expect(px.at(2, 2)[1]).toBeCloseTo(155, -1);
  expect(px.at(2, 2)[2]).toBeGreaterThan(245);
  const clear = await t.pixels((await t.run('invert', {}, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(1, 1)[3]).toBe(0);
});

it('lightness mode keeps the hue family and amount 0 is a no-op', async () => {
  const t = await harness();
  const src = t.solid(4, 4, [200, 40, 40, 255]);
  const px = await t.pixels((await t.run('invert', { mode: 'lightness' }, { image: src })).image as never);
  expect(px.at(1, 1)[0]).toBeGreaterThan(px.at(1, 1)[2]);
  expect(px.at(1, 1)[0]).toBeLessThan(200);
  const same = await t.run('invert', { amount: 0 }, { image: src });
  expect(same.image).toBe(src);
});
