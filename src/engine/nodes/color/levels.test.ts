import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('levels stretches between black and white points', async () => {
  const t = await harness();
  const src = t.fromFn(8, 1, (x) => [x * 32, x * 32, x * 32, 255]);
  const px = await t.pixels((await t.run('levels', { inBlack: 0.25, inWhite: 0.75 }, { image: src })).image as never);
  expect(px.at(1, 0)[0]).toBe(0); // 32/255 < 0.25
  expect(px.at(7, 0)[0]).toBe(255);
  expect(px.at(4, 0)[0]).toBeGreaterThan(110);
  expect(px.at(4, 0)[0]).toBeLessThan(145);
});

it('gamma brightens midtones, output range clamps, alpha survives', async () => {
  const t = await harness();
  const mid = t.solid(4, 4, [128, 128, 128, 255]);
  expect((await t.pixels((await t.run('levels', { gamma: 2 }, { image: mid })).image as never)).at(1, 1)[0]).toBeGreaterThan(170);
  expect((await t.pixels((await t.run('levels', { outBlack: 0.2, outWhite: 0.6 }, { image: mid })).image as never)).at(1, 1)[0]).toBeLessThan(160);
  const clear = await t.pixels((await t.run('levels', { gamma: 2 }, { image: t.solid(4, 4, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(1, 1)[3]).toBe(0);
});
