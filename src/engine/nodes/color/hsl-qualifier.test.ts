import { expect, it } from 'vitest';
import { type QualifierOpts, qualify } from '../../lib/color-math';
import { makeChart, patchXY, to01 } from '../../lib/color-testutil';
import { harness } from '../../testing';
import type { MaskValue } from '../../types';

const px = async (t: Awaited<ReturnType<typeof harness>>, m: unknown) => t.pixels(m as MaskValue);

it('selects the blue of the sea and nothing else', async () => {
  const t = await harness();
  const src = makeChart(t);
  const out = await t.run('hsl-qualifier', { hueCenter: 213, hueWidth: 25, hueSoft: 10 }, { image: src });
  const m = await px(t, out.mask);
  const sea = patchXY(0, 1);
  expect(m.at(...sea)[0]).toBeGreaterThan(240);
  expect(m.at(...patchXY(2, 1))[0]).toBeLessThan(5); // foliage
  expect(m.at(...patchXY(3, 1))[0]).toBeLessThan(5); // red
  expect(m.at(...patchXY(2, 0))[0]).toBeLessThan(5); // skin
  expect(m.at(200, 140)[0]).toBeLessThan(5); // grey ramp (no hue, never selected)
  expect(out.preview).toBeNull();
});

it('softness gives a gradual edge, saturation and lightness ranges limit the selection, invert flips it', async () => {
  const t = await harness();
  const sweep = t.fromFn(360, 4, (x) => {
    const c = hsv(x / 360, 1, 1);
    return [c[0], c[1], c[2], 255];
  });
  const m = await px(t, (await t.run('hsl-qualifier', { hueCenter: 120, hueWidth: 20, hueSoft: 30 }, { image: sweep })).mask);
  expect(m.at(120, 1)[0]).toBe(255);
  expect(m.at(135, 1)[0]).toBe(255);
  const edge = m.at(160, 1)[0];
  expect(edge).toBeGreaterThan(10);
  expect(edge).toBeLessThan(245);
  expect(m.at(180, 1)[0]).toBeLessThan(3);
  expect(m.at(0, 1)[0]).toBe(0);
  const inv = await px(t, (await t.run('hsl-qualifier', { hueCenter: 120, hueWidth: 20, hueSoft: 30, invert: true }, { image: sweep })).mask);
  expect(inv.at(120, 1)[0]).toBe(0);
  expect(inv.at(0, 1)[0]).toBe(255);
  // a light pastel is excluded by a high saturation floor / a low lightness ceiling
  const pastel = t.solid(4, 4, [190, 240, 190, 255]);
  expect((await px(t, (await t.run('hsl-qualifier', { hueCenter: 120, hueWidth: 30, satLow: 0, satHigh: 1 }, { image: pastel })).mask)).at(1, 1)[0]).toBeGreaterThan(240);
  expect((await px(t, (await t.run('hsl-qualifier', { hueCenter: 120, hueWidth: 30, satLow: 0.9, satHigh: 1, satSoft: 0.02 }, { image: pastel })).mask)).at(1, 1)[0]).toBeLessThan(10);
  expect((await px(t, (await t.run('hsl-qualifier', { hueCenter: 120, hueWidth: 30, lumHigh: 0.6, lumSoft: 0.02 }, { image: pastel })).mask)).at(1, 1)[0]).toBeLessThan(10);
});

it('hue width 180 turns the hue test off (greys are then selected)', async () => {
  const t = await harness();
  const grey = t.solid(4, 4, [128, 128, 128, 255]);
  expect((await px(t, (await t.run('hsl-qualifier', { hueWidth: 180 }, { image: grey })).mask)).at(1, 1)[0]).toBe(255);
});

it('matches the CPU reference', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  const o: QualifierOpts = { hueCenter: 30 / 360, hueWidth: 25 / 360, hueSoft: 20 / 360, satLow: 0.3, satHigh: 0.95, satSoft: 0.1, lumLow: 0.15, lumHigh: 0.8, lumSoft: 0.1, invert: false };
  const m = await px(t, (await t.run('hsl-qualifier', { hueCenter: 30, hueWidth: 25, hueSoft: 20, satLow: 0.3, satHigh: 0.95, satSoft: 0.1, lumLow: 0.15, lumHigh: 0.8, lumSoft: 0.1 }, { image: src })).mask);
  let worst = 0;
  for (let y = 0; y < input.height; y += 4) for (let x = 0; x < input.width; x += 3) worst = Math.max(worst, Math.abs(m.at(x, y)[0] - qualify(to01(input.at(x, y)), o) * 255));
  expect(worst).toBeLessThanOrEqual(2);
});

it('the matte limits another node: only the sea is desaturated', async () => {
  const t = await harness();
  const src = makeChart(t);
  const q = await t.run('hsl-qualifier', { hueCenter: 213, hueWidth: 25, hueSoft: 10 }, { image: src });
  const out = await t.pixels((await t.run('saturation', { saturation: 0 }, { image: src, mask: q.mask as MaskValue })).image as never);
  const sea = out.at(...patchXY(0, 1));
  const red = out.at(...patchXY(3, 1));
  expect(Math.abs(sea[0] - sea[2])).toBeLessThanOrEqual(2);
  expect(red[0] - red[2]).toBeGreaterThan(100);
});

it('preview shows the selection in colour and dims the rest', async () => {
  const t = await harness();
  const src = makeChart(t);
  const out = await t.run('hsl-qualifier', { hueCenter: 213, hueWidth: 25, hueSoft: 10, preview: 'highlight' }, { image: src });
  const p = await px(t, out.preview);
  const orig = await t.pixels(src);
  expect(p.at(...patchXY(0, 1)).slice(0, 3)).toEqual(orig.at(...patchXY(0, 1)).slice(0, 3));
  const red = p.at(...patchXY(3, 1));
  expect(Math.abs(red[0] - red[2])).toBeLessThanOrEqual(1);
  expect(red[0]).toBeLessThan(orig.at(...patchXY(3, 1))[0]);
});

function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1)];
}
