import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { cubeMesh, meshGlb, meshGltf, quadMesh, textBytes, toObjText, uvSphereMesh } from '../../lib/gen-model-testutil';
import { harness } from '../../testing';
import type { Host, ImageValue } from '../../types';

const files = new Map<string, ArrayBuffer>();
let decodeTexture: GPUTexture | null = null;
const host: Host = {
  assetInfo: (id) => (files.has(id) ? { id, name: id, kind: 'model', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null),
  assetFrame: async () => null,
  assetBytes: async (id) => files.get(id) ?? null,
  decodeImageBytes: async () => (decodeTexture ? { texture: decodeTexture, width: 4, height: 4 } : null),
};
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness([], host));
const project = { width: 64, height: 64, fps: 10, duration: 2, loop: true };
const BASE = { model: ['m'], shading: 'unlit', cameraType: 'orthographic', scale: 0.5, spinY: 0 };

const red = { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } };
const blue = { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } };

async function render(bytes: ArrayBuffer, params: Record<string, unknown> = {}, inputs: Record<string, ImageValue> = {}, name = 'm') {
  const t = await H();
  files.set(name, bytes);
  const out = await t.run('model-3d', { ...BASE, model: [name], ...params }, inputs, { project });
  return t.pixels(out.image as never);
}
const at = (px: { data: Uint8ClampedArray; width: number }, x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));
function bounds(px: { data: Uint8ClampedArray; width: number; height: number }) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (px.data[(y * px.width + x) * 4 + 3] > 128) {
        n++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
  return { n, minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

it('renders a glb cube: visible, centred, on a transparent background', async () => {
  const px = await render(meshGlb(cubeMesh(0.5, red)));
  const b = bounds(px);
  expect(b.n).toBeGreaterThan(200);
  expect(Math.abs(b.cx - 32)).toBeLessThan(1.5);
  expect(Math.abs(b.cy - 32)).toBeLessThan(1.5);
  expect(at(px, 0, 0)[3]).toBe(0);
  expect(at(px, 63, 63)[3]).toBe(0);
  const [r, g, bl, a] = at(px, 32, 32);
  expect([r, g, bl, a]).toEqual([255, 0, 0, 255]);
});

it('autoFit scales any model to the same size; turning it off keeps native units', async () => {
  const small = bounds(await render(meshGlb(cubeMesh(0.01, red))));
  const large = bounds(await render(meshGlb(cubeMesh(500, red))));
  expect(Math.abs(small.maxX - small.minX - (large.maxX - large.minX))).toBeLessThan(2);
  const native = bounds(await render(meshGlb(cubeMesh(0.5, red)), { autoFit: false }));
  const fitted = bounds(await render(meshGlb(cubeMesh(0.5, red)), { autoFit: true }));
  expect(fitted.n).toBeGreaterThan(native.n); // cube half 0.5 fills less than the fitted 0.95-radius cube
});

it('depth ordering: a nearer quad stays in front even when it is drawn first', async () => {
  // glTF viewers look from +z, so z = 0.5 is nearer to the camera. The small red quad is listed FIRST.
  const near = quadMesh(0.5, 0.4, red);
  const far = quadMesh(0, 1, blue);
  const px = await render(meshGlb([near, far]), { backFaces: true });
  const centre = at(px, 32, 32);
  const rim = at(px, 32 + 8, 32);
  expect(centre[0]).toBeGreaterThan(200);
  expect(centre[2]).toBeLessThan(40);
  expect(rim[2]).toBeGreaterThan(200);
  expect(rim[0]).toBeLessThan(40);
  // listing order swapped: same picture
  const px2 = await render(meshGlb([far, near]), { backFaces: true });
  expect(Buffer.from(px.data).equals(Buffer.from(px2.data))).toBe(true);
});

it('faces point at the camera: back-face culling hides the far side of a one-sided quad', async () => {
  const front = bounds(await render(meshGlb(quadMesh(0, 1, red))));
  expect(front.n).toBeGreaterThan(100);
  // rotate the quad to face away
  const away = bounds(await render(meshGlb(quadMesh(0, 1, red)), { rotY: 180 }));
  expect(away.n).toBe(0);
  const both = bounds(await render(meshGlb(quadMesh(0, 1, red)), { rotY: 180, backFaces: true }));
  expect(both.n).toBeGreaterThan(100);
  const ds = bounds(await render(meshGlb(quadMesh(0, 1, { ...red, doubleSided: true })), { rotY: 180 }));
  expect(ds.n).toBeGreaterThan(100);
});

it('smooth and flat shading differ on a low-poly sphere; flat is faceted', async () => {
  const sphere = meshGlb(uvSphereMesh(8, 4, 1));
  const smooth = await render(sphere, { shading: 'smooth', specular: 0 });
  const flat = await render(sphere, { shading: 'flat', specular: 0 });
  expect(Buffer.from(smooth.data).equals(Buffer.from(flat.data))).toBe(false);
  const levels = (px: typeof flat) => {
    const s = new Set<number>();
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) if (px.data[(y * 64 + x) * 4 + 3] === 255) s.add(px.data[(y * 64 + x) * 4]);
    return s.size;
  };
  expect(levels(flat)).toBeLessThan(levels(smooth) / 2);
  const unlit = await render(sphere, { shading: 'unlit' });
  expect(levels(unlit)).toBe(1);
});

it('lighting follows the light direction, cel shading bands the result', async () => {
  const sphere = meshGlb(uvSphereMesh(24, 12, 1));
  const px = await render(sphere, { shading: 'smooth', lightAzimuth: -70, lightElevation: 0, ambient: 0.05, specular: 0, colorMode: 'override', baseColor: [1, 1, 1, 1] });
  expect(at(px, 24, 32)[0]).toBeGreaterThan(at(px, 40, 32)[0] + 70);
  const cel = await render(sphere, { cel: true, celSteps: 3, specular: 0, colorMode: 'override', baseColor: [1, 1, 1, 1], shading: 'smooth' });
  const levels = new Set<number>();
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) if (cel.data[(y * 64 + x) * 4 + 3] === 255) levels.add(cel.data[(y * 64 + x) * 4]);
  expect(levels.size).toBeLessThanOrEqual(4);
  expect(levels.size).toBeGreaterThanOrEqual(2);
});

