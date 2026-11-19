import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { lensFillScale, lensK, lensSource } from './lens-distortion.node';

it('the lens model inverts exactly, and Fill the frame leaves no empty edge', () => {
  for (const amount of [-0.8, -0.3, 0.3, 1]) {
    const k = lensK(amount);
    const d = lensSource(0.4, -0.3, k, false)!;
    const back = lensSource(d[0], d[1], k, true)!;
    expect(back[0]).toBeCloseTo(0.4, 6);
    expect(back[1]).toBeCloseTo(-0.3, 6);
  }
  // barrel reads beyond the frame at the corners, so it has to zoom in; pincushion reads inside
  expect(lensFillScale(lensK(0.5), false, 160, 90)).toBeLessThan(0.95);
  expect(lensFillScale(lensK(-0.5), false, 160, 90)).toBe(1);
  expect(lensFillScale(lensK(0), false, 160, 90)).toBe(1);
});

const checker = (x: number, y: number): [number, number, number, number] => {
  const g = 40 + Math.round((x / 64) * 120) + ((x >> 3) + (y >> 3)) % 2 * 60;
  return [g, Math.round((y / 64) * 200), 90, 255];
};

it('lens distortion bends the picture, and undistort with the same amount gives it back', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, checker);
  expect((await t.run('lens-distortion', { amount: 0 }, { image: src })).image).toBe(src);
  const bent = (await t.run('lens-distortion', { amount: 0.5, fill: false }, { image: src })).image;
  const bp = await t.pixels(bent as never);
  expect(bp.at(32, 32)[1]).toBeGreaterThan(90); // the centre stays
  expect(bp.at(0, 0)[3]).toBe(0); // barrel: the corners are empty
  const back = await t.pixels((await t.run('lens-distortion', { mode: 'undistort', amount: 0.5, fill: false }, { image: bent as never })).image as never);
  const sp = await t.pixels(src as never);
  let diff = 0;
  let n = 0;
  for (let y = 16; y < 48; y += 2)
    for (let x = 16; x < 48; x += 2) {
      diff += Math.abs(back.at(x, y)[1] - sp.at(x, y)[1]);
      n++;
    }
  expect(diff / n).toBeLessThan(6);
});

it('Fill the frame leaves no transparent pixel', async () => {
  const t = await harness();
  const src = t.solid(48, 32, [200, 100, 50, 255]);
  const px = await t.pixels((await t.run('lens-distortion', { amount: 0.7, fill: true }, { image: src })).image as never);
  for (const [x, y] of [[0, 0], [47, 0], [0, 31], [47, 31], [24, 0], [0, 16]]) expect(px.at(x, y)[3]).toBeGreaterThan(250);
});
