import { expect, it } from 'vitest';
import type { Img } from '../../lib/gen-3d-testutil';
import { at, block, H, lit, logoPx, lum, px8 } from '../../lib/material2d-testutil';
import { LOOP_SEAM_OK } from '../../testing';
import type { ImageValue } from '../../types';

const T = { timeout: 180_000 };

it('bevel: the height rises monotonically from the edge inward and stays inside the shape', T, async () => {
  const { px } = await lit(await block(), { model: 'matte' }, { bevelWidth: 14, profile: 'round' }, {}, { port: 'height' });
  const row: number[] = [];
  for (let x = 16; x <= 64; x++) row.push(px8(px, x, 64, 0));
  for (let i = 1; i < row.length; i++) expect(row[i], `x=${16 + i}`).toBeGreaterThanOrEqual(row[i - 1]);
  expect(row[0]).toBeLessThan(90); // a round profile is steep at the very edge
  expect(row[row.length - 1]).toBeGreaterThan(240);
  expect(px8(px, 2, 64, 0)).toBe(0);
});

it('light from the left brightens left-facing slopes more than right-facing ones, and moving the light flips it', T, async () => {
  const mat = { model: 'matte', baseColor: [1, 1, 1, 1] };
  const left = (await lit(await block(), mat, { lightAngle: -90, lightHeight: 35, bevelWidth: 14 })).px;
  expect(lum(left, 19, 64)).toBeGreaterThan(lum(left, 108, 64) + 25);
  const right = (await lit(await block(), mat, { lightAngle: 90, lightHeight: 35, bevelWidth: 14 })).px;
  expect(lum(right, 108, 64)).toBeGreaterThan(lum(right, 19, 64) + 25);
  const top = (await lit(await block(), mat, { lightAngle: 0, lightHeight: 35, bevelWidth: 14 })).px;
  expect(lum(top, 64, 19)).toBeGreaterThan(lum(top, 64, 108) + 25);
});

it('metal and matte differ: a highlight on plastic, a bluish sky on top of metal and a dark ground below', T, async () => {
  const logo = (await H()).fromFn(160, 160, logoPx(160));
  const matte = (await lit(logo, { model: 'matte' })).px;
  const plastic = (await lit(logo, { model: 'plastic', roughness: 0.1, specular: 1, baseColor: [0.6, 0.1, 0.1, 1] })).px;
  const metal = (await lit(logo, { model: 'metal', roughness: 0.15 })).px;
  const hot = (px: Img) => {
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] > 250 && px.data[i + 1] > 235) n++;
    return n;
  };
  expect(hot(plastic)).toBeGreaterThan(hot(matte));
  const topB = at(metal, 80, 16 + 5);
  const botB = at(metal, 80, 144 - 5);
  expect(topB[2] - topB[0]).toBeGreaterThan(botB[2] - botB[0] + 10);
  expect(lum(metal, 80, 16 + 5)).toBeGreaterThan(lum(metal, 80, 144 - 5));
  const strip = (px: Img) => Array.from({ length: 9 }, (_, i) => lum(px, 80, 16 + i)).join();
  expect(strip(matte)).not.toBe(strip(metal));
});

it('toon: the light falls into a few flat bands (more bands = more levels)', T, async () => {
  const t = await H();
  const disc = t.fromFn(128, 128, (x, y) => [255, 255, 255, Math.hypot(x - 63.5, y - 63.5) < 56 ? 255 : 0]);
  const levels = async (bands: number) => {
    const { px } = await lit(disc, { model: 'toon', toonBands: bands, outline: 0, specular: 0 }, { profile: 'pillow', bevelWidth: 40, depth: 1.5 });
    const set = new Set<number>();
    for (let y = 8; y < 120; y++) for (let x = 8; x < 120; x++) if (px.data[(y * 128 + x) * 4 + 3] === 255) set.add(Math.round(lum(px, x, y) / 4));
    return set.size;
  };
  const three = await levels(3);
  const six = await levels(6);
  expect(three).toBeLessThanOrEqual(4);
  expect(three).toBeGreaterThanOrEqual(2);
  expect(six).toBeGreaterThan(three);
  expect(six).toBeLessThanOrEqual(7);
});

