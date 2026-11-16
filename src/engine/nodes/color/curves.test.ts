import { expect, it } from 'vitest';
import { chroma, lightness, makeChart, maxDiff, patchXY } from '../../lib/color-testutil';
import { harness } from '../../testing';
import type { CurveValue } from '../../types';

const pts = (...p: [number, number][]): CurveValue => ({ keys: p.map(([t, v]) => ({ t, v, interp: 'linear' as const })) });
const flat = (v: number): CurveValue => ({ keys: [{ t: 0, v, interp: 'linear' }, { t: 0.999, v, interp: 'linear' }] });
const hueBump = (centre: number, v: number): CurveValue => {
  // 0.5 everywhere except a smooth bump of height v at `centre`
  const k = (t: number, val: number) => ({ t: ((t % 1) + 1) % 1, v: val, interp: 'smooth' as const });
  return { keys: [k(centre - 0.12, 0.5), k(centre - 0.06, 0.5), k(centre, v), k(centre + 0.06, 0.5), k(centre + 0.12, 0.5)].sort((a, b) => a.t - b.t) };
};

it('default curves are the identity', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  const out = await t.pixels((await t.run('curves', {}, { image: src })).image as never);
  expect(maxDiff(a.data, out.data)).toBeLessThanOrEqual(1);
});

it('master curve reshapes all channels; channel curves only their own', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 2, (x) => [x, x, x, 255]);
  const dark = await t.pixels((await t.run('curves', { master: pts([0, 0], [0.5, 0.25], [1, 1]) }, { image: ramp })).image as never);
  expect(Math.abs(dark.at(128, 0)[0] - 64)).toBeLessThanOrEqual(2);
  expect(dark.at(128, 0)[1]).toBe(dark.at(128, 0)[0]);
  const red = await t.pixels((await t.run('curves', { red: pts([0, 1], [1, 0]) }, { image: ramp })).image as never);
  expect(red.at(0, 0)[0]).toBe(255);
  expect(red.at(255, 0)[0]).toBe(0);
  expect(red.at(100, 0)[1]).toBe(100);
  expect(red.at(100, 0)[2]).toBe(100);
  // master then channel: master halves, blue curve doubles back
  const both = await t.pixels((await t.run('curves', { master: pts([0, 0], [1, 0.5]), blue: pts([0, 0], [0.5, 1], [1, 1]) }, { image: ramp })).image as never);
  expect(Math.abs(both.at(100, 0)[2] - 100)).toBeLessThanOrEqual(2);
  expect(Math.abs(both.at(100, 0)[0] - 50)).toBeLessThanOrEqual(2);
});

it('Hue vs Sat removes only the chosen colour', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  // blue hues (the sea patch sits at about 0.59 of the wheel) go to zero saturation
  const out = await t.pixels((await t.run('curves', { hueVsSat: hueBump(0.59, 0) }, { image: src })).image as never);
  const sea = patchXY(0, 1);
  const red = patchXY(3, 1);
  expect(chroma(out.at(...sea))).toBeLessThan(chroma(input.at(...sea)) * 0.25);
  expect(Math.abs(chroma(out.at(...red)) - chroma(input.at(...red)))).toBeLessThan(0.01);
  // greys are not touched
  const grey = out.at(200, 140);
  expect(Math.abs(grey[0] - grey[2])).toBeLessThanOrEqual(1);
  // OKLab lightness stays (the colour only lost chroma)
  expect(Math.abs(lightness(out.at(...sea)) - lightness(input.at(...sea)))).toBeLessThan(0.02);
});

it('Hue vs Hue rotates a colour; Hue vs Lum lightens it', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  const sea = patchXY(0, 1);
  // push the blue range up: hue shifts by +(0.8-0.5)*360 degrees * ... the colour must change hue but keep chroma and lightness
  const shifted = await t.pixels((await t.run('curves', { hueVsHue: hueBump(0.59, 0.8) }, { image: src })).image as never);
  const before = input.at(...sea);
  const after = shifted.at(...sea);
  expect(Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]) + Math.abs(after[2] - before[2])).toBeGreaterThan(40);
  expect(Math.abs(lightness(after) - lightness(before))).toBeLessThan(0.03);
  const lighter = await t.pixels((await t.run('curves', { hueVsLum: hueBump(0.59, 0.8) }, { image: src })).image as never);
  expect(lightness(lighter.at(...sea))).toBeGreaterThan(lightness(before) + 0.08);
  const red = patchXY(3, 1);
  expect(Math.abs(lightness(lighter.at(...red)) - lightness(input.at(...red)))).toBeLessThan(0.01);
});

it('Lum vs Sat and Sat vs Sat act on lightness and saturation', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  // desaturate the shadows (L < 0.3) only
  const shadows = await t.pixels((await t.run('curves', { lumVsSat: pts([0, 0], [0.3, 0.5], [1, 0.5]) }, { image: src })).image as never);
  const darkP = patchXY(6, 1); // deep shadow colour
  const sea = patchXY(0, 1);
  expect(chroma(shadows.at(...darkP))).toBeLessThan(chroma(input.at(...darkP)) * 0.85);
  expect(Math.abs(chroma(shadows.at(...sea)) - chroma(input.at(...sea)))).toBeLessThan(0.01);
  // tame the most saturated colours
  const tamed = await t.pixels((await t.run('curves', { satVsSat: pts([0, 0.5], [0.6, 0.5], [1, 0.1]) }, { image: src })).image as never);
  const red = patchXY(3, 1);
  expect(chroma(tamed.at(...red))).toBeLessThan(chroma(input.at(...red)) * 0.8);
});

it('keeps alpha and honours the mask', async () => {
  const t = await harness();
  const half = (await t.pixels((await t.run('curves', { master: pts([0, 0], [0.5, 0.2], [1, 1]) }, { image: t.solid(4, 4, [200, 100, 50, 77]) })).image as never)).at(1, 1);
  expect(half[3]).toBe(77);
  const out = await t.pixels((await t.run('curves', { master: pts([0, 1], [1, 0]) }, { image: t.solid(8, 2, [200, 100, 50, 255]), mask: t.maskFn(8, 2, (x) => (x < 4 ? 0 : 1)) })).image as never);
  expect(out.at(1, 0).slice(0, 3)).toEqual([200, 100, 50]);
  expect(out.at(6, 0)[0]).toBe(55);
});

it('lookup textures are cached: the same curves upload nothing again, a flat curve does not need the colour branch', async () => {
  const t = await harness();
  const src = t.solid(16, 16, [120, 90, 60, 255]);
  const c = { master: pts([0, 0], [0.5, 0.4], [1, 1]), hueVsSat: hueBump(0.1, 0.9) };
  await t.run('curves', c, { image: src });
  const before = t.gpu.stats();
  for (let i = 0; i < 5; i++) await t.run('curves', { ...c, mix: 0.9 - i * 0.1 }, { image: src }); // re-renders each time, same tables
  const after = t.gpu.stats();
  expect(after.caches.dataTextureHits - before.caches.dataTextureHits).toBe(10);
  expect(after.objects.pipelinesCreated - before.objects.pipelinesCreated).toBeLessThanOrEqual(1);
  expect(flat(0.5).keys.length).toBe(2);
});
