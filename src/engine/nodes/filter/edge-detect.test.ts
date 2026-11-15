import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('finds the edge of the red square and leaves flat areas black', async () => {
  const t = await harness();
  const src = t.fromFn(32, 32, (x, y) => (x > 10 && x < 22 && y > 10 && y < 22 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const out = await t.run('edge-detect', {}, { image: src });
  const img = await t.pixels(out.image as never);
  const mask = await t.pixels(out.mask as never);
  expect(img.at(16, 16)[0]).toBe(0);
  expect(img.at(2, 2)[0]).toBe(0);
  expect(img.at(10, 16)[0]).toBeGreaterThan(200);
  expect(mask.at(10, 16)[0]).toBeGreaterThan(200);
  expect(mask.at(16, 16)[0]).toBe(0);
});

it('detects alpha edges of a sprite and lines-only keeps the rest transparent', async () => {
  const t = await harness();
  const src = t.fromFn(32, 32, (x, y) => (x > 10 && x < 22 && y > 10 && y < 22 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const px = await t.pixels((await t.run('edge-detect', { look: 'lines-only' }, { image: src })).image as never);
  expect(px.at(10, 16)[3]).toBeGreaterThan(150);
  expect(px.at(2, 2)[3]).toBe(0);
  expect(px.at(16, 16)[3]).toBe(0);
});

it('thickness scales with resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'edge-detect', { thickness: 1 }, scalable)).toBeLessThan(10);
});
