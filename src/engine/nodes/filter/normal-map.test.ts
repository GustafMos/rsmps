import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { block, H, lit, lum, logoPx, px8 } from '../../lib/material2d-testutil';
import type { ImageValue } from '../../types';

const T = { timeout: 180_000 };

const run = async (image: ImageValue, params: Record<string, unknown> = {}, inputs: Record<string, ImageValue> = {}) => {
  const t = await H();
  const out = await t.run('normal-map', params, { image, ...inputs });
  return t.pixels(out.image as ImageValue);
};

it('a brightness ramp gives one constant tilt; flat input is exactly (0.5, 0.5, 1)', T, async () => {
  const t = await H();
  const ramp = t.fromFn(64, 64, (x) => [Math.round((x / 63) * 255), Math.round((x / 63) * 255), Math.round((x / 63) * 255), 255]);
  const px = await run(ramp, { strength: 8 });
  const ref = [px8(px, 12, 32, 0), px8(px, 12, 32, 1), px8(px, 12, 32, 2)];
  for (const x of [8, 20, 32, 44, 55]) for (let c = 0; c < 3; c++) expect(Math.abs(px8(px, x, 32, c) - ref[c]), `x=${x} c=${c}`).toBeLessThanOrEqual(2); // the 8-bit ramp has +-1 level steps
  expect(ref[0]).toBeLessThan(120); // brighter to the right: the surface rises to the right, so it faces left
  expect(Math.abs(ref[1] - 128)).toBeLessThanOrEqual(1);
  expect(ref[2]).toBeLessThan(255);
  const steeper = await run(ramp, { strength: 30 });
  expect(px8(steeper, 32, 32, 0)).toBeLessThan(ref[0] - 10);
  const flat = await run(t.solid(32, 32, [90, 90, 90, 255]));
  expect(px.at(1, 1)[3]).toBe(255);
  for (const [x, y] of [[0, 0], [16, 16], [31, 31]]) { const q = flat.at(x, y); expect(Math.abs(q[0] - 128) <= 1 && Math.abs(q[1] - 128) <= 1 && q[2] === 255 && q[3] === 255, String(q)).toBe(true); }
});

it('invert height flips red, the DirectX convention flips only green', T, async () => {
  const t = await H();
  const rampX = t.fromFn(64, 64, (x) => [Math.round((x / 63) * 255), Math.round((x / 63) * 255), Math.round((x / 63) * 255), 255]);
  const rampY = t.fromFn(64, 64, (_x, y) => [Math.round((y / 63) * 255), Math.round((y / 63) * 255), Math.round((y / 63) * 255), 255]);
  const a = await run(rampX, { strength: 8 });
  const inv = await run(rampX, { strength: 8, invert: true });
  expect(px8(a, 32, 32, 0) - 128).toBeLessThan(0);
  expect(Math.abs(px8(a, 32, 32, 0) - 128 + (px8(inv, 32, 32, 0) - 128))).toBeLessThanOrEqual(2);
  const gl = await run(rampY, { strength: 8 });
  const dx = await run(rampY, { strength: 8, convention: 'directx' });
  // brighter downward in the picture = the surface rises downward, so it faces up: green > 0.5 in OpenGL, < 0.5 in DirectX
  expect(px8(gl, 32, 32, 1)).toBeGreaterThan(135);
  expect(Math.abs(px8(gl, 32, 32, 1) - 128 + (px8(dx, 32, 32, 1) - 128))).toBeLessThanOrEqual(2);
  expect(px8(dx, 32, 32, 0)).toBe(px8(gl, 32, 32, 0));
  expect(px8(dx, 32, 32, 2)).toBe(px8(gl, 32, 32, 2));
});

it('shape bevel: slopes face outward on every side; a wired height picture replaces brightness', T, async () => {
  const px = await run(await block(), { source: 'alpha', bevelWidth: 14, strength: 14 });
  expect(px8(px, 20, 64, 0)).toBeLessThan(110);
  expect(px8(px, 108, 64, 0)).toBeGreaterThan(146);
  expect(px8(px, 64, 20, 1)).toBeGreaterThan(146);
  expect(px8(px, 64, 108, 1)).toBeLessThan(110);
  for (const c of [0, 1]) expect(Math.abs(px.at(64, 64)[c] - 128)).toBeLessThanOrEqual(1);
  const t = await H();
  const black = t.solid(64, 64, [0, 0, 0, 255]);
  const hgt = t.fromFn(64, 64, (x) => [Math.round((x / 63) * 255), Math.round((x / 63) * 255), Math.round((x / 63) * 255), 255]);
  const fromHeight = await run(black, { source: 'height', strength: 8 }, { height: hgt });
  const fromBlack = await run(black, { source: 'luma', strength: 8 });
  expect(px8(fromHeight, 32, 32, 0)).toBeLessThan(120);
  expect(Math.abs(fromBlack.at(32, 32)[0] - 128)).toBeLessThanOrEqual(1);
});

