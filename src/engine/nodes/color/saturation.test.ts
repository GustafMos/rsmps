import { expect, it } from 'vitest';
import { SCENE_PATCHES, SKIN_PATCHES, chroma, lightness, linY, makeChart, maxDiff, patchXY, to01 } from '../../lib/color-testutil';
import { saturateReference } from '../../lib/color-math';
import { harness } from '../../testing';

const MODES = ['oklab', 'linear', 'hsl'] as const;
const base = { vibrance: 0, protectSkin: 0.5, shadowRolloff: 0, highlightRolloff: 0 };

it('saturation 1 is the identity', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  for (const mode of MODES) {
    const out = await t.pixels((await t.run('saturation', { mode, saturation: 1 }, { image: src })).image as never);
    expect(maxDiff(a.data, out.data), mode).toBeLessThanOrEqual(1);
  }
});

it('neutral grey stays neutral at any amount, in every method', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 4, (x) => [x, x, x, 255]);
  for (const mode of MODES) for (const saturation of [0, 0.3, 2, 4]) for (const vibrance of [0, 1]) {
    const out = await t.pixels((await t.run('saturation', { mode, saturation, vibrance }, { image: ramp })).image as never);
    for (let x = 0; x < 256; x += 5) {
      const p = out.at(x, 1);
      expect(Math.abs(p[0] - p[1]) <= 1 && Math.abs(p[1] - p[2]) <= 1, `${mode} ${saturation} grey ${x}: ${p}`).toBe(true);
      expect(Math.abs(p[0] - x), `${mode} ${saturation} grey ${x}`).toBeLessThanOrEqual(1);
    }
  }
});

it('luminance is preserved: OKLab lightness in OKLab mode, linear Rec.709 Y in linear mode', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  for (const saturation of [0, 0.4, 1.6, 2.5]) {
    const oklab = await t.pixels((await t.run('saturation', { mode: 'oklab', saturation }, { image: src })).image as never);
    const lin = await t.pixels((await t.run('saturation', { mode: 'linear', saturation }, { image: src })).image as never);
    let worstL = 0;
    let worstY = 0;
    for (let y = 0; y < input.height; y += 3) for (let x = 0; x < input.width; x += 3) {
      const a = input.at(x, y);
      worstL = Math.max(worstL, Math.abs(lightness(oklab.at(x, y)) - lightness(a)));
      const dy = Math.abs(linY(lin.at(x, y)) - linY(a));
      worstY = Math.max(worstY, dy / (0.02 + linY(a)));
    }
    expect(worstL, `oklab x${saturation}`).toBeLessThan(0.012);
    expect(worstY, `linear x${saturation}`).toBeLessThan(0.05);
  }
});

it('HSL mode is the legacy one: it does change brightness (documented difference)', async () => {
  const t = await harness();
  const blue = t.solid(4, 4, [40, 80, 220, 255]);
  const hsl = (await t.pixels((await t.run('saturation', { mode: 'hsl', saturation: 0 }, { image: blue })).image as never)).at(1, 1);
  const ok = (await t.pixels((await t.run('saturation', { mode: 'oklab', saturation: 0 }, { image: blue })).image as never)).at(1, 1);
  // The OKLab grey has the same lightness as the blue; the HSL grey is the HSL mid value and is clearly different.
  expect(Math.abs(lightness(ok) - lightness([40, 80, 220]))).toBeLessThan(0.01);
  expect(Math.abs(lightness(hsl) - lightness([40, 80, 220]))).toBeGreaterThan(0.1);
});

it('gamut mapping: strong boosts reduce chroma instead of clipping', async () => {
  const t = await harness();
  const src = t.solid(4, 4, [220, 90, 60, 255]);
  const out = (await t.pixels((await t.run('saturation', { mode: 'oklab', saturation: 4 }, { image: src })).image as never)).at(1, 1);
  const before = [220, 90, 60];
  expect(chroma(out)).toBeGreaterThan(chroma(before));
  // hue is kept (a clipping implementation moves it toward orange / yellow)
  const hue = (c: ArrayLike<number>) => Math.atan2(to01(c)[1] - to01(c)[2], to01(c)[0] - 0.5 * (to01(c)[1] + to01(c)[2]));
  expect(Math.abs(hue(out) - hue(before))).toBeLessThan(0.2);
  expect(out[0] === 255 && out[1] === 0).toBe(false);
});

