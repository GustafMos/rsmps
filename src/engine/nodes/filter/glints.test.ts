import { expect, it } from 'vitest';
import { harness } from '../../testing';

const lamp = (x: number, y: number): [number, number, number, number] => (Math.hypot(x - 48, y - 48) < 3 ? [255, 255, 255, 255] : [20, 20, 20, 255]);

it('glints throw rays from a bright point along the star directions only', async () => {
  const t = await harness();
  const src = t.fromFn(96, 96, lamp);
  const px = await t.pixels((await t.run('glints', { points: 4, angle: 0, length: 40, intensity: 2 }, { image: src })).image as never);
  expect(px.at(48 + 14, 48)[0]).toBeGreaterThan(45); // along the horizontal ray
  expect(px.at(48, 48 - 14)[0]).toBeGreaterThan(45); // along the vertical ray
  expect(px.at(48 + 12, 48 + 12)[0]).toBeLessThan(30); // not on the diagonal
  expect(px.at(48, 48)[0]).toBe(255);
  // nearer the light is brighter
  expect(px.at(48 + 8, 48)[0]).toBeGreaterThan(px.at(48 + 24, 48)[0]);
});

it('glints: nothing below the threshold, intensity 0 returns the input, rays only drops the picture', async () => {
  const t = await harness();
  const dim = t.solid(16, 16, [90, 90, 90, 255]);
  const px = await t.pixels((await t.run('glints', { length: 10 }, { image: dim })).image as never);
  expect(px.at(8, 8)[0]).toBe(90);
  expect((await t.run('glints', { intensity: 0 }, { image: dim })).image).toBe(dim);
  const src = t.fromFn(96, 96, lamp);
  const only = await t.pixels((await t.run('glints', { points: 2, angle: 0, length: 40, intensity: 2, only: true }, { image: src })).image as never);
  expect(only.at(4, 4)[3]).toBe(0);
  expect(only.at(48 + 10, 48)[0]).toBeGreaterThan(20);
});
