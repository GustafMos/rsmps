import { expect, it } from 'vitest';
import { harness } from '../../testing';

const lamp = (x: number, y: number): [number, number, number, number] => (Math.hypot(x - 80, y - 45) < 6 ? [255, 255, 255, 255] : [25, 25, 25, 255]);

it('halation puts a red-orange halo around a bright light and leaves a dim picture alone', async () => {
  const t = await harness();
  const src = t.fromFn(160, 90, lamp);
  const px = await t.pixels((await t.run('halation', { look: 'nobacking' }, { image: src })).image as never);
  const near = px.at(80 + 9, 45);
  expect(near[0]).toBeGreaterThan(60); // was 25
  expect(near[0]).toBeGreaterThan(near[1] + 20); // red far above green
  expect(near[1]).toBeGreaterThanOrEqual(near[2]); // green at or above blue
  expect(px.at(4, 4)[0]).toBeLessThan(40); // far away: nothing
  // a picture without bright lights: no visible change with the film default
  const dim = t.solid(64, 36, [120, 120, 120, 255]);
  const dp = await t.pixels((await t.run('halation', {}, { image: dim })).image as never);
  expect(Math.abs(dp.at(32, 18)[0] - 120)).toBeLessThan(4);
});

it('halation: a smaller gauge has a wider halo; strength 0 returns the input', async () => {
  const t = await harness();
  const src = t.fromFn(160, 90, lamp);
  const a = await t.pixels((await t.run('halation', { look: 'film35', strength: 3 }, { image: src })).image as never);
  const b = await t.pixels((await t.run('halation', { look: 'super8', strength: 3 }, { image: src })).image as never);
  expect(b.at(80 + 14, 45)[0]).toBeGreaterThan(a.at(80 + 14, 45)[0]);
  expect((await t.run('halation', { strength: 0 }, { image: src })).image).toBe(src);
});