it('pixel art mode: art pixels stay uniform blocks and the tilt snaps to 8 or 4 directions', T, async () => {
  const t = await H();
  const sprite = (x: number, y: number): [number, number, number, number] => {
    const v = Math.hypot(x - 7.5, y - 7.5) < 6.5 ? 255 - Math.floor(Math.hypot(x - 7.5, y - 7.5) * 30) : 0;
    return [v, v, v, 255];
  };
  const big = t.fromFn(128, 128, (x, y) => sprite(x >> 3, y >> 3));
  const input = { ...big, cell: 8 } as ImageValue;
  for (const directions of ['smooth', 'eight', 'four']) {
    const px = await run(input, { strength: 20, blur: 0, directions });
    const angles = new Set<number>();
    for (let by = 0; by < 16; by++)
      for (let bx = 0; bx < 16; bx++) {
        const ref = px.at(bx * 8, by * 8);
        for (const [i, j] of [[1, 1], [7, 7], [3, 5], [7, 0]]) expect(px.at(bx * 8 + i, by * 8 + j), `${directions} ${bx},${by}`).toEqual(ref);
        const nx = ref[0] / 255 * 2 - 1;
        const ny = ref[1] / 255 * 2 - 1;
        if (Math.hypot(nx, ny) > 0.06) angles.add(Math.round((Math.atan2(ny, nx) / Math.PI) * 180 / 5));
      }
    if (directions === 'smooth') expect(angles.size).toBeGreaterThan(12);
    if (directions === 'eight') expect(angles.size).toBeLessThanOrEqual(10); // 8 compass points (8-bit rounding can split one)
    if (directions === 'four') expect(angles.size).toBeLessThanOrEqual(6);
  }
  const out = (await t.run('normal-map', { strength: 20 }, { image: input })).image as ImageValue;
  expect(out.cell).toBe(8);
});

it('tileable edges wrap the slope around the picture; same result at 2x resolution with unit 2', T, async () => {
  const t = await H();
  const ramp = t.fromFn(64, 64, (x) => [Math.round((x / 63) * 255), Math.round((x / 63) * 255), Math.round((x / 63) * 255), 255]);
  const open = await run(ramp, { strength: 8, tile: false });
  const wrapped = await run(ramp, { strength: 8, tile: true });
  // at the seam the wrap sees a cliff from white back to black
  expect(Math.abs(px8(wrapped, 0, 32, 0) - 128)).toBeGreaterThan(Math.abs(px8(open, 0, 32, 0) - 128) + 20);
  expect(px8(wrapped, 32, 32, 0)).toBe(px8(open, 32, 32, 0));
  const big = t.fromFn(128, 128, (x) => [Math.round((x / 127) * 255), Math.round((x / 127) * 255), Math.round((x / 127) * 255), 255], 2);
  const a = await run(ramp, { strength: 8 });
  const b = await run(big, { strength: 8 });
  for (let c = 0; c < 3; c++) expect(Math.abs(px8(a, 32, 32, c) - px8(b, 64, 64, c))).toBeLessThanOrEqual(2);
});

it('Material 2D lights with a normal map made by this node (and with the Material\'s own normal map input)', T, async () => {
  const t = await H();
  // a logo whose brightness carries bumps: Normal Map -> Material 2D normal input
  const bumps = t.fromFn(128, 128, (x, y) => {
    const v = Math.round(128 + 120 * Math.sin(x / 6) * Math.sin(y / 6));
    return [v, v, v, 255];
  });
  const white = t.solid(128, 128, [255, 255, 255, 255]);
  const nm = (await t.run('normal-map', { strength: 12 }, { image: bumps })).image as ImageValue;
  const mat = { model: 'matte', baseColor: [1, 1, 1, 1] };
  const none = (await lit(white, mat, { shape: 'flat' })).px;
  const withMap = (await lit(white, mat, { shape: 'flat' }, { normal: nm })).px;
  const viaMaterial = (await lit(white, mat, { shape: 'flat' }, {}, { matInputs: { normalMap: nm } })).px;
  let spread = 0;
  let spread0 = 0;
  for (let x = 4; x < 124; x += 2) {
    spread += Math.abs(lum(withMap, x, 40) - lum(withMap, 64, 40));
    spread0 += Math.abs(lum(none, x, 40) - lum(none, 64, 40));
  }
  expect(spread0).toBe(0);
  expect(spread).toBeGreaterThan(400);
  expect(viaMaterial.data).toEqual(withMap.data);
  // a normal map painted by hand (plain tilt) works the same way: see the Material 2D tests
  const logo = t.fromFn(160, 160, logoPx(160));
  const nmLogo = (await t.run('normal-map', { source: 'alpha', bevelWidth: 16, strength: 16 }, { image: logo })).image as ImageValue;
  const viaNode = (await lit(logo, { model: 'matte', baseColor: [1, 1, 1, 1] }, { shape: 'flat' }, { normal: nmLogo })).px;
  const direct = (await lit(logo, { model: 'matte', baseColor: [1, 1, 1, 1] }, { shape: 'bevel', bevelWidth: 16, depth: 1 })).px;
  // the same bevel, lit through the stored map or computed inside Material 2D: very close
  let diff = 0;
  let n = 0;
  for (let y = 0; y < 160; y += 2)
    for (let x = 0; x < 160; x += 2)
      if (px8(direct, x, y, 3) === 255) {
        diff += Math.abs(lum(viaNode, x, y) - lum(direct, x, y));
        n++;
      }
  expect(diff / n).toBeLessThan(14);
  writePng('material-2d/normal-map-roundtrip', sheet([logo as unknown as Img, viaNode, direct].filter((x): x is Img => 'data' in x), 3));
});

it('moving sliders compiles nothing', T, async () => {
  const t = await H();
  const img = t.scene(64, 64);
  await run(img, { strength: 3 });
  const before = t.gpu.stats().objects.pipelinesCreated;
  for (const params of [{ strength: 9 }, { blur: 4 }, { strength: 20, invert: true }, { tile: true }]) await run(img, params);
  expect(t.gpu.stats().objects.pipelinesCreated - before).toBeLessThanOrEqual(0);
});