it('colour override / tint, position and scale params', async () => {
  const t = await H();
  void t;
  const override = await render(meshGlb(cubeMesh(0.5, red)), { colorMode: 'override', baseColor: [0, 1, 0, 1] });
  expect(at(override, 32, 32)).toEqual([0, 255, 0, 255]);
  const tint = await render(meshGlb(cubeMesh(0.5, red)), { colorMode: 'tint', baseColor: [0.5, 0.5, 0.5, 1] });
  expect(at(tint, 32, 32)[0]).toBeGreaterThan(120);
  expect(at(tint, 32, 32)[0]).toBeLessThan(135);
  const base = bounds(await render(meshGlb(cubeMesh(0.5, red)), { cameraType: 'orthographic' }));
  const moved = bounds(await render(meshGlb(cubeMesh(0.5, red)), { posX: 0.8, posY: 0.8 }));
  expect(moved.cx).toBeGreaterThan(base.cx + 5);
  expect(moved.cy).toBeLessThan(base.cy - 5);
  const big = bounds(await render(meshGlb(cubeMesh(0.5, red)), { objectScale: 1.5 }));
  expect(big.maxX - big.minX).toBeGreaterThan((base.maxX - base.minX) * 1.3);
});

it('renders .gltf (base64) and .obj files too', async () => {
  const gltf = bounds(await render(meshGltf(cubeMesh(0.5, red))));
  expect(gltf.n).toBeGreaterThan(200);
  const obj = bounds(await render(textBytes(toObjText(cubeMesh(0.5)))));
  expect(obj.n).toBeGreaterThan(200);
  expect(Math.abs(obj.cx - 32)).toBeLessThan(1.5);
});

