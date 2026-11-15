import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

const lamp = (w: number, h: number) => (x: number, y: number): [number, number, number, number] =>
  Math.hypot(x / w - 0.5, y / h - 0.5) < 0.1 ? [255, 255, 255, 255] : [30, 30, 30, 255];

it('bloom spreads light from bright areas onto dark neighbours', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, lamp(64, 64));
  const px = await t.pixels((await t.run('bloom', { radius: 6, intensity: 1 }, { image: src })).image as never);
  expect(px.at(32 + 10, 32)[0]).toBeGreaterThan(60); // was 30
  expect(px.at(32, 32)[0]).toBe(255);
  expect(px.at(2, 2)[0]).toBeLessThan(50);
});

it('bloom lights up transparent surroundings of a bright sprite and keeps far alpha at 0', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 5 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const px = await t.pixels((await t.run('bloom', { radius: 4, intensity: 1.5 }, { image: src })).image as never);
  expect(px.at(32 + 8, 32)[3]).toBeGreaterThan(5);
  expect(px.at(0, 0)[3]).toBe(0);
});

it('bloom with no intensity returns the input; radius scales with resolution', async () => {
  const t = await harness();
  const src = t.solid(8, 8, [255, 255, 255, 255]);
  expect((await t.run('bloom', { intensity: 0 }, { image: src })).image).toBe(src);
  expect(await resolutionDiff(t, 'bloom', { radius: 4, intensity: 1 }, lamp)).toBeLessThan(6);
});
