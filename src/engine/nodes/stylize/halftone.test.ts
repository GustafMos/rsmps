import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

it('mono: mid grey gives a mix of ink and paper, white gives paper, black gives ink', async () => {
  const t = await harness();
  const opts = { dotSize: 8, ink: [0, 0, 0, 1], paper: [1, 1, 1, 1] };
  const mid = await t.pixels((await t.run('halftone', opts, { image: t.solid(48, 48, [128, 128, 128, 255]) })).image as never);
  let dark = 0;
  let light = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) (mid.at(x, y)[0] < 60 ? dark++ : mid.at(x, y)[0] > 200 ? light++ : 0);
  expect(dark).toBeGreaterThan(200);
  expect(light).toBeGreaterThan(200);
  const white = await t.pixels((await t.run('halftone', opts, { image: t.solid(24, 24, [255, 255, 255, 255]) })).image as never);
  expect(white.at(5, 5)[0]).toBe(255);
  const black = await t.pixels((await t.run('halftone', opts, { image: t.solid(24, 24, [0, 0, 0, 255]) })).image as never);
  expect(black.at(5, 5)[0]).toBeLessThan(10);
});

it('cmyk: a red area keeps red-ish output, and alpha survives', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('halftone', { mode: 'cmyk', dotSize: 6, paper: [1, 1, 1, 1] }, { image: t.solid(48, 48, [255, 0, 0, 255]) })).image as never);
  let r = 0;
  let b = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) { r += px.at(x, y)[0]; b += px.at(x, y)[2]; }
  expect(r).toBeGreaterThan(b * 1.5);
  const clear = await t.pixels((await t.run('halftone', {}, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(2, 2)[3]).toBe(0);
});

it('dot size follows resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'halftone', { dotSize: 8 }, () => () => [128, 128, 128, 255])).toBeLessThan(25);
});
