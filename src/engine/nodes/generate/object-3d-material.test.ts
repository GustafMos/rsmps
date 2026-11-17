import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { cubeMesh, textBytes, toObjText, uvSphereMesh } from '../../lib/gen-model-testutil';
import { modelMaterialDebug } from '../../lib/model-render';
import { harness } from '../../testing';
import type { Host, ImageValue } from '../../types';
import { array3dDebug } from './array-3d.node';

const T = { timeout: 180_000 };
const files = new Map<string, ArrayBuffer>();
const host: Host = {
  assetInfo: (id) => (files.has(id) ? { id, name: id, kind: 'model', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null),
  assetFrame: async () => null,
  assetBytes: async (id) => files.get(id) ?? null,
};
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness([], host));
const sha = (px: Img) => createHash('sha1').update(Buffer.from(px.data)).digest('hex');
const at = (px: Img, x: number, y: number) => [0, 1, 2, 3].map((c) => px.data[(y * px.width + x) * 4 + c]);
const lum = (px: Img, x: number, y: number) => 0.2126 * at(px, x, y)[0] + 0.7152 * at(px, x, y)[1] + 0.0722 * at(px, x, y)[2];

/** Radius of the ball (pixels) from its middle row. */
const ballRadius = (px: Img) => {
  let n = 0;
  for (let x = 0; x < px.width; x++) if (px.data[(48 * px.width + x) * 4 + 3] > 128) n++;
  return n / 2;
};
const sphereObj = textBytes(toObjText(uvSphereMesh(48, 24, 0.9)));
const noUv = (() => {
  const m = uvSphereMesh(48, 24, 0.9);
  return textBytes(toObjText({ ...m, uvs: undefined }));
})();
files.set('sphere.obj', sphereObj);
files.set('sphere-nouv.obj', noUv);
files.set('cube.obj', textBytes(toObjText(cubeMesh(0.5))));

const front = { shape: 'custom', model: ['sphere.obj'], rotX: 0, rotY: 0, cameraType: 'orthographic', scale: 1.4, shading: 'smooth' };
const pj = { width: 96, height: 96 };

/** object-3d (custom model) behind an optional Material node with pictures on its inputs. */
async function draw(target: Record<string, unknown>, mat: Record<string, unknown> | null, maps: Record<string, ImageValue> = {}, size = 96) {
  const t = await H();
  let g = createGraph('m3');
  g.project = { ...g.project, width: size, height: size, fps: 10, duration: 2, loop: true };
  const o = addNode(g, t.registry, 'object-3d', { x: 200, y: 0 }, target);
  g = o.graph;
  if (mat) {
    const m = addNode(g, t.registry, 'material', { x: 0, y: 0 }, mat);
    g = m.graph;
    for (const [port, img] of Object.entries(maps)) {
      const s = addNode(g, t.registry, t.source(img));
      g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: m.node.id, port });
    }
    g = connect(g, t.registry, { node: m.node.id, port: 'material' }, { node: o.node.id, port: 'material' });
  }
  const r = await t.engine.evaluate({ graph: g, node: o.node.id, port: 'image', seconds: 0 });
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  return t.pixels(r.value as ImageValue);
}

it('unwired Material on a custom model: pixel-identical to the renderer before materials existed', T, async () => {
  // Hashes of renders made WITHOUT a Material input, recorded with the shared renderer after the material path was added; the unwired path
  // runs the original `fs` entry point and shader code unchanged (the frame uniform only grew by one unused vec4).
  const GOLDEN: Record<string, string> = {
    sphere: 'b2d57d0610eed684d481ddff5b106592e901006e',
    cube: 'f137eb5fd4a579f44751a82ac33bd75494137cc2',
    sphereCel: '471060ca501d807ba9ce2e2147844f46a3800c20',
  };
  const cases: Record<string, Record<string, unknown>> = {
    sphere: { ...front },
    cube: { shape: 'custom', model: ['cube.obj'], rotX: 25, rotY: 30, shading: 'flat', colorMode: 'override', baseColor: [0.9, 0.3, 0.2, 1] },
    sphereCel: { ...front, cel: true, celSteps: 4, lightAzimuth: 40 },
  };
  const got: Record<string, string> = {};
  for (const [k, p] of Object.entries(cases)) got[k] = sha(await draw(p, null));
  for (const k of Object.keys(cases)) expect(got[k], k).toBe(GOLDEN[k]);
  // the same graph with the Material input left empty twice is stable
  expect(sha(await draw(cases.sphere, null))).toBe(got.sphere);
});

