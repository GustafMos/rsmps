import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

describe('inpaint', () => {
  it('reconstructs a smooth gradient behind a hole to within a small error', async () => {
    const t = await harness();
    const W = 64;
    const grad = (x: number, y: number): [number, number, number, number] => [20 + x * 2, 40 + y * 2, 100 + x + y, 255];
    // The hole content is garbage (bright magenta): it must not leak into the result.
    const img = t.fromFn(W, W, (x, y) => (inRect(x, y, 22, 20, 42, 44) ? [255, 0, 255, 255] : grad(x, y)));
    const mask = t.maskFn(W, W, (x, y) => (inRect(x, y, 22, 20, 42, 44) ? 1 : 0));
    const out = await t.run('inpaint', { grow: 0, feather: 0, texture: 0 }, { image: img, mask });
    const px = await t.pixels(out.image as never);
    let sum = 0;
    let max = 0;
    let n = 0;
    for (let y = 20; y < 44; y++)
      for (let x = 22; x < 42; x++) {
        const g = grad(x, y);
        for (let c = 0; c < 3; c++) {
          const e = Math.abs(px.at(x, y)[c] - g[c]);
          sum += e;
          max = Math.max(max, e);
          n++;
        }
        expect(px.at(x, y)[3]).toBe(255);
      }
    console.log(`inpaint gradient: mean abs error ${(sum / n).toFixed(2)} / 255, max ${max}`);
    expect(sum / n).toBeLessThan(2.5);
    expect(max).toBeLessThan(10);
    // Pixels outside the hole are untouched.
    expect(px.at(5, 5).slice(0, 3)).toEqual(grad(5, 5).slice(0, 3));
    expect(px.at(60, 60).slice(0, 3)).toEqual(grad(60, 60).slice(0, 3));
  });

  it('splits a two-tone image plausibly when the hole crosses the boundary', async () => {
    const t = await harness();
    const DARK: [number, number, number, number] = [30, 30, 30, 255];
    const LIGHT: [number, number, number, number] = [220, 220, 220, 255];
    const tone = (x: number) => (x < 32 ? DARK : LIGHT);
    const img = t.fromFn(64, 64, (x, y) => (inRect(x, y, 22, 22, 42, 42) ? [255, 0, 0, 255] : tone(x)));
    const mask = t.maskFn(64, 64, (x, y) => (inRect(x, y, 22, 22, 42, 42) ? 1 : 0));
    const px = await t.pixels((await t.run('inpaint', { grow: 0, feather: 0, texture: 0 }, { image: img, mask })).image as never);
    const row = Array.from({ length: 20 }, (_, i) => px.at(22 + i, 32)[0]);
    expect(row[0]).toBeLessThan(90); // next to the dark side
    expect(row[19]).toBeGreaterThan(160); // next to the light side
    for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThanOrEqual(row[i - 1] - 3); // monotonic transition
    expect(px.at(32, 22)[0]).toBeGreaterThan(70); // top edge of the hole is also a blend, not red garbage
    // no red leaks in
    for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) expect(Math.abs(px.at(x, y)[1] - px.at(x, y)[0])).toBeLessThan(6);
  });

  it('grow keeps the halo of the removed object out of the fill', async () => {
    const t = await harness();
    // Flat grey scene with a red subject plus a 2px darker-red halo around it that the mask does not cover.
    const img = t.fromFn(64, 64, (x, y) => (inRect(x, y, 26, 26, 38, 38) ? [255, 0, 0, 255] : inRect(x, y, 24, 24, 40, 40) ? [150, 60, 60, 255] : [120, 120, 120, 255]));
    const mask = t.maskFn(64, 64, (x, y) => (inRect(x, y, 26, 26, 38, 38) ? 1 : 0));
    const withGrow = await t.pixels((await t.run('inpaint', { grow: 4, feather: 0, texture: 0 }, { image: img, mask })).image as never);
    const without = await t.pixels((await t.run('inpaint', { grow: 0, feather: 0, texture: 0 }, { image: img, mask })).image as never);
    expect(Math.abs(withGrow.at(32, 32)[0] - 120)).toBeLessThan(4);
    expect(Math.abs(withGrow.at(32, 32)[1] - 120)).toBeLessThan(4);
    expect(without.at(32, 32)[0] - without.at(32, 32)[1]).toBeGreaterThan(20); // halo smeared in
    expect(Math.abs(withGrow.at(24, 32)[0] - 120)).toBeLessThan(6); // the halo itself is replaced too
  });

  it('texture re-adds grain only when asked', async () => {
    const t = await harness();
    const noise = (x: number, y: number) => ((Math.imul(x * 31 + 7, 374761393) ^ Math.imul(y * 17 + 3, 668265263)) >>> 7) % 25;
    const img = t.fromFn(96, 96, (x, y) => {
      const v = 110 + noise(x, y);
      return [v, v, v, 255];
    });
    const mask = t.maskFn(96, 96, (x, y) => (inRect(x, y, 30, 30, 66, 66) ? 1 : 0));
    const std = async (texture: number) => {
      const px = await t.pixels((await t.run('inpaint', { grow: 0, feather: 0, texture }, { image: img, mask })).image as never);
      const vals: number[] = [];
      for (let y = 36; y < 60; y++) for (let x = 36; x < 60; x++) vals.push(px.at(x, y)[0]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { mean, sd: Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) };
    };
    const flat = await std(0);
    const grainy = await std(1);
    console.log(`inpaint grain sd: ${flat.sd.toFixed(2)} -> ${grainy.sd.toFixed(2)}`);
    expect(flat.sd).toBeLessThan(2.5);
    expect(grainy.sd).toBeGreaterThan(3);
    expect(Math.abs(grainy.mean - flat.mean)).toBeLessThan(5);
  });

  it('fills holes in the alpha channel and works at 2x resolution (unit 2)', async () => {
    const t = await harness();
    const solid = (n: number, unit: number) => {
      const img = t.fromFn(n, n, (x, y) => (inRect(x, y, n * 0.4, n * 0.4, n * 0.6, n * 0.6) ? [0, 0, 0, 0] : [90, 140, 200, 255]), unit);
      const mask = t.maskFn(n, n, (x, y) => (inRect(x, y, n * 0.4, n * 0.4, n * 0.6, n * 0.6) ? 1 : 0), unit);
      return { img, mask };
    };
    for (const [n, unit] of [[64, 1], [128, 2]] as const) {
      const { img, mask } = solid(n, unit);
      const px = await t.pixels((await t.run('inpaint', { grow: 2, feather: 0, texture: 0 }, { image: img, mask })).image as never);
      const c = px.at(n / 2, n / 2);
      expect(c[3]).toBeGreaterThan(250);
      expect(Math.abs(c[0] - 90)).toBeLessThan(4);
      expect(Math.abs(c[2] - 200)).toBeLessThan(4);
    }
  });

  it('directional bias stretches the fill along the chosen axis', async () => {
    const t = await harness();
    // Stripes: left side red, right side blue, hole in the middle. Horizontal bias should keep the vertical structure of the hole's top/bottom...
    const img = t.fromFn(64, 64, (x, y) => (inRect(x, y, 20, 20, 44, 44) ? [0, 255, 0, 255] : y < 32 ? [200, 50, 50, 255] : [50, 50, 200, 255]));
    const mask = t.maskFn(64, 64, (x, y) => (inRect(x, y, 20, 20, 44, 44) ? 1 : 0));
    const horiz = await t.pixels((await t.run('inpaint', { grow: 0, feather: 0, texture: 0, bias: 1, direction: 0, smoothness: 1 }, { image: img, mask })).image as never);
    const vert = await t.pixels((await t.run('inpaint', { grow: 0, feather: 0, texture: 0, bias: 1, direction: 90, smoothness: 1 }, { image: img, mask })).image as never);
    // With horizontal propagation the top half stays red and the bottom stays blue; vertical propagation blends them more.
    const sepH = horiz.at(32, 24)[0] - horiz.at(32, 40)[0];
    const sepV = vert.at(32, 24)[0] - vert.at(32, 40)[0];
    expect(sepH).toBeGreaterThan(sepV);
  });
});
