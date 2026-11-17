import { describe, expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

const white = (x0: number) => (x: number): [number, number, number, number] => (Math.abs(x - x0) < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
const still = { saturation: 1, paletteMix: 0, ripple: 0, interference: 0 };

describe('chroma-smear', () => {
  it('each channel smears its own length and direction', async () => {
    const t = await harness();
    const src = t.fromFn(160, 8, white(80));
    const px = await t.pixels((await t.run('chroma-smear', { ...still, lengthR: 30, lengthG: 0, lengthB: 30, angleR: 0, angleB: 180 }, { image: src })).image as never);
    // red trails to the right of the bar, blue to the left, green not at all
    expect(px.at(100, 4)[0]).toBeGreaterThan(8);
    expect(px.at(100, 4)[2]).toBeLessThan(px.at(100, 4)[0] / 3);
    expect(px.at(60, 4)[2]).toBeGreaterThan(8);
    expect(px.at(60, 4)[0]).toBeLessThan(px.at(60, 4)[2] / 3);
    expect(px.at(100, 4)[1]).toBe(0);
    expect(px.at(60, 4)[1]).toBe(0);
  });

  it('falls off exponentially with distance', async () => {
    const t = await harness();
    const src = t.fromFn(200, 8, white(40));
    const px = await t.pixels((await t.run('chroma-smear', { ...still, lengthR: 30, lengthG: 30, lengthB: 30, angleR: 0, angleG: 0, angleB: 0 }, { image: src })).image as never);
    const a = px.at(50, 4)[0];
    const b = px.at(80, 4)[0];
    const c = px.at(140, 4)[0];
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('saturation boost and alpha', async () => {
    const t = await harness();
    const src = t.solid(8, 8, [180, 120, 120, 255]);
    const flat = { ...still, smear: 0, saturation: 1 };
    const a = await t.pixels((await t.run('chroma-smear', flat, { image: src })).image as never);
    const b = await t.pixels((await t.run('chroma-smear', { ...flat, saturation: 2.5 }, { image: src })).image as never);
    expect(b.at(2, 2)[0] - b.at(2, 2)[1]).toBeGreaterThan(a.at(2, 2)[0] - a.at(2, 2)[1] + 30);
    const clear = await t.pixels((await t.run('chroma-smear', {}, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
    expect(clear.at(3, 3)[3]).toBe(0);
    const sprite = t.fromFn(64, 8, (x) => (x > 28 && x < 36 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const sp = await t.pixels((await t.run('chroma-smear', { ...still, lengthR: 20, lengthG: 20, lengthB: 20, angleB: 0 }, { image: sprite })).image as never);
    expect(sp.at(44, 4)[3]).toBeGreaterThan(20); // alpha trails with the colour
  });

  it('palette bands recolour brightness through the palette', async () => {
    const t = await harness();
    const src = t.fromFn(32, 4, (x) => {
      const v = Math.round((x / 31) * 255);
      return [v, v, v, 255];
    });
    const palette = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const px = await t.pixels((await t.run('chroma-smear', { ...still, smear: 0, paletteMix: 1, bands: 3, palette }, { image: src })).image as never);
    const first = px.at(1, 2);
    const last = px.at(30, 2);
    expect(first[0]).toBeGreaterThan(first[1]);
    expect(last[2]).toBeGreaterThan(last[0]);
    const distinct = new Set<string>();
    for (let x = 0; x < 32; x++) distinct.add(px.at(x, 2).slice(0, 3).map((v) => Math.round(v / 40)).join());
    expect(distinct.size).toBeLessThan(14);
  });

  it('colour cycling loops with whole cycles; still without them', async () => {
    const t = await harness();
    const src = t.fromFn(32, 8, (x) => [x * 8, x * 8, x * 8, 255]);
    const base = { ...still, smear: 0, paletteMix: 1, bands: 4 };
    const anim = await t.loopCheck('chroma-smear', { ...base, hueCycles: 1 }, { image: src });
    expect(anim.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(anim.motion).toBeGreaterThan(1);
    const off = await t.loopCheck('chroma-smear', base, { image: src });
    expect(off.motion).toBe(0);
  });

  it('contour ripple pushes edges along the gradient', async () => {
    const t = await harness();
    const src = t.fromFn(64, 16, (x) => (x < 32 ? [20, 20, 20, 255] : [240, 240, 240, 255]));
    const px = await t.pixels((await t.run('chroma-smear', { ...still, smear: 0, ripple: 10, ripplePasses: 3 }, { image: src })).image as never);
    const before = await t.pixels(src);
    let diff = 0;
    for (let x = 20; x < 44; x++) diff += Math.abs(px.at(x, 8)[0] - before.at(x, 8)[0]);
    expect(diff).toBeGreaterThan(100);
    expect(px.at(4, 8)[0]).toBe(20); // flat areas do not move
  });

  it('interference lines add streaks', async () => {
    const t = await harness();
    const src = t.solid(128, 128, [60, 60, 60, 255]);
    const a = await t.pixels((await t.run('chroma-smear', { ...still, smear: 0, interference: 1 }, { image: src })).image as never);
    let bright = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) if (a.at(x, y)[0] > 150) bright++;
    expect(bright).toBeGreaterThan(50);
  });

  it('lengths follow resolution', async () => {
    const t = await harness();
    const d = await resolutionDiff(t, 'chroma-smear', { ...still, lengthR: 8, lengthG: 4, lengthB: 10 }, (w, h) => (x, y) => (Math.hypot(x / w - 0.5, y / h - 0.5) < 0.2 ? [255, 120, 40, 255] : [10, 20, 60, 255]));
    expect(d).toBeLessThan(10);
  });
});