it('a Material changes the shading of a custom OBJ model: metal mirrors the sky, matte is lit by the light, toon posterizes', T, async () => {
  const plain = await draw(front, null);
  const matte = await draw(front, { model: 'matte', baseColor: [1, 1, 1, 1] });
  const metal = await draw(front, { model: 'metal', roughness: 0.15 });
  const toon = await draw(front, { model: 'toon', toonBands: 3, outline: 0, specular: 0, baseColor: [1, 1, 1, 1] });
  expect(sha(plain)).not.toBe(sha(matte));
  expect(sha(matte)).not.toBe(sha(metal));
  expect(sha(metal)).not.toBe(sha(toon));
  expect(at(matte, 48, 48)[3]).toBe(255);
  expect(at(matte, 2, 2)[3]).toBe(0);
  // metal: the top of the ball reflects the (bluer) sky, the bottom the dark ground
  const R = ballRadius(metal);
  expect(R).toBeGreaterThan(24);
  const top = at(metal, 48, 48 - Math.round(R * 0.7));
  const bot = at(metal, 48, 48 + Math.round(R * 0.7));
  expect(top[2] - top[0]).toBeGreaterThan(bot[2] - bot[0] + 10);
  // matte lit from the left (azimuth -90): the left of the ball is brighter than the right
  const left = await draw({ ...front, lightAzimuth: -90, lightElevation: 10 }, { model: 'matte', baseColor: [1, 1, 1, 1] });
  expect(lum(left, 48 - 15, 48)).toBeGreaterThan(lum(left, 48 + 15, 48) + 40);
  // toon: a few flat levels
  const levels = new Set<number>();
  for (let y = 20; y < 76; y++) for (let x = 20; x < 76; x++) if (at(toon, x, y)[3] === 255 && Math.hypot(x - 48, y - 48) < 20) levels.add(Math.round(lum(toon, x, y) / 4));
  expect(levels.size).toBeLessThanOrEqual(4);
  expect(levels.size).toBeGreaterThanOrEqual(2);
});

it('colour map reads the model\'s own UVs; a model without UVs gets the triplanar projection; a normal map changes the light', T, async () => {
  const t = await H();
  // u < 0.25 blue, the rest red: the OBJ sphere's front is u = 0.25, u grows toward the screen's left, so the right half of the ball is blue
  const map = t.fromFn(64, 64, (x) => (x < 16 ? [30, 30, 255, 255] : [255, 30, 30, 255]));
  const withUv = await draw(front, { model: 'matte', baseColor: [1, 1, 1, 1], ambient: 1 }, { colorMap: map });
  const l = at(withUv, 48 - 5, 48);
  const r = at(withUv, 48 + 5, 48);
  expect(l[0]).toBeGreaterThan(l[2] + 60);
  expect(r[2]).toBeGreaterThan(r[0] + 60);
  const farLeft = at(withUv, 48 - 20, 48);
  expect(farLeft[0]).toBeGreaterThan(farLeft[2] + 60);
  const noUvPic = await draw({ ...front, model: ['sphere-nouv.obj'] }, { model: 'matte', baseColor: [1, 1, 1, 1] }, { colorMap: map });
  const cols = new Set<string>();
  for (let x = 28; x < 68; x += 3) cols.add(at(noUvPic, x, 48).slice(0, 3).map((v) => v >> 5).join());
  expect(cols.size).toBeGreaterThan(1); // the map shows (planar from the front: left red, right blue)
  expect(at(noUvPic, 48 - 6, 48)[0]).toBeGreaterThan(at(noUvPic, 48 - 6, 48)[2]);
  // a normal map tilting everything along the model's own +U direction: lit from the right and from the left give opposite results,
  // and the mirrored map (tilt along -U) swaps them
  const tilt = t.fromFn(64, 64, () => [230, 128, 200, 255]);
  const tiltBack = t.fromFn(64, 64, () => [25, 128, 200, 255]);
  const mat = { model: 'matte', baseColor: [1, 1, 1, 1], normalStrength: 2 };
  const side = async (az: number, map: ImageValue) => lum(await draw({ ...front, lightAzimuth: az, lightElevation: 10 }, mat, { normalMap: map }), 48, 48);
  const dA = (await side(90, tilt)) - (await side(-90, tilt));
  const dB = (await side(90, tiltBack)) - (await side(-90, tiltBack));
  expect(Math.abs(dA)).toBeGreaterThan(40);
  expect(dA * dB).toBeLessThan(0);
  const flatR = lum(await draw({ ...front, lightAzimuth: 90, lightElevation: 10 }, { model: 'matte', baseColor: [1, 1, 1, 1] }), 48, 48);
  expect(await side(90, tilt)).not.toBe(flatR);
});

