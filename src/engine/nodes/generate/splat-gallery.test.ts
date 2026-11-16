import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { orbitPosition } from '../../lib/gen-camera';
import { sheet, type Img } from '../../lib/gen-3d-testutil';
import { terrainCloud, torusCloud } from '../../lib/splat-gen';
import { buildNode, cam, evalPort, putCloud, save, splatHost } from '../../lib/splat-testutil';
import type { ImageValue } from '../../types';

/**
 * Looks at the splat nodes: renders contact sheets to <scratchpad>/png/splat/. Asserts only that every picture has content
 * (the assertions that matter live in splat-3d.test.ts and image-to-splats.test.ts); the point is to LOOK at them.
 */
const files = new Map<string, ArrayBuffer>();
const T = { timeout: 300_000 };

const half = (px: Img): Img => {
  const w = Math.floor(px.width / 2), h = Math.floor(px.height / 2);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += px.data[((y * 2 + dy) * px.width + x * 2 + dx) * 4 + c];
    out[(y * w + x) * 4 + c] = s / 4;
  }
  return { data: out, width: w, height: h };
};
const hasContent = (px: Img) => px.data.some((v, i) => i % 4 === 3 && v > 0);
const orbit = (az: number, el: number, dist = 4.5) => cam({ position: orbitPosition([0, 0, 0], dist, az, el), target: [0, 0, 0], fov: 40 });

it('clouds: torus and terrain (100k splats) from two views, sharp and square', T, async () => {
  const t = await harness([], splatHost(files));
  putCloud(files, 'torus100k', torusCloud(100_000, 1));
  putCloud(files, 'terrain100k', terrainCloud(100_000, 2));
  const shots: Img[] = [];
  const render = async (file: string, params: Record<string, unknown>, camera: ReturnType<typeof cam>) => {
    const g = buildNode(t, 'splat-3d', { file: [file], orientation: 'auto', background: [0.06, 0.07, 0.1, 1], ...params }, { camera }, { width: 480, height: 360 });
    return t.pixels((await evalPort(t, g)) as ImageValue);
  };
  const torusCam = (az: number, el: number) => cam({ position: orbitPosition([0, 0, 0], 3.2, az, el), fov: 35 });
  const terrainCam = (az: number, el: number) => cam({ position: orbitPosition([0, 0, 0], 2.6, az, el), fov: 45 });
  shots.push(await render('torus100k', { autoFit: false }, torusCam(20, 35)));
  shots.push(await render('torus100k', { autoFit: false }, torusCam(150, 55)));
  shots.push(await render('terrain100k', { autoFit: false }, terrainCam(0, 35)));
  shots.push(await render('terrain100k', { autoFit: false }, terrainCam(60, 20)));
  shots.push(await render('torus100k', { autoFit: false, shape: 'square', splatSize: 1.3 }, torusCam(20, 35)));
  shots.push(await render('terrain100k', { autoFit: false, shape: 'sharp' }, terrainCam(0, 35)));
  shots.push(await render('torus100k', { autoFit: false, quality: 'draft' }, torusCam(20, 35)));
  shots.push(await render('terrain100k', { autoFit: false, cropMode: 'sphere', cropRadius: 0.7, cropX: 0.1 }, terrainCam(0, 35)));
  for (const s of shots) expect(hasContent(s)).toBe(true);
  save('clouds-sheet', sheet(shots, 4), false);
  save('cloud-torus-a', shots[0]);
  save('cloud-torus-b', shots[1]);
  save('cloud-terrain-a', shots[2]);
  save('cloud-terrain-b', shots[3]);
  save('cloud-torus-square', shots[4]);
});

it('stylised: chunky square and sharp splats from a few thousand points', T, async () => {
  const t = await harness([], splatHost(files));
  putCloud(files, 'torus6k', torusCloud(6000, 3));
  const shots: Img[] = [];
  for (const [shape, size] of [['gaussian', 1], ['sharp', 1.2], ['square', 1.5], ['square', 2.4]] as const) {
    const g = buildNode(t, 'splat-3d', { file: ['torus6k'], orientation: 'auto', shape, splatSize: size, background: [0.06, 0.07, 0.1, 1], autoFit: false }, { camera: cam({ position: orbitPosition([0, 0, 0], 3.2, 25, 35), fov: 35 }) }, { width: 320, height: 240 });
    shots.push(await t.pixels((await evalPort(t, g)) as ImageValue));
  }
  save('chunky-sheet', sheet(shots, 4), false);
  for (const s of shots) expect(hasContent(s)).toBe(true);
});

