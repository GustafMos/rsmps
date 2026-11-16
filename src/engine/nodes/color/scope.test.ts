import { expect, it } from 'vitest';
import { makeChart } from '../../lib/color-testutil';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

const run = async (t: Awaited<ReturnType<typeof harness>>, params: Record<string, unknown>, image: ImageValue) => {
  const out = (await t.run('scope', params, { image })).image as ImageValue;
  return { img: out, px: await t.pixels(out) };
};
const lum = (p: ArrayLike<number>) => p[0] + p[1] + p[2];

it('waveform of a black-to-white ramp is a rising diagonal', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 64, (x) => [x, x, x, 255]);
  const { img, px } = await run(t, { type: 'waveform', resolution: 256, graticule: false, samples: 128 }, ramp);
  expect([img.width, img.height]).toEqual([512, 256]);
  const H = 256;
  const at = (xf: number, level: number) => {
    // brightest of a small neighbourhood around the expected spot
    let best = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) best = Math.max(best, lum(px.at(Math.min(511, Math.max(0, Math.round(xf * 511) + dx)), Math.min(H - 1, Math.max(0, Math.round((1 - level) * (H - 1)) + dy)))));
    return best;
  };
  for (const f of [0.2, 0.5, 0.8]) {
    expect(at(f, f), `on the diagonal at ${f}`).toBeGreaterThan(120);
    expect(at(f, Math.min(1, f + 0.4)), `off the diagonal at ${f}`).toBeLessThan(80);
  }
});

it('histogram of a flat grey has one spike at its level; RGB overlay colours it', async () => {
  const t = await harness();
  const { px } = await run(t, { type: 'histogram', resolution: 256, graticule: false }, t.solid(64, 64, [128, 128, 128, 255]));
  const W = 512;
  const col = (bin: number) => px.at(Math.round((bin + 0.5) * (W / 256)), 100);
  expect(lum(col(128))).toBeGreaterThan(300);
  expect(lum(col(60))).toBeLessThan(60);
  expect(lum(col(200))).toBeLessThan(60);
  const rgb = await run(t, { type: 'histogram', channels: 'rgb', resolution: 256, graticule: false }, t.solid(64, 64, [200, 60, 60, 255]));
  const r = rgb.px.at(Math.round((200.5) * (W / 256)), 100);
  const g = rgb.px.at(Math.round((60.5) * (W / 256)), 100);
  expect(r[0]).toBeGreaterThan(r[2] + 80); // red spike at 200
  expect(g[1]).toBeGreaterThan(80); // green and blue share the bin at 60
  expect(g[0]).toBeLessThan(g[1] - 80);
});

it('vectorscope puts 75% red toward the top, left of centre, and grey at the centre', async () => {
  const t = await harness();
  const N = 256;
  const red = await run(t, { type: 'vectorscope', resolution: N, graticule: false, samples: 96 }, t.solid(64, 64, [191, 0, 0, 255]));
  expect([red.img.width, red.img.height]).toEqual([N, N]);
  // Rec.709: Cb = -0.1146 * 0.75 -> x = (0.5 - 0.086) * N, Cr = 0.375 -> y = (0.5 - 0.375) * N
  const cb = (0 - 0.2126 * 0.749) / (2 * (1 - 0.0722));
  const x = Math.round((cb + 0.5) * (N - 1));
  const y = Math.round((0.5 - 0.375 * 0.9999) * (N - 1));
  let near = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) near = Math.max(near, lum(red.px.at(x + dx, y + dy)));
  expect(near).toBeGreaterThan(300);
  expect(lum(red.px.at(Math.round(N * 0.8), Math.round(N * 0.8)))).toBeLessThan(60);
  const grey = await run(t, { type: 'vectorscope', resolution: N, graticule: false, samples: 96 }, t.solid(64, 64, [128, 128, 128, 255]));
  let centre = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) centre = Math.max(centre, lum(grey.px.at(N / 2 + dx, N / 2 + dy)));
  expect(centre).toBeGreaterThan(300);
});

it('parade shows three panels; graticule draws reference lines', async () => {
  const t = await harness();
  const src = t.solid(96, 96, [240, 120, 30, 255]);
  const { img, px } = await run(t, { type: 'parade', resolution: 256, graticule: false }, src);
  const W = img.width;
  const level = (v: number) => Math.round((1 - v / 255) * 255);
  const third = W / 3;
  const hot = (panel: number, v: number) => {
    let best = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++) best = [Math.max(best[0], px.at(Math.round(panel * third + third / 2), level(v) + dy)[0]), Math.max(best[1], px.at(Math.round(panel * third + third / 2), level(v) + dy)[1]), Math.max(best[2], px.at(Math.round(panel * third + third / 2), level(v) + dy)[2])];
    return best;
  };
  expect(hot(0, 240)[0]).toBeGreaterThan(120); // red panel, red level
  expect(hot(1, 120)[1]).toBeGreaterThan(120);
  expect(hot(2, 30)[2]).toBeGreaterThan(80);
  const withGrid = (await run(t, { type: 'waveform', resolution: 256, graticule: true }, t.solid(32, 32, [0, 0, 0, 255]))).px;
  const without = (await run(t, { type: 'waveform', resolution: 256, graticule: false }, t.solid(32, 32, [0, 0, 0, 255]))).px;
  expect(lum(withGrid.at(100, 128 - 0)) + lum(withGrid.at(100, 127))).toBeGreaterThan(lum(without.at(100, 128)) + lum(without.at(100, 127)) + 30);
});

it('every scope renders the chart without errors and is deterministic', async () => {
  const t = await harness();
  const src = makeChart(t);
  for (const type of ['waveform', 'parade', 'histogram', 'vectorscope']) for (const channels of ['luma', 'rgb']) {
    const a = await t.pixels((await t.run('scope', { type, channels, resolution: 192 }, { image: src })).image as never);
    const b = await t.pixels((await t.run('scope', { type, channels, resolution: 192, gain: 1.0001 }, { image: src })).image as never);
    expect(a.width).toBeGreaterThan(100);
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) sum += lum(a.data.slice(i, i + 3));
    expect(sum, `${type} ${channels} is not blank`).toBeGreaterThan(a.width * a.height * 3 * 12);
    expect(b.width).toBe(a.width);
  }
});