it('Material sliders do not compile anything on a custom model; a new structure compiles once', T, async () => {
  const t = await H();
  await draw(front, { model: 'plastic', roughness: 0.3 });
  const created = t.gpu.stats().objects.pipelinesCreated;
  const mine = modelMaterialDebug.pipelines;
  for (const mat of [{ roughness: 0.6 }, { baseColor: [1, 0.2, 0.2, 1] }, { specular: 0.9 }, { rimStrength: 0 }, { opacity: 0.8 }])
    await draw({ ...front, lightAzimuth: 10 + Math.random() * 5 }, { model: 'plastic', ...mat });
  expect(modelMaterialDebug.pipelines).toBe(mine);
  expect(t.gpu.stats().objects.pipelinesCreated).toBe(created);
  await draw(front, { model: 'emissive' });
  expect(modelMaterialDebug.pipelines).toBe(mine + 1);
});

it('3D Array: lit cards differ from unlit ones and follow the light; the unlit default is unchanged', T, async () => {
  const t = await H();
  const project = { width: 64, height: 64 };
  const cards = async (params: Record<string, unknown>, mat: Record<string, unknown> | null, maps: Record<string, ImageValue> = {}, image?: ImageValue) => {
    let g = createGraph('arr');
    g.project = { ...g.project, ...project };
    const s = addNode(g, t.registry, t.source(image ?? t.solid(8, 8, [255, 0, 0, 255])));
    const a = addNode(s.graph, t.registry, 'array-3d', { x: 200, y: 0 }, { countX: 1, countY: 1, countZ: 1, ...params });
    g = connect(a.graph, t.registry, { node: s.node.id, port: 'out' }, { node: a.node.id, port: 'image' });
    if (mat) {
      const m = addNode(g, t.registry, 'material', { x: 0, y: 100 }, mat);
      g = m.graph;
      for (const [port, img] of Object.entries(maps)) {
        const ms = addNode(g, t.registry, t.source(img));
        g = connect(ms.graph, t.registry, { node: ms.node.id, port: 'out' }, { node: m.node.id, port });
      }
      g = connect(g, t.registry, { node: m.node.id, port: 'material' }, { node: a.node.id, port: 'material' });
    }
    const r = await t.engine.evaluate({ graph: g, node: a.node.id, port: 'image', seconds: 0 });
    if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
    return t.pixels(r.value as ImageValue);
  };
  const unlit = await cards({}, null);
  expect(at(unlit, 32, 32)).toEqual([255, 0, 0, 255]);
  expect(at(unlit, 2, 2)[3]).toBe(0);
  const lit = await cards({ lightAzimuth: 0, lightElevation: 50 }, { model: 'matte', baseColor: [1, 1, 1, 1] });
  expect(at(lit, 32, 32)).not.toEqual(at(unlit, 32, 32));
  expect(at(lit, 32, 32)[3]).toBe(255);
  expect(at(lit, 2, 2)[3]).toBe(0);
  expect(at(lit, 32, 32)[0]).toBeGreaterThan(at(lit, 32, 32)[1] + 40); // still red: the card colour is lit, not replaced
  const front0 = await cards({ lightAzimuth: 0, lightElevation: 60 }, { model: 'matte', baseColor: [1, 1, 1, 1] });
  const behind = await cards({ lightAzimuth: 150, lightElevation: 60 }, { model: 'matte', baseColor: [1, 1, 1, 1] });
  expect(at(front0, 32, 32)[0]).toBeGreaterThan(at(behind, 32, 32)[0] + 40);
  // a normal map on the card tilts the light
  const tilt = t.fromFn(8, 8, () => [230, 128, 200, 255]);
  const a = await cards({ lightAzimuth: 90, lightElevation: 10 }, { model: 'matte', baseColor: [1, 1, 1, 1], normalStrength: 2 }, { normalMap: tilt });
  const b = await cards({ lightAzimuth: -90, lightElevation: 10 }, { model: 'matte', baseColor: [1, 1, 1, 1], normalStrength: 2 }, { normalMap: tilt });
  expect(Math.abs(at(a, 32, 32)[0] - at(b, 32, 32)[0])).toBeGreaterThan(20);
  // sliders compile nothing
  const before = array3dDebug.pipelines;
  for (const az of [10, 40, 80]) await cards({ lightAzimuth: az }, { model: 'matte', baseColor: [1, 1, 1, 1], roughness: az / 100 });
  expect(array3dDebug.pipelines).toBe(before);
  // a whole grid of lit cards
  const grid = await cards({ countX: 3, countY: 3, countZ: 1, spacingX: 1.3, spacingY: 1.3, cardWidth: 1.1, lightAzimuth: -40 }, { model: 'plastic' }, {}, t.fromFn(8, 8, (x, y) => [x * 30, y * 30, 160, 255]));
  expect(at(grid, 32, 32)[3]).toBe(255);
});

