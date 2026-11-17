import { expect, it } from 'vitest';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { at, baseScene, block, centredLogo, H, lit, logoPx, lum, over, px8 } from '../../lib/material2d-testutil';
import type { ImageValue } from '../../types';

const T = { timeout: 180_000 };

it('smoke: a black logo through a chrome material renders', T, async () => {
  const t = await H();
  const logo = t.fromFn(160, 160, logoPx(160));
  const { px } = await lit(logo, { model: 'metal', roughness: 0.15 });
  writePng('material-2d/smoke', px);
  expect(px.data.some((v) => v > 0)).toBe(true);
});

const MODELS: [string, Record<string, unknown> | null][] = [
  ['unwired', null],
  ['matte', { model: 'matte' }],
  ['clay', { model: 'clay', baseColor: [0.8, 0.55, 0.4, 1] }],
  ['plastic', { model: 'plastic', baseColor: [0.9, 0.15, 0.1, 1] }],
  ['metal', { model: 'metal' }],
  ['gold', { model: 'metal', baseColor: [1, 0.78, 0.35, 1], roughness: 0.25 }],
  ['glass', { model: 'glass' }],
  ['toon', { model: 'toon', baseColor: [0.95, 0.5, 0.2, 1] }],
  ['emissive', { model: 'emissive', baseColor: [0.2, 0.9, 1, 1] }],
  ['hologram', { model: 'hologram', baseColor: [0.2, 0.9, 1, 1] }],
  ['matcap', { model: 'matcap' }],
  ['wire', { model: 'wire', baseColor: [0.2, 1, 0.5, 1] }],
];

it('looks: a black logo through every material model (contact sheet)', T, async () => {
  const t = await H();
  const logo = t.fromFn(200, 200, logoPx(200));
  const tiles: Img[] = [];
  for (const [name, mat] of MODELS) {
    const { px } = await lit(logo, mat, name === 'wire' ? { depth: 1.5 } : {});
    writePng(`material-2d/logo-${name}`, px);
    tiles.push(px);
  }
  writePng('material-2d/logo-sheet', sheet(tiles, 6));
});

it('looks: bevel profiles and widths on chrome (contact sheet)', T, async () => {
  const t = await H();
  const logo = t.fromFn(200, 200, logoPx(200));
  const tiles: Img[] = [];
  for (const params of [
    { profile: 'round', bevelWidth: 12 },
    { profile: 'round', bevelWidth: 24 },
    { profile: 'chisel', bevelWidth: 16 },
    { profile: 'pillow', bevelWidth: 14 },
    { profile: 'rim', bevelWidth: 24 },
    { profile: 'round', bevelWidth: 24, depth: 2 },
  ]) tiles.push((await lit(logo, { model: 'metal' }, params)).px);
  writePng('material-2d/profiles', sheet(tiles, 6));
});

it('looks: footage refracted through a glass logo', T, async () => {
  const t = await H();
  const bg = await baseScene();
  const logo = await centredLogo(bg.width, bg.height, 300);
  const plain = await t.pixels(bg);
  const tiles: Img[] = [plain];
  for (const [mat, params] of [
    [{ model: 'glass' }, {}],
    [{ model: 'glass', refraction: 0.3, baseColor: [0.85, 0.95, 1, 1] }, { depth: 1.5, bevelWidth: 30, profile: 'pillow' }],
  ] as const) {
    const { px } = await lit(logo, mat, params, { background: bg }, { matInputs: { background: bg } });
    tiles.push(px);
  }
  writePng('material-2d/glass-over-scene', sheet(tiles, 3), false);
});
