import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('changes the picture and adds paper grain to flat areas', async () => {
  const t = await harness();
  const src = t.solid(32, 32, [128, 128, 128, 255]);
  const px = await t.pixels((await t.run('watercolor', { paper: 1 }, { image: src })).image as never);
  const vals = new Set<number>();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) vals.add(px.at(x, y)[0]);
  expect(vals.size).toBeGreaterThan(4);
  const none = await t.pixels((await t.run('watercolor', { paper: 0, edges: 0 }, { image: src })).image as never);
  expect(none.at(10, 10)[0]).toBeGreaterThan(120);
  expect(none.at(10, 10)[0]).toBeLessThan(136);
});

it('darkens along edges', async () => {
  const t = await harness();
  const src = t.fromFn(48, 48, (x) => (x < 24 ? [200, 200, 200, 255] : [230, 230, 230, 255]));
  const on = await t.pixels((await t.run('watercolor', { paper: 0, edges: 1, radius: 2, softness: 0.1 }, { image: src })).image as never);
  const off = await t.pixels((await t.run('watercolor', { paper: 0, edges: 0, radius: 2, softness: 0.1 }, { image: src })).image as never);
  expect(on.at(24, 24)[0]).toBeLessThan(off.at(24, 24)[0] - 10);
  expect(on.at(4, 24)[0]).toBe(off.at(4, 24)[0]);
});

it('keeps transparency; strength 0 is a no-op; sizes follow resolution', async () => {
  const t = await harness();
  const clear = t.solid(16, 16, [0, 0, 0, 0]);
  expect((await t.pixels((await t.run('watercolor', {}, { image: clear })).image as never)).at(4, 4)[3]).toBe(0);
  expect((await t.run('watercolor', { strength: 0 }, { image: clear })).image).toBe(clear);
  expect(await resolutionDiff(t, 'watercolor', { radius: 2, paperScale: 3 }, scalable)).toBeLessThan(12);
});