it('looks: a custom model through metal, glass, toon and more; lit 3D Array cards (contact sheets)', T, async () => {
  const t = await H();
  const torus = { shape: 'custom', model: ['sphere.obj'], rotX: 15, rotY: 30, cameraType: 'perspective', scale: 0.6, shading: 'smooth' };
  const tiles: Img[] = [];
  for (const mat of [null, { model: 'matte' }, { model: 'plastic', baseColor: [0.9, 0.2, 0.15, 1] }, { model: 'metal' }, { model: 'metal', baseColor: [1, 0.78, 0.35, 1], roughness: 0.25 }, { model: 'glass' }, { model: 'toon', baseColor: [0.95, 0.5, 0.2, 1] }, { model: 'hologram', baseColor: [0.2, 0.9, 1, 1] }]) {
    tiles.push(await draw(torus, mat, {}, 160));
  }
  writePng('material-2d/custom-model-materials', sheet(tiles, 4));
  // a cube with a checker colour map through its own UVs
  const check = t.fromFn(64, 64, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? [240, 240, 240, 255] : [60, 90, 200, 255]);
  const cubes: Img[] = [];
  for (const mat of [null, { model: 'plastic', baseColor: [1, 1, 1, 1] }, { model: 'toon', baseColor: [1, 1, 1, 1] }]) {
    cubes.push(await draw({ shape: 'custom', model: ['cube.obj'], rotX: 25, rotY: 35, scale: 0.6 }, mat ?? { model: 'matte', baseColor: [1, 1, 1, 1], ambient: 1 }, { colorMap: check }, 160));
  }
  writePng('material-2d/custom-model-uv-map', sheet(cubes, 3));
  expect(tiles.length).toBe(8);
});
