import { expect, it } from 'vitest';
import { type ExposureOpts, exposureChannel, linearToSrgb, srgbToLinear } from '../../lib/color-math';
import { makeChart, maxDiff, to01 } from '../../lib/color-testutil';
import { harness } from '../../testing';

it('zero stops is the identity', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  const out = await t.pixels((await t.run('exposure', {}, { image: src })).image as never);
  expect(maxDiff(a.data, out.data)).toBeLessThanOrEqual(1);
});

it('a stop doubles / halves LINEAR light', async () => {
  const t = await harness();
  const grey = t.solid(4, 4, [100, 100, 100, 255]);
  const lin = srgbToLinear([100 / 255, 100 / 255, 100 / 255])[0];
  for (const stops of [1, -1, -2]) {
    const px = (await t.pixels((await t.run('exposure', { stops }, { image: grey })).image as never)).at(1, 1);
    expect(Math.abs(px[0] - linearToSrgb([lin * 2 ** stops, 0, 0])[0] * 255), `${stops} stops`).toBeLessThanOrEqual(1);
  }
});

it('black point lifts the floor out of the picture', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 2, (x) => [x, x, x, 255]);
  const out = await t.pixels((await t.run('exposure', { blackPoint: 0.05 }, { image: ramp })).image as never);
  expect(out.at(0, 0)[0]).toBe(0);
  expect(out.at(60, 0)[0]).toBe(0); // linear(60/255) = 0.045 < 0.05
  expect(out.at(255, 0)[0]).toBe(255);
});

it('highlight roll-off compresses instead of clipping', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 2, (x) => [x, x, x, 255]);
  const hard = await t.pixels((await t.run('exposure', { stops: 1.5 }, { image: ramp })).image as never);
  const soft = await t.pixels((await t.run('exposure', { stops: 1.5, rolloff: 0.5 }, { image: ramp })).image as never);
  // hard clip: everything above ~ 0.35 linear is pure white; soft: still distinguishable
  expect(hard.at(200, 0)[0]).toBe(255);
  expect(hard.at(230, 0)[0]).toBe(255);
  expect(soft.at(200, 0)[0]).toBeLessThan(soft.at(230, 0)[0]);
  expect(soft.at(230, 0)[0]).toBeLessThan(255);
  // monotone, never darker than the input where it is brighter
  for (let x = 1; x < 256; x++) expect(soft.at(x, 0)[0]).toBeGreaterThanOrEqual(soft.at(x - 1, 0)[0]);
});

it('matches the CPU reference for every tone map', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  const cases = [
    { stops: 0.7, blackPoint: 0.02, rolloff: 0.4, tonemap: 'none', whitePoint: 4 },
    { stops: 1.2, blackPoint: 0, rolloff: 0, tonemap: 'reinhard', whitePoint: 3 },
    { stops: 1, blackPoint: 0.01, rolloff: 0, tonemap: 'hable', whitePoint: 6 },
    { stops: -1, blackPoint: 0, rolloff: 0, tonemap: 'hable', whitePoint: 4 },
  ] as const;
  for (const c of cases) {
    const out = await t.pixels((await t.run('exposure', c, { image: src })).image as never);
    let worst = 0;
    for (let y = 0; y < input.height; y += 7) for (let x = 0; x < input.width; x += 5) {
      const lin = srgbToLinear(to01(input.at(x, y)));
      const ref = linearToSrgb(lin.map((v) => Math.min(1, exposureChannel(v, c as ExposureOpts))) as [number, number, number]);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out.at(x, y)[k] - ref[k] * 255));
    }
    expect(worst, JSON.stringify(c)).toBeLessThanOrEqual(2);
  }
});

it('tone maps map the white point to white and keep alpha', async () => {
  const t = await harness();
  const bright = t.solid(4, 4, [255, 255, 255, 255]);
  for (const tonemap of ['reinhard', 'hable']) {
    const px = (await t.pixels((await t.run('exposure', { tonemap, whitePoint: 1, stops: 0 }, { image: bright })).image as never)).at(1, 1);
    expect(px[0]).toBe(255);
  }
  const half = (await t.pixels((await t.run('exposure', { stops: 1 }, { image: t.solid(4, 4, [100, 100, 100, 77]) })).image as never)).at(1, 1);
  expect(half[3]).toBe(77);
});