it('a texture input replaces the base colour texture; embedded textures need host.decodeImageBytes', async () => {
  const t = await H();
  const green = t.solid(4, 4, [0, 255, 0, 255]);
  const px = await render(meshGlb(cubeMesh(0.5, red)), { colorMode: 'model' }, { texture: green });
  const [r, g, b] = at(px, 32, 32);
  // red factor x green texture = black: the texture multiplies the factor
  expect(r + g + b).toBeLessThan(30);
  // plain white factor: the texture shows as-is
  const white = { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } };
  const px2 = await render(meshGlb(cubeMesh(0.5, white)), {}, { texture: green });
  expect(at(px2, 32, 32)).toEqual([0, 255, 0, 255]);
  // embedded texture decoded by the host
  const withTex = { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } };
  const { buildGltfParts, toGlb } = await import('../../lib/gen-model-testutil');
  const parts = buildGltfParts([cubeMesh(0.5, withTex)]);
  const joined = new Uint8Array(parts.bin.length + 8);
  joined.set(parts.bin);
  parts.json.bufferViews.push({ buffer: 0, byteOffset: parts.bin.length, byteLength: 8 });
  parts.json.buffers[0].byteLength = joined.length;
  parts.json.images = [{ bufferView: parts.json.bufferViews.length - 1, mimeType: 'image/png' }];
  parts.json.textures = [{ source: 0 }];
  (parts.json.materials[0] as any).pbrMetallicRoughness.baseColorTexture = { index: 0 };
  const glb = toGlb(parts.json, joined);
  decodeTexture = null; // headless: no decoder -> base colour factor (white)
  const headless = await render(glb, {}, {}, 'tex-a');
  expect(at(headless, 32, 32)).toEqual([255, 255, 255, 255]);
  decodeTexture = green.texture;
  const decoded = await render(glb, {}, {}, 'tex-a');
  expect(at(decoded, 32, 32)).toEqual([0, 255, 0, 255]);
  decodeTexture = null;
});

it('wireframe draws the triangle edges on top', async () => {
  const sphere = meshGlb(uvSphereMesh(12, 6, 1));
  const plain = await render(sphere, { colorMode: 'override', baseColor: [1, 1, 1, 1] });
  const wired = await render(sphere, { colorMode: 'override', baseColor: [1, 1, 1, 1], wireframe: true, wireColor: [0, 0, 0, 1] });
  let dark = 0;
  for (let i = 0; i < wired.data.length; i += 4) if (wired.data[i + 3] > 200 && wired.data[i] < 100) dark++;
  expect(dark).toBeGreaterThan(40);
  expect(Buffer.from(plain.data).equals(Buffer.from(wired.data))).toBe(false);
});

it('empty node and a missing file give a transparent image; bad files give readable errors', async () => {
  const t = await H();
  const empty = await t.run('model-3d', { model: [] }, {}, { project });
  const px = await t.pixels(empty.image as never);
  expect(px.data.every((v) => v === 0)).toBe(true);
  expect(await rejects(() => t.run('model-3d', { model: ['nope'] }, {}, { project }))).toMatch(/file is missing/);
  const draco = textBytes(JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }));
  files.set('draco', draco);
  expect(await rejects(() => t.run('model-3d', { model: ['draco'] }, {}, { project }))).toMatch(/without Draco\/meshopt compression/);
  files.set('ext', textBytes(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'a.bin', byteLength: 1 }] })));
  expect(await rejects(() => t.run('model-3d', { model: ['ext'] }, {}, { project }))).toMatch(/needs its external files/);
  files.set('junk', textBytes('hello world, not a model'));
  expect(await rejects(() => t.run('model-3d', { model: ['junk'] }, {}, { project }))).toMatch(/no faces/);
});

it('the batch item picks the model', async () => {
  const t = await H();
  files.set('a', meshGlb(cubeMesh(0.5, red)));
  files.set('b', meshGlb(cubeMesh(0.5, blue)));
  const pick = async (item: number) => at(await t.pixels((await t.run('model-3d', { ...BASE, model: ['a', 'b'] }, {}, { project, item, itemCount: 2 })).image as never), 32, 32);
  expect((await pick(0))[0]).toBe(255);
  expect((await pick(1))[2]).toBe(255);
  expect((await pick(2))[0]).toBe(255);
});