it('glass refracts the background: the bevel shifts it, the flat middle does not', T, async () => {
  const t = await H();
  const bg = t.fromFn(128, 128, (x) => [Math.round((x / 127) * 255), Math.round(255 - (x / 127) * 255), 120, 255]);
  const { px } = await lit(await block(), { model: 'glass', refraction: 0.35, baseColor: [1, 1, 1, 1] }, { bevelWidth: 20, depth: 1.5 }, { background: bg }, { matInputs: { background: bg } });
  const plain = await t.pixels(bg);
  expect(Math.abs(px8(px, 64, 64, 0) - px8(plain, 64, 64, 0))).toBeLessThan(25);
  let moved = 0;
  for (let x = 17; x < 30; x++) moved += Math.abs(px8(px, x, 64, 0) - px8(plain, x, 64, 0));
  expect(moved / 13).toBeGreaterThan(8);
  expect(px8(px, 64, 64, 3)).toBe(255); // solid over the wired background
  expect(px8(px, 4, 4, 3)).toBe(0); // clear outside the shape
});

it('the normal output encodes a flat surface as (0.5, 0.5, 1) and bevel slopes tilt the right way', T, async () => {
  const flat = (await lit(await block(), { model: 'matte' }, { shape: 'flat' }, {}, { port: 'normal' })).px;
  for (const [x, y] of [[64, 64], [20, 20], [3, 3]]) {
    expect(Math.abs(px8(flat, x, y, 0) - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(px8(flat, x, y, 1) - 128)).toBeLessThanOrEqual(1);
    expect(px8(flat, x, y, 2)).toBeGreaterThanOrEqual(254);
    expect(px8(flat, x, y, 3)).toBe(255);
  }
  const bev = (await lit(await block(), { model: 'matte' }, { bevelWidth: 14 }, {}, { port: 'normal' })).px;
  expect(px8(bev, 20, 64, 0)).toBeLessThan(110);
  expect(px8(bev, 108, 64, 0)).toBeGreaterThan(146);
  expect(px8(bev, 64, 20, 1)).toBeGreaterThan(146);
  expect(px8(bev, 64, 108, 1)).toBeLessThan(110);
  expect(Math.abs(px8(bev, 64, 64, 0) - 128)).toBeLessThanOrEqual(2);
});

it('a wired normal map lights like a bevel would, and flip Y reverses its green', T, async () => {
  const t = await H();
  const tilt = t.fromFn(128, 128, () => [64, 128, 220, 255]); // tilted to the left
  const mat = { model: 'matte', baseColor: [1, 1, 1, 1] };
  const fromLeft = (await lit(await block(), mat, { shape: 'flat', lightAngle: -90, lightHeight: 40 }, { normal: tilt })).px;
  const fromRight = (await lit(await block(), mat, { shape: 'flat', lightAngle: 90, lightHeight: 40 }, { normal: tilt })).px;
  expect(lum(fromLeft, 64, 64)).toBeGreaterThan(lum(fromRight, 64, 64) + 40);
  const up = t.fromFn(128, 128, () => [128, 220, 220, 255]); // tilted up
  const a = (await lit(await block(), mat, { shape: 'flat', lightAngle: 0, lightHeight: 40 }, { normal: up })).px;
  const b = (await lit(await block(), mat, { shape: 'flat', lightAngle: 0, lightHeight: 40, flipY: true }, { normal: up })).px;
  expect(lum(a, 64, 64)).toBeGreaterThan(lum(b, 64, 64) + 30);
});

it('art grid: a pixel sprite with cell 8 stays blocky, keeps its cell and its hard edge', T, async () => {
  const t = await H();
  const sprite = (x: number, y: number): [number, number, number, number] => {
    const inside = Math.hypot(x - 7.5, y - 7.5) < 6.5 || (x > 3 && x < 12 && y > 10 && y < 15);
    return inside ? ((x + y) % 5 === 0 ? [240, 200, 60, 255] : [200, 60, 50, 255]) : [0, 0, 0, 0];
  };
  const big = t.fromFn(128, 128, (x, y) => sprite(x >> 3, y >> 3));
  const input = { ...big, cell: 8 } as ImageValue;
  const { image, px } = await lit(input, { model: 'plastic' }, { cel: true, celSteps: 4, bevelWidth: 24 });
  expect((image as ImageValue).cell).toBe(8);
  let blocks = 0;
  const cols = new Set<string>();
  for (let by = 0; by < 16; by++)
    for (let bx = 0; bx < 16; bx++) {
      const ref = at(px, bx * 8, by * 8);
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) expect(at(px, bx * 8 + i, by * 8 + j), `block ${bx},${by}`).toEqual(ref);
      if (ref[3] === 255) {
        blocks++;
        cols.add(ref.join());
      }
    }
  expect(blocks).toBeGreaterThan(60);
  expect(cols.size).toBeLessThan(40); // light quantised into 4 steps
  const some = new Set<number>();
  for (let bx = 3; bx < 13; bx++) some.add(px8(px, bx * 8, 8 * 8, 0));
  expect(some.size).toBeGreaterThan(1); // not one flat colour: the pixel bevel is lit
});

