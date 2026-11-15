import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('warps the picture', async () => {
  const t = await harness();
  const src = t.checker(64, 64, 8);
  const out = await t.run('displace', { amount: 8, scale: 20 }, { image: src }, { seconds: 0.5 });
  expect(await t.diff(src, out.image as never)).toBeGreaterThan(8);
  const px = await t.pixels(out.image as never);
  expect(px.at(10, 10)[3]).toBe(255);
});

it('amount 0 is a no-op and transparent areas stay transparent', async () => {
  const t = await harness();
  const clear = t.solid(16, 16, [0, 0, 0, 0]);
  expect((await t.run('displace', { amount: 0 }, { image: clear })).image).toBe(clear);
  expect((await t.pixels((await t.run('displace', { amount: 6 }, { image: clear })).image as never)).at(5, 5)[3]).toBe(0);
});

it('loops seamlessly and moves when animated; still when evolution is 0', async () => {
  const t = await harness();
  const src = t.checker(32, 32, 4);
  const r = await t.loopCheck('displace', { amount: 6, scale: 16, evolution: 2 }, { image: src });
  expect(r.seam).toBe(0);
  expect(r.motion).toBeGreaterThan(0.5);
  const still = await t.loopCheck('displace', { amount: 6, scale: 16, evolution: 0 }, { image: src });
  expect(still.motion).toBe(0);
});

it('amount and scale follow resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'displace', { amount: 3, scale: 20, evolution: 0 }, scalable)).toBeLessThan(6);
});
