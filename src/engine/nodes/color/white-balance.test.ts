import { expect, it } from 'vitest';
import { chartPixel, makeChart, maxDiff } from '../../lib/color-testutil';
import { harness } from '../../testing';

it('6500 K with tint 0 is the identity (within one code value)', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  for (const method of ['bradford', 'cat16']) for (const preserveLuminance of [true, false]) {
    const out = await t.pixels((await t.run('white-balance', { temperature: 6500, tint: 0, method, preserveLuminance }, { image: src })).image as never);
    expect(maxDiff(a.data, out.data)).toBeLessThanOrEqual(1);
  }
});

it('warm-light temperature cools the picture, cool-light warms it; tint + is magenta', async () => {
  const t = await harness();
  const grey = t.solid(8, 8, [128, 128, 128, 255]);
  const cool = (await t.pixels((await t.run('white-balance', { temperature: 3200 }, { image: grey })).image as never)).at(3, 3);
  expect(cool[2]).toBeGreaterThan(cool[0] + 15);
  const warm = (await t.pixels((await t.run('white-balance', { temperature: 9500 }, { image: grey })).image as never)).at(3, 3);
  expect(warm[0]).toBeGreaterThan(warm[2] + 8);
  const mag = (await t.pixels((await t.run('white-balance', { tint: 1 }, { image: grey })).image as never)).at(3, 3);
  expect(mag[1]).toBeLessThan((mag[0] + mag[2]) / 2 - 8);
  const grn = (await t.pixels((await t.run('white-balance', { tint: -1 }, { image: grey })).image as never)).at(3, 3);
  expect(grn[1]).toBeGreaterThan((grn[0] + grn[2]) / 2 + 8);
});

it('neutral mode maps the picked colour to equal RGB (and keeps its luminance)', async () => {
  const t = await harness();
  for (const rgb of [[200, 150, 100], [90, 110, 160], [230, 225, 180]]) {
    const src = t.solid(8, 8, [rgb[0], rgb[1], rgb[2], 255]);
    for (const method of ['bradford', 'cat16']) {
      const px = (await t.pixels((await t.run('white-balance', { mode: 'neutral', neutral: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1], method }, { image: src })).image as never)).at(4, 4);
      expect(Math.abs(px[0] - px[1])).toBeLessThanOrEqual(1);
      expect(Math.abs(px[1] - px[2])).toBeLessThanOrEqual(1);
      const yIn = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      expect(Math.abs(px[1] - yIn)).toBeLessThan(14); // luminance kept (compared in encoded terms, roughly)
    }
  }
});

it('automatic mode neutralises a colour cast (grey world and white patch)', async () => {
  const t = await harness();
  // a scene lit by an orange light: a grey ramp whose LINEAR channels are multiplied by (1.25, 1, 0.7)
  const enc = (l: number) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055));
  const cast = t.fromFn(32, 32, (x) => {
    const l = 0.03 + (x / 31) * 0.75;
    return [enc(Math.min(1, l * 1.25)), enc(l), enc(l * 0.7), 255];
  });
  for (const estimate of ['grey-world', 'white-patch']) {
    const out = await t.pixels((await t.run('white-balance', { mode: 'auto', estimate }, { image: cast })).image as never);
    for (const x of [8, 16, 24]) {
      const mid = out.at(x, 16);
      const spread = Math.max(mid[0], mid[1], mid[2]) - Math.min(mid[0], mid[1], mid[2]);
      expect(spread, `${estimate} at x=${x}`).toBeLessThanOrEqual(5);
    }
  }
});

it('automatic mode is stable across frames and strength 0 is a no-op', async () => {
  const t = await harness();
  const cast = t.solid(16, 16, [200, 140, 90, 255]);
  const a = await t.pixels((await t.run('white-balance', { mode: 'auto' }, { image: cast }, { seconds: 0 })).image as never);
  const b = await t.pixels((await t.run('white-balance', { mode: 'auto' }, { image: cast }, { seconds: 1.5 })).image as never);
  expect(maxDiff(a.data, b.data)).toBe(0);
  const none = await t.pixels((await t.run('white-balance', { mode: 'auto', amount: 0 }, { image: cast })).image as never);
  expect(none.at(3, 3).slice(0, 3)).toEqual([200, 140, 90]);
});

it('preserve luminance keeps Rec.709 luma of unclipped colours', async () => {
  const t = await harness();
  const src = t.solid(8, 8, [120, 110, 100, 255]);
  const y = (p: ArrayLike<number>) => {
    const l = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
    return 0.2126 * l(p[0]) + 0.7152 * l(p[1]) + 0.0722 * l(p[2]);
  };
  const on = (await t.pixels((await t.run('white-balance', { temperature: 3800, preserveLuminance: true }, { image: src })).image as never)).at(2, 2);
  const off = (await t.pixels((await t.run('white-balance', { temperature: 3800, preserveLuminance: false }, { image: src })).image as never)).at(2, 2);
  expect(Math.abs(y(on) - y([120, 110, 100]))).toBeLessThan(0.004);
  expect(Math.abs(y(off) - y([120, 110, 100]))).toBeGreaterThan(Math.abs(y(on) - y([120, 110, 100])));
});

it('keeps alpha, honours the mask', async () => {
  const t = await harness();
  const half = t.solid(8, 8, [128, 128, 128, 128]);
  const px = await t.pixels((await t.run('white-balance', { temperature: 3200 }, { image: half })).image as never);
  expect(px.at(2, 2)[3]).toBe(128);
  const clear = await t.pixels((await t.run('white-balance', { temperature: 3200 }, { image: t.solid(4, 4, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(1, 1)[3]).toBe(0);
  const src = t.fromFn(16, 4, (x, y) => chartPixel(x * 8, 130 + y));
  const masked = await t.pixels((await t.run('white-balance', { temperature: 3200 }, { image: src, mask: t.maskFn(16, 4, (x) => (x < 8 ? 0 : 1)) })).image as never);
  const orig = await t.pixels(src);
  expect(masked.at(2, 1).slice(0, 3)).toEqual(orig.at(2, 1).slice(0, 3));
  expect(masked.at(12, 1)[2]).toBeGreaterThan(orig.at(12, 1)[2]);
});