async function loadPng(name: string): Promise<Img> {
  const { data, info } = await sharp(readFileSync(join(process.cwd(), 'scripts/screenshots/assets', name))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

/** A hand-made depth for base-scene.png: a floor receding upwards and four screens standing on it (white = near). */
function sceneDepth(w: number, h: number): (x: number, y: number) => number {
  const boxes: { x0: number; y0: number; x1: number; y1: number; d: number }[] = [
    { x0: 130, y0: 70, x1: 660, y1: 440, d: 6.4 },
    { x0: 805, y0: 60, x1: 1160, y1: 345, d: 6.9 },
    { x0: 465, y0: 400, x1: 845, y1: 705, d: 4.7 },
    { x0: 1075, y0: 305, x1: 1870, y1: 975, d: 4.1 },
  ];
  return (x, y) => {
    const X = (x / w) * 1920, Y = (y / h) * 1080;
    let d = 7.4 - (Y / 1080) * 4.4; // floor: far at the top of the frame, near at the bottom
    for (const b of boxes) if (X >= b.x0 && X <= b.x1 && Y >= b.y0 && Y <= b.y1) d = Math.min(d, b.d);
    return d;
  };
}

it('pictures: base-scene.png with a guessed depth and with a synthetic depth, from several camera angles', T, async () => {
  const t = await harness([], splatHost(files));
  const base = await loadPng('base-scene.png');
  const small = { width: 960, height: 540 };
  // work at half size: same picture, quicker to look at
  const sm = half(base);
  const picture = t.fromFn(sm.width, sm.height, (x, y) => Array.from(sm.data.subarray((y * sm.width + x) * 4, (y * sm.width + x) * 4 + 4)) as [number, number, number, number]);
  const dfn = sceneDepth(sm.width, sm.height);
  // luma encoding: white = near, mapped between near 3.2 and far 7.6 (distances in scene units)
  const NEAR = 3.2, FAR = 7.6;
  const depth = t.fromFn(sm.width, sm.height, (x, y) => {
    const v = Math.round((1 - (dfn(x, y) - NEAR) / (FAR - NEAR)) * 255);
    return [v, v, v, 255];
  });
  save('base-synthetic-depth', await t.pixels(depth));
  const run = async (params: Record<string, unknown>, wire: Parameters<typeof buildNode>[3]) => {
    const g = buildNode(t, 'image-to-splats', params, { image: picture, ...wire });
    return half(await t.pixels((await evalPort(t, g)) as ImageValue));
  };
  const views = [orbit(0, 0), orbit(14, 4), orbit(-14, 4), orbit(24, -6)];
  const guessed: Img[] = [];
  for (const v of views) guessed.push(await run({ density: 640, guess: 'bulge', near: 3.6, far: 5.4 }, { camera: v }));
  save('base-guess-sheet', sheet(guessed, 2), false);
  const real: Img[] = [];
  for (const v of views) real.push(await run({ density: 640, near: NEAR, far: FAR }, { depth, camera: v }));
  save('base-depth-sheet', sheet(real, 2), false);
  const real2: Img[] = [];
  for (const v of [orbit(16, 3), orbit(-16, 3)]) real2.push(await run({ density: 640, near: NEAR, far: FAR }, { depth, camera: v }));
  save('base-depth-two-angles', sheet(real2, 2), false);
  save('base-depth-left', real2[1]);
  save('base-depth-right', real2[0]);
  const raw = await run({ density: 640, near: NEAR, far: FAR, edgeBreak: 0 }, { depth, camera: orbit(16, 3) });
  save('base-depth-edgebreak-off', raw);
  const square = await run({ density: 240, near: NEAR, far: FAR, splatShape: 'square', splatSize: 1.1 }, { depth, camera: orbit(16, 3) });
  save('base-depth-square', square);
  for (const s of [...guessed, ...real, ...real2]) expect(hasContent(s)).toBe(true);
  void small;
});

it('pictures: a 3D Object render and its Depth output become splats seen from new angles', T, async () => {
  const t = await harness([], splatHost(files));
  const capCam = cam({ position: [0, 0.6, -4.2], target: [0, 0, 0], fov: 40 });
  const g = buildNode(t, 'object-3d', { shape: 'torus', rotX: 40, rotY: 20, baseColor: [0.9, 0.5, 0.2, 1], cameraType: 'perspective', scale: 0.7 }, { camera: capCam }, { width: 480, height: 360 });
  const image = (await evalPort(t, g, 'image')) as ImageValue;
  const depth = (await evalPort(t, g, 'depth')) as ImageValue;
  t.gpu.retain(image.texture);
  t.gpu.retain(depth.texture);
  const bg = [0.1, 0.12, 0.16, 1];
  const shots: Img[] = [await t.pixels(image)];
  for (const v of [cam({ position: orbitPosition([0, 0, 0], 4.2, 25, 15), fov: 40 }), cam({ position: orbitPosition([0, 0, 0], 4.2, -30, 10), fov: 40 }), cam({ position: orbitPosition([0, 0, 0], 4.2, 60, 5), fov: 40 })]) {
    const s = buildNode(t, 'image-to-splats', { density: 360, depthEncoding: 'scene', background: bg, edgeBreak: 0.6 }, { image, depth, camera: v, captureCamera: capCam });
    shots.push(await t.pixels((await evalPort(t, s)) as ImageValue));
  }
  save('object-to-splats-sheet', sheet(shots, 4), true);
  expect(hasContent(shots[1])).toBe(true);
});
