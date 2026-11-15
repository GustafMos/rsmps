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

it('uses custom colours when the preset colours are off, and respects opacity', async () => {
  const t = await H();
  const red: [number, number, number, number] = [1, 0, 0, 1];
  const px = await t.pixels(
    (await t.run('particles', { preset: 'snow', presetColors: false, colorA: red, colorB: red, count: 200, soft: false }, {}, { project: proj, seconds: 1 })).image as never,
  );
  let reds = 0;
  let others = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    if (px.data[i + 3] > 200) (px.data[i] > 240 && px.data[i + 1] < 15 && px.data[i + 2] < 15 ? reds++ : others++);
  }
  expect(reds).toBeGreaterThan(50);
  expect(others).toBe(0);
  const faint = stats(
    (await t.pixels((await t.run('particles', { preset: 'snow', presetColors: false, colorA: red, colorB: red, count: 200, soft: false, opacity: 0.3 }, {}, { project: proj, seconds: 1 })).image as never)).data,
  );
  const full = stats(px.data);
  expect(faint.mean).toBeLessThan(full.mean * 0.5);
});
