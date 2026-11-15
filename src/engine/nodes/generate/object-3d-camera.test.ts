import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';
import type { GraphDoc, ImageValue } from '../../types';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const W = 96;
const project = { width: W, height: 64, fps: 10, duration: 2, loop: true };
const OBJ = { shape: 'sphere', rotX: 0, rotY: 0, rotZ: 0, spinY: 0, baseColor: [1, 1, 1, 1] };

type Spec = { camera?: Record<string, unknown>; object?: Record<string, unknown> };

/** Build camera -> object-3d and return the graph plus the object's node id. */
async function build(spec: Spec, g?: GraphDoc) {
  const t = await H();
  let graph = g ?? createGraph('t');
  graph.project = { ...graph.project, ...project };
  const o = addNode(graph, t.registry, 'object-3d', { x: 0, y: 0 }, { ...OBJ, ...spec.object });
  graph = o.graph;
  if (spec.camera) {
    const c = addNode(graph, t.registry, 'camera', { x: 0, y: 0 }, spec.camera);
    graph = connect(c.graph, t.registry, { node: c.node.id, port: 'camera' }, { node: o.node.id, port: 'camera' });
  }
  return { graph, id: o.node.id };
}
async function render(spec: Spec, seconds = 0) {
  const t = await H();
  const { graph, id } = await build(spec);
  const img = (await t.evalGraph(graph, id, { seconds })) as ImageValue;
  return t.pixels(img);
}
function bounds(px: { data: Uint8ClampedArray; width: number; height: number }) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (px.data[(y * px.width + x) * 4 + 3] > 128) {
        n++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { n, minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

const PROJECTIONS: Record<string, Record<string, unknown>> = {
  orthographic: { projection: 'orthographic', orthoSize: 3, rig: 'front', distance: 5 },
  perspective: { projection: 'perspective', fov: 40, rig: 'front', distance: 5 },
  fisheye: { projection: 'fisheye', fov: 180, rig: 'front', distance: 3 },
  panoramic: { projection: 'panoramic', rig: 'front', distance: 2.2 },
  cylindrical: { projection: 'cylindrical', fov: 60, rig: 'front', distance: 3 },
};

it('every projection renders the object, centred, on a transparent background', async () => {
  for (const [name, camera] of Object.entries(PROJECTIONS)) {
    const px = await render({ camera });
    const b = bounds(px);
    expect(b.n, name).toBeGreaterThan(60);
    expect(Math.abs(b.cx - W / 2), name).toBeLessThan(2.5);
    expect(Math.abs(b.cy - 32), name).toBeLessThan(2.5);
    expect(px.data[3], `${name} corner`).toBe(0);
    expect(px.data[((63 * W) + W - 1) * 4 + 3], `${name} corner`).toBe(0);
  }
});

it('panoramic wraps the object around the frame (wider and flatter than perspective)', async () => {
  const pan = bounds(await render({ camera: PROJECTIONS.panoramic }));
  const per = bounds(await render({ camera: { ...PROJECTIONS.perspective, distance: 3 } }));
  expect((pan.maxY - pan.minY) / (pan.maxX - pan.minX)).toBeGreaterThan(1.15); // not round: stretched by the 360x180 mapping
  expect(Math.abs((per.maxX - per.minX) - (per.maxY - per.minY))).toBeLessThan(3); // sphere stays round
  // camera looking away from the object: panorama still shows it, at the frame's left/right edges
  const away = { rig: 'free', posX: 0, posY: 0, posZ: -3, targetX: 0, targetY: 0, targetZ: -6 };
  const behind = bounds(await render({ camera: { ...PROJECTIONS.panoramic, ...away } }));
  expect(behind.n).toBeGreaterThan(30);
  expect(behind.minX < 6 || behind.maxX > W - 7).toBe(true);
  // a perspective camera looking away sees nothing
  expect(bounds(await render({ camera: { ...PROJECTIONS.perspective, ...away } })).n).toBe(0);
});

it('a wired camera overrides the built-in camera params', async () => {
  const t = await H();
  const a = await render({ camera: PROJECTIONS.perspective, object: { cameraType: 'orthographic', scale: 0.1, fov: 80, x: 0.9 } });
  const b = await render({ camera: PROJECTIONS.perspective, object: { cameraType: 'perspective', scale: 0.9, fov: 20, x: 0.1 } });
  expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  // ...and without a camera the built-in ones are used
  const c = await render({ object: { cameraType: 'orthographic', scale: 0.5 } });
  expect(bounds(c).n).toBeGreaterThan(60);
  void t;
});

it('object position/scale move and resize it in the scene', async () => {
  const base = bounds(await render({ camera: PROJECTIONS.orthographic }));
  const right = bounds(await render({ camera: PROJECTIONS.orthographic, object: { posX: 0.8 } }));
  const up = bounds(await render({ camera: PROJECTIONS.orthographic, object: { posY: 0.8 } }));
  const big = bounds(await render({ camera: PROJECTIONS.orthographic, object: { objectScale: 1.5 } }));
  expect(right.cx).toBeGreaterThan(base.cx + 5);
  expect(up.cy).toBeLessThan(base.cy - 5);
  expect(big.maxX - big.minX).toBeGreaterThan((base.maxX - base.minX) * 1.4);
});

it('lighting is fixed in the world, not on the camera', async () => {
  const front = await render({ camera: { ...PROJECTIONS.orthographic, azimuth: 0, rig: 'orbit', elevation: 0 }, object: { lightAzimuth: -80, lightElevation: 0, ambient: 0.05, specular: 0 } });
  const side = await render({ camera: { ...PROJECTIONS.orthographic, azimuth: 180, rig: 'orbit', elevation: 0 }, object: { lightAzimuth: -80, lightElevation: 0, ambient: 0.05, specular: 0 } });
  const at = (px: typeof front, x: number) => px.data[(32 * W + x) * 4];
  // light from -x (screen left when viewed from the front): front view is lit on the left, the back view on the right
  expect(at(front, W / 2 - 8)).toBeGreaterThan(at(front, W / 2 + 8) + 60);
  expect(at(side, W / 2 + 8)).toBeGreaterThan(at(side, W / 2 - 8) + 60);
});

it('camera motion loops exactly through the object render', async () => {
  const t = await H();
  const { graph, id } = await build({ camera: { motion: 'orbit', cycles: 1, projection: 'perspective' }, object: { shape: 'cube', rotY: 30 } });
  const grab = async (s: number) => Buffer.from((await t.pixels((await t.evalGraph(graph, id, { seconds: s })) as ImageValue)).data);
  const [a, mid, end] = [await grab(0), await grab(1), await grab(2)];
  let seam = 0, motion = 0;
  for (let i = 0; i < a.length; i++) { seam += Math.abs(a[i] - end[i]); motion += Math.abs(a[i] - mid[i]); }
  expect(seam / a.length).toBeLessThan(0.05);
  expect(motion / a.length).toBeGreaterThan(0.5);
});

it('two objects with their own cameras (perspective + panoramic) overlay through stack', async () => {
  const t = await H();
  const one = await build({ camera: { ...PROJECTIONS.perspective, distance: 7, shiftX: -0.4 }, object: { baseColor: [1, 0.2, 0.2, 1] } });
  const two = await build({ camera: { ...PROJECTIONS.panoramic, distance: 2.2 }, object: { shape: 'torus', baseColor: [0.2, 0.4, 1, 1] } }, one.graph);
  const s = addNode(two.graph, t.registry, 'stack', { x: 0, y: 0 }, { fit: 'stretch' });
  let g = connect(s.graph, t.registry, { node: one.id, port: 'image' }, { node: s.node.id, port: 'images' });
  g = connect(g, t.registry, { node: two.id, port: 'image' }, { node: s.node.id, port: 'images' });
  const px = await t.pixels((await t.evalGraph(g, s.node.id)) as ImageValue);
  let red = 0, blue = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    if (px.data[i + 3] > 200 && px.data[i] > 150 && px.data[i + 2] < 140) red++;
    if (px.data[i + 3] > 200 && px.data[i + 2] > px.data[i] + 40) blue++;
  }
  expect(red).toBeGreaterThan(40);
  expect(blue).toBeGreaterThan(25);
});
