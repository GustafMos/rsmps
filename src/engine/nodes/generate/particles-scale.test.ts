import { expect, it } from 'vitest';
import { harness } from '../../testing';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 128, height: 128, lengthMode: 'absolute' as const };

/** Fraction of pixels with any alpha, and mean alpha. */
function stats(data: Uint8ClampedArray) {
  let covered = 0;
  let sum = 0;
  let nonEmpty = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) nonEmpty++;
    if (data[i] > 8) covered++;
    sum += data[i];
  }
  return { covered: covered / (data.length / 4), mean: sum / (data.length / 4), nonEmpty };
}

it('more particles cover more of the image; handles thousands', async () => {
  const t = await H();
  const few = stats((await t.pixels((await t.run('particles', { count: 40 }, {}, { project: proj, seconds: 1 })).image as never)).data);
  const lots = stats((await t.pixels((await t.run('particles', { count: 4000, particleSize: 3 }, {}, { project: proj, seconds: 1 })).image as never)).data);
  expect(lots.mean).toBeGreaterThan(few.mean * 3);
  const huge = await t.run('particles', { count: 20000, particleSize: 2 }, {}, { project: { width: 512, height: 512 }, seconds: 1 });
  expect((huge.image as { width: number }).width).toBe(512);
});

it('particle size is a length: unit 2 gives particles twice as big', async () => {
  const t = await H();
  const p = { preset: 'dust', count: 30, soft: false, particleSize: 8, opacity: 1 };
  const small = stats((await t.pixels((await t.run('particles', p, { size: t.solid(100, 100, [0, 0, 0, 255], 1) }, { seconds: 1 })).image as never)).data);
  const big = stats((await t.pixels((await t.run('particles', p, { size: t.solid(200, 200, [0, 0, 0, 255], 2) }, { seconds: 1 })).image as never)).data);
  // same picture at twice the resolution -> same fraction covered
  expect(Math.abs(big.covered - small.covered)).toBeLessThan(small.covered * 0.35 + 0.002);
});