it('unwired material: a glossy plastic that keeps the picture colors; an empty frame stays empty', T, async () => {
  const t = await H();
  const { px } = await lit(await block([200, 30, 30]), null);
  expect(px8(px, 64, 64, 0)).toBeGreaterThan(px8(px, 64, 64, 2) + 60);
  expect(px8(px, 64, 64, 3)).toBe(255);
  expect(px8(px, 4, 4, 3)).toBe(0);
  const empty = (await lit(t.fromFn(32, 32, () => [0, 0, 0, 0]), null)).px;
  expect(empty.data.every((v) => v === 0)).toBe(true);
});

it('moving sliders compiles nothing; optional outputs are only rendered when asked for', T, async () => {
  const t = await H();
  const logo = t.fromFn(96, 96, logoPx(96));
  const created = () => t.gpu.stats().objects.pipelinesCreated;
  await lit(logo, { model: 'metal' }, {});
  const before = created();
  for (const params of [{ lightAngle: 10 }, { lightAngle: 80, lightHeight: 30 }, { depth: 2 }, { bevelWidth: 5 }, { ambient: 0.8 }, { lightIntensity: 1.7 }, { fillIntensity: 0.6, fillAngle: 100 }, { shadow: 0.5, shadowOffset: 12 }, { detail: 0.5 }, { cel: true, celSteps: 5 }, { sweep: 1 }])
    await lit(logo, { model: 'metal', roughness: 0.4 }, params);
  expect(created() - before).toBe(0);
  const labels: string[] = [];
  const orig = t.gpu.pass.bind(t.gpu);
  (t.gpu as { pass: typeof t.gpu.pass }).pass = (o) => {
    labels.push(o.label ?? '');
    return orig(o);
  };
  try {
    await lit(logo, { model: 'metal' }, { lightAngle: 33 });
    expect(labels.some((l) => l.endsWith(' lit'))).toBe(true);
    expect(labels.some((l) => l.endsWith(' normal') || l.endsWith(' height'))).toBe(false);
    labels.length = 0;
    await lit(logo, { model: 'metal' }, { lightAngle: 34 }, {}, { port: 'normal' });
    expect(labels.some((l) => l.endsWith(' normal'))).toBe(true);
    expect(labels.some((l) => l.endsWith(' height'))).toBe(false);
  } finally {
    (t.gpu as { pass: typeof t.gpu.pass }).pass = orig;
  }
});

it('shadow lies away from the light, outside the shape; the light sweep loops by whole cycles; nothing moves by default', T, async () => {
  const t = await H();
  const small = t.fromFn(128, 128, (x, y) => [255, 255, 255, x >= 40 && x < 80 && y >= 30 && y < 70 ? 255 : 0]);
  const { px } = await lit(small, { model: 'matte' }, { shadow: 1, shadowOffset: 14, shadowBlur: 4, lightAngle: -45, shadowColor: [0, 0, 0, 1] });
  expect(px8(px, 84, 60, 3)).toBeGreaterThan(80);
  expect(px8(px, 30, 20, 3)).toBeLessThan(10);
  const r = await t.loopCheck('material-2d', { sweep: 1 }, { image: small });
  expect(r.seam, r.text).toBeLessThanOrEqual(LOOP_SEAM_OK);
  expect(r.motion).toBeGreaterThan(0.05);
  const still = await t.loopCheck('material-2d', {}, { image: small });
  expect(still.motion).toBe(0);
});