it('matches the CPU reference (vibrance, skin protection, roll-off included)', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  const cases = [
    { mode: 'oklab', saturation: 1.7, vibrance: 0, protectSkin: 0.5, shadowRolloff: 0, highlightRolloff: 0 },
    { mode: 'oklab', saturation: 1, vibrance: 0.8, protectSkin: 1, shadowRolloff: 0, highlightRolloff: 0 },
    { mode: 'oklab', saturation: 0.6, vibrance: -0.7, protectSkin: 0, shadowRolloff: 0.8, highlightRolloff: 0.8 },
    { mode: 'linear', saturation: 1.5, vibrance: 0.5, protectSkin: 0.3, shadowRolloff: 0.5, highlightRolloff: 0.5 },
    { mode: 'hsl', saturation: 1.5, vibrance: 0.3, protectSkin: 0.3, shadowRolloff: 0, highlightRolloff: 0.4 },
  ] as const;
  for (const c of cases) {
    const out = await t.pixels((await t.run('saturation', c, { image: src })).image as never);
    let worst = 0;
    for (let y = 0; y < input.height; y += 7) for (let x = 0; x < input.width; x += 5) {
      const ref = saturateReference(to01(input.at(x, y)), c);
      const got = out.at(x, y);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k] - ref[k] * 255));
    }
    expect(worst, JSON.stringify(c)).toBeLessThanOrEqual(3);
  }
});

it('vibrance boosts muted colours more than vivid ones, and protects skin', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  const out = await t.pixels((await t.run('saturation', { vibrance: 1, protectSkin: 1 }, { image: src })).image as never);
  const outNoProtect = await t.pixels((await t.run('saturation', { vibrance: 1, protectSkin: 0 }, { image: src })).image as never);
  const gain = (px: ReturnType<typeof input.at>, o: ReturnType<typeof input.at>) => chroma(o) / chroma(px);
  const muted = patchXY(1, 1); // sky: moderate chroma
  const vivid = patchXY(3, 1); // red
  expect(gain(input.at(...muted), out.at(...muted))).toBeGreaterThan(gain(input.at(...vivid), out.at(...vivid)));
  const skin = patchXY(2, 0);
  expect(gain(input.at(...skin), out.at(...skin))).toBeLessThan(gain(input.at(...skin), outNoProtect.at(...skin)) - 0.1);
  expect(SKIN_PATCHES.length + SCENE_PATCHES.length).toBe(16);
});

it('roll-off leaves shadows and highlights alone', async () => {
  const t = await harness();
  const dark = t.solid(4, 4, [14, 9, 7, 255]);
  const a = (await t.pixels((await t.run('saturation', { saturation: 3 }, { image: dark })).image as never)).at(1, 1);
  const b = (await t.pixels((await t.run('saturation', { saturation: 3, shadowRolloff: 1 }, { image: dark })).image as never)).at(1, 1);
  expect(chroma(a)).toBeGreaterThan(chroma(b) * 1.5);
  expect(Math.abs(b[0] - 14) + Math.abs(b[1] - 9) + Math.abs(b[2] - 7)).toBeLessThan(8);
});

it('keeps alpha and honours the mask', async () => {
  const t = await harness();
  const half = (await t.pixels((await t.run('saturation', { saturation: 2 }, { image: t.solid(4, 4, [200, 100, 50, 100] as never) })).image as never)).at(1, 1);
  expect(half[3]).toBe(100);
  const src = t.solid(8, 2, [200, 100, 50, 255]);
  const out = await t.pixels((await t.run('saturation', { saturation: 0 }, { image: src, mask: t.maskFn(8, 2, (x) => (x < 4 ? 0 : 1)) })).image as never);
  expect(out.at(1, 0).slice(0, 3)).toEqual([200, 100, 50]);
  expect(Math.abs(out.at(6, 0)[0] - out.at(6, 0)[2])).toBeLessThanOrEqual(1);
});
