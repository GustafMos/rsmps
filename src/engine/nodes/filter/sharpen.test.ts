import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

const edge = (x: number): [number, number, number, number] => (x < 16 ? [100, 100, 100, 255] : [160, 160, 160, 255]);

it('sharpen overshoots on both sides of an edge and leaves flat areas alone', async () => {
  const t = await harness();
  const src = t.fromFn(32, 8, (x) => edge(x));
  const px = await t.pixels((await t.run('sharpen', { amount: 2, radius: 3 }, { image: src })).image as never);
  expect(px.at(14, 4)[0]).toBeLessThan(95);
  expect(px.at(17, 4)[0]).toBeGreaterThan(165);
  expect(px.at(2, 4)[0]).toBe(100);
  expect(px.at(29, 4)[0]).toBe(160);
});

it('sharpen keeps transparent areas transparent', async () => {
  const t = await harness();
  const src = t.fromFn(32, 32, (x, y) => (x > 10 && x < 22 && y > 10 && y < 22 ? [200, 50, 50, 255] : [0, 0, 0, 0]));
  const px = await t.pixels((await t.run('sharpen', { amount: 2, radius: 2 }, { image: src })).image as never);
  expect(px.at(2, 2)[3]).toBe(0);
  expect(px.at(16, 16)[3]).toBe(255);
});

it('sharpen radius scales with resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'sharpen', { amount: 1.5, radius: 2 }, scalable)).toBeLessThan(6);
});
