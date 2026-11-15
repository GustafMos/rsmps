import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('posterize snaps channels to the given number of steps', async () => {
  const t = await harness();
  const src = t.fromFn(16, 1, (x) => [x * 16, x * 16, x * 16, 255]);
  const px = await t.pixels((await t.run('posterize', { steps: 2 }, { image: src })).image as never);
  const values = new Set<number>();
  for (let x = 0; x < 16; x++) values.add(px.at(x, 0)[0]);
  expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
  const four = await t.pixels((await t.run('posterize', { steps: 4 }, { image: src })).image as never);
  const v4 = new Set<number>();
  for (let x = 0; x < 16; x++) v4.add(four.at(x, 0)[0]);
  expect(v4.size).toBe(4);
});

it('posterize keeps alpha', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('posterize', {}, { image: t.solid(4, 4, [10, 10, 10, 128]) })).image as never);
  expect(px.at(1, 1)[3]).toBe(128);
});
