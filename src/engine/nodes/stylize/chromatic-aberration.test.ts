import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

const bar = (x: number, from = 28): [number, number, number, number] => (x >= from && x < from + 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]);

it('splits red and blue sideways (linear)', async () => {
  const t = await harness();
  const src = t.fromFn(64, 16, (x) => bar(x));
  const px = await t.pixels((await t.run('chromatic-aberration', { amount: 2, radial: false, angle: 0 }, { image: src })).image as never);
  // red is sampled from the right, blue from the left: red extends left of the bar, blue right of it
  expect(px.at(26, 8)[0]).toBeGreaterThan(px.at(26, 8)[2] + 100);
  expect(px.at(37, 8)[2]).toBeGreaterThan(px.at(37, 8)[0] + 100);
  expect(px.at(32, 8).slice(0, 3)).toEqual([255, 255, 255]);
});

it('radial mode shifts more toward the edges; alpha survives', async () => {
  const t = await harness();
  const right = t.fromFn(64, 16, (x) => bar(x, 54));
  const px = await t.pixels((await t.run('chromatic-aberration', { amount: 6 }, { image: right })).image as never);
  expect(px.at(51, 8)[0]).toBeGreaterThan(px.at(51, 8)[2] + 100);
  const centre = t.fromFn(64, 16, (x) => bar(x));
  const c = await t.pixels((await t.run('chromatic-aberration', { amount: 6 }, { image: centre })).image as never);
  expect(c.at(32, 8).slice(0, 3)).toEqual([255, 255, 255]);
  const clear = await t.pixels((await t.run('chromatic-aberration', {}, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(2, 2)[3]).toBe(0);
});

it('amount follows resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'chromatic-aberration', { amount: 2 }, scalable)).toBeLessThan(4);
});