it('spin loops exactly (whole turns) and moves; still by default', async () => {
  const t = await H();
  files.set('m', meshGlb(cubeMesh(0.5, red)));
  files.set('m', meshGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], uint16: true, material: red }));
  const r = await t.loopCheck('model-3d', { ...BASE, backFaces: true, spinZ: 1, spinX: 2 });
  expect(r.seam).toBeLessThan(0.05);
  expect(r.motion).toBeGreaterThan(1);
  const still = await t.loopCheck('model-3d', { ...BASE, backFaces: true, rotY: 30 });
  expect(still.motion).toBe(0);
});

/** Build model-3d (+ optional camera) in a graph. */
async function graphRender(camera: Record<string, unknown> | null, params: Record<string, unknown> = {}) {
  const t = await H();
  files.set('m', meshGlb(cubeMesh(0.5, red)));
  let graph = createGraph('t');
  graph.project = { ...graph.project, ...project };
  const o = addNode(graph, t.registry, 'model-3d', { x: 0, y: 0 }, { ...BASE, ...params });
  graph = o.graph;
  if (camera) {
    const c = addNode(graph, t.registry, 'camera', { x: 0, y: 0 }, camera);
    graph = connect(c.graph, t.registry, { node: c.node.id, port: 'camera' }, { node: o.node.id, port: 'camera' });
  }
  return t.pixels((await t.evalGraph(graph, o.node.id)) as ImageValue);
}

it('a wired camera overrides the built-in one; panoramic differs from perspective', async () => {
  const persp = { projection: 'perspective', rig: 'front', distance: 4, fov: 40 };
  const a = await graphRender(persp, { cameraType: 'orthographic', scale: 0.1, x: 0.9 });
  const b = await graphRender(persp, { cameraType: 'perspective', scale: 0.9, x: 0.1 });
  expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  const builtin = await graphRender(null);
  expect(Buffer.from(a.data).equals(Buffer.from(builtin.data))).toBe(false);
  for (const projection of ['orthographic', 'fisheye', 'panoramic', 'cylindrical']) {
    const px = await graphRender({ projection, rig: 'front', distance: 2.5, orthoSize: 3, fov: 100 });
    const bb = bounds(px);
    expect(bb.n, projection).toBeGreaterThan(30);
    expect(Math.abs(bb.cx - 32), projection).toBeLessThan(3);
    expect(Buffer.from(px.data).equals(Buffer.from(a.data)), projection).toBe(false);
  }
});

it('camera motion loops exactly through the model render', async () => {
  const t = await H();
  files.set('m', meshGlb(cubeMesh(0.5, red)));
  let graph = createGraph('t');
  graph.project = { ...graph.project, ...project };
  const o = addNode(graph, t.registry, 'model-3d', { x: 0, y: 0 }, { ...BASE, shading: 'smooth', rotY: 30 });
  const c = addNode(o.graph, t.registry, 'camera', { x: 0, y: 0 }, { motion: 'orbit', cycles: 1 });
  graph = connect(c.graph, t.registry, { node: c.node.id, port: 'camera' }, { node: o.node.id, port: 'camera' });
  const grab = async (s: number) => Buffer.from((await t.pixels((await t.evalGraph(graph, o.node.id, { seconds: s })) as ImageValue)).data);
  const [a, mid, end] = [await grab(0), await grab(1), await grab(2)];
  let seam = 0, motion = 0;
  for (let i = 0; i < a.length; i++) { seam += Math.abs(a[i] - end[i]); motion += Math.abs(a[i] - mid[i]); }
  expect(seam / a.length).toBeLessThan(0.05);
  expect(motion / a.length).toBeGreaterThan(0.5);
});

it('output size follows the size input, unit is stamped', async () => {
  const t = await H();
  files.set('m', meshGlb(cubeMesh(0.5, red)));
  const out = await t.run('model-3d', { ...BASE }, { size: t.solid(40, 30, [0, 0, 0, 255], 2) }, { project });
  const img = out.image as ImageValue;
  expect([img.width, img.height, img.unit]).toEqual([40, 30, 2]);
  expect(bounds(await t.pixels(img)).n).toBeGreaterThan(30);
});
