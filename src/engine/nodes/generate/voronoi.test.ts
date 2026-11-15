import { expect, it } from 'vitest';
import { harness } from '../../testing';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 128, height: 128, lengthMode: 'absolute' as const };

it('cells mode: flat-coloured cells with several distinct colours', async () => {
  const t = await H();
  const px = await t.pixels((await t.run('voronoi', { mode: 'cells', scale: 32, lineWidth: 0 }, {}, { project: proj })).image as never);
  const colours = new Set<number>();
  let flat = 0;
  let total = 0;
  for (let y = 1; y < 127; y += 2) {
    for (let x = 1; x < 127; x += 2) {
      const i = (y * 128 + x) * 4;
      colours.add(px.data[i] * 65536 + px.data[i + 1] * 256 + px.data[i + 2]);
      total++;
      if (px.data[i] === px.data[i + 4] && px.data[i + 1] === px.data[i + 5]) flat++;
    }
  }
  expect(colours.size).toBeGreaterThan(6);
  expect(flat / total).toBeGreaterThan(0.85); // mostly flat regions, borders are a few pixels
});

it('crackle draws thin lines of the line colour over the cell colour', async () => {
  const t = await H();
  const px = await t.pixels(
    (await t.run('voronoi', { mode: 'crackle', scale: 32, lineWidth: 3, colorA: [1, 1, 1, 1], colorB: [0, 0, 0, 1] }, {}, { project: proj })).image as never,
  );
  let dark = 0;
  let light = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const v = px.data[(y * 128 + x) * 4]; if (v < 40) dark++; else if (v > 215) light++; }
  const frac = dark / (128 * 128);
  expect(frac).toBeGreaterThan(0.04);
  expect(frac).toBeLessThan(0.3);
  expect(light / (128 * 128)).toBeGreaterThan(0.6);
});

it('distance mode: dark at cell centres, bright toward the borders', async () => {
  const t = await H();
  const px = await t.pixels(
    (await t.run('voronoi', { mode: 'distance', scale: 40, colorA: [1, 1, 1, 1], colorB: [0, 0, 0, 1], motion: 0 }, {}, { project: proj })).image as never,
  );
  let min = 255;
  let max = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    min = Math.min(min, px.data[i]);
    max = Math.max(max, px.data[i]);
  }
  expect(min).toBeLessThan(40);
  expect(max).toBeGreaterThan(200);
});

it('same seed gives the same image, another seed another one; size scales with unit', async () => {
  const t = await H();
  const grab = async (seed: number) => (await t.pixels((await t.run('voronoi', { seed, motion: 0 }, {}, { project: proj })).image as never)).data;
  const [a, b, c] = [await grab(3), await grab(3), await grab(4)];
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  const small = await t.run('voronoi', { scale: 30, mode: 'crackle', motion: 0 }, { size: t.solid(64, 64, [0, 0, 0, 255], 1) });
  const big = await t.run('voronoi', { scale: 30, mode: 'crackle', motion: 0 }, { size: t.solid(128, 128, [0, 0, 0, 255], 2) });
  const ps = await t.pixels(small.image as never);
  const pb = await t.pixels(big.image as never);
  let err = 0;
  for (let y = 4; y < 60; y += 4) for (let x = 4; x < 60; x += 4) err += Math.abs(ps.at(x, y)[0] - pb.at(x * 2 + 1, y * 2 + 1)[0]);
  expect(err / (14 * 14)).toBeLessThan(25);
});

it('animated cells loop exactly and move; motion 0 stays still', async () => {
  const t = await H();
  const r = await t.loopCheck('voronoi', { mode: 'cells', scale: 20, motion: 0.8, cycles: 3 }, { size: t.solid(64, 64, [0, 0, 0, 255], 1) });
  expect(r.seam).toBeLessThan(0.01);
  expect(r.motion).toBeGreaterThan(1);
  for (const mode of ['crackle', 'distance']) {
    const m = await t.loopCheck('voronoi', { mode, scale: 20, motion: 0.8, cycles: 1 }, { size: t.solid(64, 64, [0, 0, 0, 255], 1) });
    expect(m.seam, mode).toBeLessThan(0.01);
    expect(m.motion, mode).toBeGreaterThan(0.5);
  }
  const still = await t.loopCheck('voronoi', { motion: 0 }, { size: t.solid(64, 64, [0, 0, 0, 255], 1) });
  expect(still.motion).toBe(0);
});
