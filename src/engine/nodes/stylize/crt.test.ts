import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('curves the screen: corners go black, centre stays', async () => {
  const t = await harness();
  const src = t.solid(64, 64, [200, 200, 200, 255]);
  const px = await t.pixels((await t.run('crt', { curvature: 0.8, scanlines: 0, mask: 0, glow: 0 }, { image: src })).image as never);
  expect(px.at(0, 0).slice(0, 3)).toEqual([0, 0, 0]);
  expect(px.at(0, 0)[3]).toBe(255);
  expect(Math.abs(px.at(32, 32)[0] - 200)).toBeLessThan(8);
});

it('scanlines and phosphor mask add structure; transparent outside option', async () => {
  const t = await harness();
  const src = t.solid(48, 48, [180, 180, 180, 255]);
  const px = await t.pixels((await t.run('crt', { curvature: 0, scanlines: 1, mask: 1, glow: 0, lineSize: 4 }, { image: src })).image as never);
  const rows = [0, 1, 2, 3].map((y) => px.at(20, y + 20)[1]);
  expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThan(30);
  const cols = [0, 1, 2, 3, 4, 5].map((x) => px.at(x + 20, 22));
  expect(cols.some((c) => c[0] !== c[2])).toBe(true);
  const open = await t.pixels((await t.run('crt', { curvature: 0.8, blackCorners: false }, { image: src })).image as never);
  expect(open.at(0, 0)[3]).toBe(0);
});

it('keeps source transparency inside the screen; all-zero is a no-op; resolution independent', async () => {
  const t = await harness();
  const clear = t.solid(32, 32, [0, 0, 0, 0]);
  expect((await t.pixels((await t.run('crt', { curvature: 0.2 }, { image: clear })).image as never)).at(16, 16)[3]).toBe(0);
  const src = t.solid(8, 8, [1, 2, 3, 255]);
  expect((await t.run('crt', { curvature: 0, scanlines: 0, mask: 0, glow: 0 }, { image: src })).image).toBe(src);
  expect(await resolutionDiff(t, 'crt', { lineSize: 4 }, scalable)).toBeLessThan(10);
});
