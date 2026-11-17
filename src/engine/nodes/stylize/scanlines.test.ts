import { expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

it('scanlines darken regularly spaced rows', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('scanlines', { spacing: 4, strength: 0.8 }, { image: t.solid(16, 16, [200, 200, 200, 255]) })).image as never);
  const col = [0, 1, 2, 3].map((y) => px.at(5, y)[0]);
  expect(Math.min(...col)).toBeLessThan(120);
  expect(Math.max(...col)).toBeGreaterThan(190);
  expect(px.at(5, 0)[0]).toBe(px.at(5, 4)[0]);
  expect(px.at(5, 1)[0]).toBe(px.at(5, 5)[0]);
  expect(px.at(5, 3)[3]).toBe(255);
});

it('keeps transparency and strength 0 is a no-op', async () => {
  const t = await harness();
  const clear = t.solid(8, 8, [0, 0, 0, 0]);
  expect((await t.pixels((await t.run('scanlines', {}, { image: clear })).image as never)).at(2, 2)[3]).toBe(0);
  const src = t.solid(8, 8, [9, 9, 9, 255]);
  expect((await t.run('scanlines', { strength: 0 }, { image: src })).image).toBe(src);
});

it('scrolls and loops with whole cycles; spacing follows resolution', async () => {
  const t = await harness();
  const src = t.solid(32, 32, [200, 200, 200, 255]);
  const r = await t.loopCheck('scanlines', { spacing: 8, strength: 0.8, cycles: 1 }, { image: src });
  expect(r.seam).toBeLessThan(LOOP_SEAM_OK);
  expect(r.motion).toBeGreaterThan(1);
  const still = await t.loopCheck('scanlines', { spacing: 8, strength: 0.8, cycles: 0 }, { image: src });
  expect(still.motion).toBe(0);
  expect(await resolutionDiff(t, 'scanlines', { spacing: 8, strength: 0.6 }, () => () => [200, 200, 200, 255])).toBeLessThan(6);
});
