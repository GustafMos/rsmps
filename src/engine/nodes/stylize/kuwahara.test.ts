import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('flattens noise but keeps a hard edge', async () => {
  const t = await harness();
  const src = t.fromFn(48, 48, (x, y) => {
    const base = x < 24 ? 40 : 210;
    const n = ((x * 7 + y * 13) % 5) * 6 - 12;
    return [base + n, base + n, base + n, 255];
  });
  const px = await t.pixels((await t.run('kuwahara', { radius: 4 }, { image: src })).image as never);
  const before = await t.pixels(src);
  const spreadAfter = Math.max(...[0, 1, 2, 3, 4, 5].map((i) => px.at(6 + i, 10)[0])) - Math.min(...[0, 1, 2, 3, 4, 5].map((i) => px.at(6 + i, 10)[0]));
  const spreadBefore = Math.max(...[0, 1, 2, 3, 4, 5].map((i) => before.at(6 + i, 10)[0])) - Math.min(...[0, 1, 2, 3, 4, 5].map((i) => before.at(6 + i, 10)[0]));
  expect(spreadAfter).toBeLessThan(spreadBefore);
  expect(px.at(20, 20)[0]).toBeLessThan(80); // still dark just left of the edge
  expect(px.at(27, 20)[0]).toBeGreaterThan(170); // still light just right of it
});

it('keeps alpha and radius 0 is a no-op', async () => {
  const t = await harness();
  const clear = t.solid(16, 16, [0, 0, 0, 0]);
  expect((await t.pixels((await t.run('kuwahara', { radius: 3 }, { image: clear })).image as never)).at(5, 5)[3]).toBe(0);
  expect((await t.run('kuwahara', { radius: 0 }, { image: clear })).image).toBe(clear);
  const sprite = t.fromFn(32, 32, (x, y) => (Math.hypot(x - 16, y - 16) < 8 ? [200, 30, 30, 255] : [0, 0, 0, 0]));
  const px = await t.pixels((await t.run('kuwahara', { radius: 3 }, { image: sprite })).image as never);
  expect(px.at(16, 16)[3]).toBe(255);
  expect(px.at(2, 2)[3]).toBe(0);
  expect(px.at(16, 16)[0]).toBeGreaterThan(190);
});

it('brush size follows resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'kuwahara', { radius: 3 }, scalable)).toBeLessThan(8);
});
