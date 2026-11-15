import { expect, it } from 'vitest';
import { harness } from '../../testing';

const pal: [number, number, number][] = [[1, 0, 0], [0, 0, 1]];

it('maps dark to the first colour and light to the last', async () => {
  const t = await harness();
  const src = t.fromFn(8, 1, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const px = await t.pixels((await t.run('gradient-map', { palette: pal }, { image: src })).image as never);
  expect(px.at(1, 0).slice(0, 3)).toEqual([255, 0, 0]);
  expect(px.at(6, 0).slice(0, 3)).toEqual([0, 0, 255]);
});

it('interpolates in between, can reverse, and keeps alpha', async () => {
  const t = await harness();
  const mid = await t.pixels((await t.run('gradient-map', { palette: pal }, { image: t.solid(4, 4, [188, 188, 188, 255]) })).image as never);
  expect(mid.at(1, 1)[0]).toBeGreaterThan(40);
  expect(mid.at(1, 1)[0]).toBeLessThan(215);
  const rev = await t.pixels((await t.run('gradient-map', { palette: pal, reverse: true }, { image: t.solid(4, 4, [0, 0, 0, 255]) })).image as never);
  expect(rev.at(1, 1)[2]).toBe(255);
  const clear = await t.pixels((await t.run('gradient-map', {}, { image: t.solid(4, 4, [9, 9, 9, 0]) })).image as never);
  expect(clear.at(1, 1)[3]).toBe(0);
});

it('a single-colour palette in stepped mode gives a flat colour', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('gradient-map', { palette: [[0, 1, 0]], stepped: true }, { image: t.solid(4, 4, [10, 10, 10, 255]) })).image as never);
  expect(px.at(1, 1).slice(0, 3)).toEqual([0, 255, 0]);
});
