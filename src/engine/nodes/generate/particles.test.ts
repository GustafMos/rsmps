import { expect, it } from 'vitest';
import { harness } from '../../testing';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 128, height: 128, lengthMode: 'absolute' as const };
const PRESETS = ['dust', 'snow', 'rain', 'sparks', 'bubbles', 'fireflies', 'confetti', 'stars'];

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

it('every preset draws particles on a transparent background', async () => {
  const t = await H();
  for (const preset of PRESETS) {
    const out = await t.run('particles', { preset, count: 40, particleSize: 3 }, {}, { project: proj, seconds: 1 });
    const s = stats((await t.pixels(out.image as never)).data);
    expect(s.nonEmpty, preset).toBeGreaterThan(30);
    expect(s.covered, preset).toBeLessThan(0.6);
  }
});

it('is deterministic per seed and differs between seeds; follows the size input', async () => {
  const t = await H();
  const grab = async (seed: number) => Buffer.from((await t.pixels((await t.run('particles', { seed }, {}, { project: proj, seconds: 0.7 })).image as never)).data);
  const [a, b, c] = [await grab(5), await grab(5), await grab(6)];
  expect(a.equals(b)).toBe(true);
  expect(a.equals(c)).toBe(false);
  const out = await t.run('particles', {}, { size: t.solid(50, 30, [0, 0, 0, 255]) });
  expect([(out.image as { width: number }).width, (out.image as { height: number }).height]).toEqual([50, 30]);
});
