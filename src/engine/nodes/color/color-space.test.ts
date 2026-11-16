import { expect, it } from 'vitest';
import { SPACES, convertSpace } from '../../lib/color-math';
import { makeChart, to01 } from '../../lib/color-testutil';
import { harness } from '../../testing';

it('same space to same space is the identity', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  for (const id of ['srgb', 'linear', 'p3', 'slog3', 'cineon', 'rec2020-g24']) {
    const out = await t.pixels((await t.run('color-space', { from: id, to: id }, { image: src })).image as never);
    let worst = 0;
    for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[i + c] - out.data[i + c]));
    expect(worst, id).toBeLessThanOrEqual(1);
  }
});

it('sRGB to linear: mid grey 188 becomes about 0.5', async () => {
  const t = await harness();
  const px = (await t.pixels((await t.run('color-space', { from: 'srgb', to: 'linear' }, { image: t.solid(4, 4, [188, 188, 188, 255]) })).image as never)).at(1, 1);
  expect(Math.abs(px[0] - 127.5)).toBeLessThanOrEqual(1.5);
  const g24 = (await t.pixels((await t.run('color-space', { from: 'srgb', to: 'rec709-g24' }, { image: t.solid(4, 4, [128, 128, 128, 255]) })).image as never)).at(1, 1);
  // sRGB 128 -> linear 0.2159 -> gamma 2.4 encode 0.5311 -> 135
  expect(Math.abs(g24[0] - 135)).toBeLessThanOrEqual(1);
});

it('every pair of spaces matches the CPU reference', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  const pairs: [string, string][] = [];
  for (const a of SPACES) pairs.push(['srgb', a.id], [a.id, 'srgb']);
  pairs.push(['p3', 'rec2020-linear'], ['rec2020-g24', 'p3-linear'], ['logc3', 'vlog'], ['davinci', 'acescct']);
  for (const [from, to] of pairs) {
    const out = await t.pixels((await t.run('color-space', { from, to }, { image: src })).image as never);
    let worst = 0;
    for (let y = 0; y < input.height; y += 11) for (let x = 0; x < input.width; x += 9) {
      const ref = convertSpace(to01(input.at(x, y)), from, to);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out.at(x, y)[k] - Math.min(1, Math.max(0, ref[k])) * 255));
    }
    expect(worst, `${from} -> ${to}`).toBeLessThanOrEqual(2.5);
  }
});

it('sRGB -> Display P3 -> sRGB keeps in-gamut colours (two 8-bit steps: saturated greens lose a few codes to the intermediate quantisation)', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  const p3 = (await t.run('color-space', { from: 'srgb', to: 'p3' }, { image: src })).image as never;
  const back = await t.pixels((await t.run('color-space', { from: 'p3', to: 'srgb' }, { image: p3 })).image as never);
  let worst = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[i + c] - back.data[i + c]));
  expect(worst).toBeLessThanOrEqual(7);
});

it('keeps alpha', async () => {
  const t = await harness();
  const px = (await t.pixels((await t.run('color-space', { from: 'srgb', to: 'linear' }, { image: t.solid(4, 4, [200, 120, 60, 130]) })).image as never)).at(1, 1);
  expect(px[3]).toBe(130);
});
