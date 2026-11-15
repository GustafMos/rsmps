import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('blurs along the chosen angle only', async () => {
  const t = await harness();
  const stripe = t.fromFn(32, 32, (x) => (x === 16 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const h = await t.pixels((await t.run('directional-blur', { angle: 0, length: 10 }, { image: stripe })).image as never);
  expect(h.at(12, 8)[0]).toBeGreaterThan(10); // smeared sideways
  const v = await t.pixels((await t.run('directional-blur', { angle: 90, length: 10 }, { image: stripe })).image as never);
  expect(v.at(12, 8)[0]).toBe(0); // vertical blur leaves a vertical stripe alone
  expect(v.at(16, 8)[0]).toBeGreaterThan(240);
});

it('keeps alpha and is a no-op at length 0', async () => {
  const t = await harness();
  const clear = t.solid(8, 8, [0, 0, 0, 0]);
  expect((await t.pixels((await t.run('directional-blur', { length: 8 }, { image: clear })).image as never)).at(3, 3)[3]).toBe(0);
  const same = await t.run('directional-blur', { length: 0 }, { image: clear });
  expect(same.image).toBe(clear);
});

it('length scales with resolution', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'directional-blur', { angle: 30, length: 6 }, scalable)).toBeLessThan(5);
});
