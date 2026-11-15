import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

const sprite = (w: number, h: number) => (x: number, y: number): [number, number, number, number] =>
  x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7 ? [255, 255, 255, 255] : [0, 0, 0, 0];

it('outside outline grows around the sprite and leaves the sprite and far space alone', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, sprite(64, 64));
  const px = await t.pixels((await t.run('outline', { thickness: 3, color: [1, 0, 0, 1] }, { image: src })).image as never);
  expect(px.at(32, 32)).toEqual([255, 255, 255, 255]);
  const near = px.at(19 - 1, 32); // just outside the left edge (x=19 is the first sprite column)
  expect(near[3]).toBeGreaterThan(200);
  expect(near[0]).toBeGreaterThan(200);
  expect(near[1]).toBeLessThan(40);
  expect(px.at(19 - 6, 32)[3]).toBe(0);
  expect(px.at(2, 2)[3]).toBe(0);
});

it('inside outline recolours the rim without changing the silhouette', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, sprite(64, 64));
  const px = await t.pixels((await t.run('outline', { thickness: 3, position: 'inside', color: [0, 0, 1, 1], sharp: true }, { image: src })).image as never);
  expect(px.at(20, 32)[2]).toBeGreaterThan(200);
  expect(px.at(20, 32)[0]).toBeLessThan(40);
  expect(px.at(32, 32)).toEqual([255, 255, 255, 255]);
  expect(px.at(15, 32)[3]).toBe(0);
});

it('centre mode straddles the edge; thin or invisible outlines are a no-op', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, sprite(64, 64));
  const px = await t.pixels((await t.run('outline', { thickness: 4, position: 'center', color: [0, 1, 0, 1] }, { image: src })).image as never);
  expect(px.at(19, 32)[3]).toBeGreaterThan(150);
  expect(px.at(21, 32)[1]).toBeGreaterThan(150);
  expect(px.at(21, 32)[0]).toBeLessThan(120);
  expect((await t.run('outline', { thickness: 0 }, { image: src })).image).toBe(src);
});

it('thickness follows resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'outline', { thickness: 2 }, sprite)).toBeLessThan(6);
});
