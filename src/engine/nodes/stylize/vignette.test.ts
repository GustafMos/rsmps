import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

it('darkens corners, leaves the centre', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('vignette', { amount: 1, radius: 0.3, softness: 0.4 }, { image: t.solid(64, 64, [200, 200, 200, 255]) })).image as never);
  expect(px.at(32, 32)[0]).toBe(200);
  expect(px.at(0, 0)[0]).toBeLessThan(40);
  expect(px.at(0, 0)[3]).toBe(255);
});

it('uses the chosen colour and keeps alpha', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('vignette', { amount: 1, radius: 0, softness: 0.1, color: [1, 0, 0, 1] }, { image: t.solid(32, 32, [0, 0, 0, 255]) })).image as never);
  expect(px.at(0, 0)[0]).toBeGreaterThan(240);
  const clear = await t.pixels((await t.run('vignette', { amount: 1 }, { image: t.solid(16, 16, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(0, 0)[3]).toBe(0);
});

it('is resolution independent', async () => {
  const t = await harness();
  expect(await resolutionDiff(t, 'vignette', {}, scalable)).toBeLessThan(3);
});
