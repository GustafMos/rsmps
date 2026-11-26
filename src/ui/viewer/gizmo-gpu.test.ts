/**
 * The handles' maths against really rendered pixels: where gizmoMath says an object is, the 3D nodes must draw it, and a move worked
 * out from a finger drag must carry the drawn object by exactly that many pixels. Renders 3D Object on the GPU.
 */
import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../engine/graph';
import { harness } from '../../engine/testing';
import type { CameraValue, GraphDoc, Host, ImageValue } from '../../engine/types';
import { textBytes, toObjText, uvSphereMesh } from '../../engine/lib/gen-model-testutil';
import { ballCloud } from '../../engine/lib/splat-gen';
import { putCloud, splatHost } from '../../engine/lib/splat-testutil';
import { cameraOf } from '../lib/xform3d';
import { dragDepth, dragMove, lensOf, projectPoint, screenRadius, turnRoll, turnTrackball, type Euler, type V3 } from './gizmoMath';

const files = new Map<string, ArrayBuffer>();
// one host for both kinds of file: models are read as bytes, splats the way the splat tests serve them
const host: Host = { ...splatHost(files), assetInfo: (id) => (files.has(id) ? { id, name: id, kind: id.endsWith('.obj') ? 'model' : 'splat', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null) } as Host;
let shared: ReturnType<typeof harness> | null = null;
const T = () => (shared ??= harness([], host));
const W = 256;
const H = 160;
const project = { width: W, height: H, fps: 10, duration: 2, loop: true };
// a small sphere: its outline's middle is then its centre's projection to well under a pixel, even off-axis
const OBJ = { shape: 'sphere', rotX: 0, rotY: 0, rotZ: 0, baseColor: [1, 1, 1, 1], objectScale: 0.3 };

async function scene(object: Record<string, unknown>, camera?: Record<string, unknown>) {
  const t = await T();
  let graph: GraphDoc = createGraph('t');
  graph.project = { ...graph.project, ...project };
  const o = addNode(graph, t.registry, 'object-3d', { x: 0, y: 0 }, { ...OBJ, ...object });
  graph = o.graph;
  let cam: CameraValue | null = null;
  if (camera) {
    const c = addNode(graph, t.registry, 'camera', { x: 0, y: 0 }, camera);
    graph = connect(c.graph, t.registry, { node: c.node.id, port: 'camera' }, { node: o.node.id, port: 'camera' });
    cam = (await t.evalGraph(graph, c.node.id, { seconds: 0 })) as unknown as CameraValue;
  }
  const params = graph.nodes.find((n) => n.id === o.node.id)!.params;
  const px = await t.pixels((await t.evalGraph(graph, o.node.id, { seconds: 0 })) as ImageValue);
  // the drawn object: alpha-weighted middle and its width
  let sx = 0, sy = 0, sa = 0, minX = 1e9, maxX = -1;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const a = px.data[(y * px.width + x) * 4 + 3] / 255;
      if (a <= 0) continue;
      sx += (x + 0.5) * a; sy += (y + 0.5) * a; sa += a;
      if (a > 0.5) { minX = Math.min(minX, x); maxX = Math.max(maxX, x + 1); }
    }
  }
  return { params, lens: lensOf(cameraOf(params, cam, W, H), W, H), drawn: { x: sx / sa, y: sy / sa, area: sa, width: maxX - minX } };
}

const CAMERAS: [string, Record<string, unknown>, Record<string, unknown> | undefined][] = [
  ['built-in perspective', { cameraType: 'perspective' }, undefined],
  // (kept moderate: a sphere far off the axis of a very wide lens is drawn as an ellipse whose middle is no longer its centre, and one that leaves the frame has no middle to measure)
  ['built-in perspective, off-centre frame, wider', { cameraType: 'perspective', fov: 45, x: 0.42, y: 0.55, scale: 0.6 }, undefined],
  ['built-in orthographic', { cameraType: 'orthographic', x: 0.6, y: 0.4 }, undefined],
  ['wired Camera, orbit, perspective, rolled and shifted', {}, { projection: 'perspective', rig: 'orbit', azimuth: 40, elevation: 25, distance: 5, roll: 20, fov: 50, shiftX: 0.1, shiftY: -0.05 }],
  ['wired Camera, free viewpoint, orthographic', {}, { projection: 'orthographic', rig: 'free', posX: 2, posY: 1.5, posZ: -4, targetX: 0.3, orthoSize: 4 }],
];

it('the handle sits where the object is drawn, and has its size', async () => {
  for (const [name, obj, cam] of CAMERAS) {
    for (const pos of [[0, 0, 0], [0.7, -0.4, 0.5], [-0.6, 0.3, -0.4]] as V3[]) {
      const s = await scene({ ...obj, posX: pos[0], posY: pos[1], posZ: pos[2] }, cam);
      const c = projectPoint(s.lens, pos);
      expect(c.visible, name).toBe(true);
      expect(Math.abs(c.x * W - s.drawn.x), `${name} x at ${pos}`).toBeLessThan(0.75);
      expect(Math.abs(c.y * H - s.drawn.y), `${name} y at ${pos}`).toBeLessThan(0.75);
      // the sphere has radius 0.95 x Object scale
      const r = screenRadius(s.lens, pos, 0.95 * 0.3) * Math.min(W, H);
      expect(Math.abs(2 * r - s.drawn.width), `${name} width at ${pos}`).toBeLessThan(2.5);
    }
  }
}, 120_000);

it('a finger drag of 60 px right and 25 px up moves the drawn object by 60 px right and 25 px up', async () => {
  for (const [name, obj, cam] of CAMERAS) {
    const p0: V3 = [0.2, -0.1, 0.3];
    const a = await scene({ ...obj, posX: p0[0], posY: p0[1], posZ: p0[2] }, cam);
    const c0 = projectPoint(a.lens, p0);
    const grab = { x: c0.x + 4 / W, y: c0.y + 3 / H }; // the finger is rarely dead centre
    const p1 = dragMove(a.lens, p0, grab, { x: grab.x + 60 / W, y: grab.y - 25 / H })!;
    const b = await scene({ ...obj, posX: p1[0], posY: p1[1], posZ: p1[2] }, cam);
    expect(b.drawn.x - a.drawn.x, `${name} dx`).toBeGreaterThan(59);
    expect(b.drawn.x - a.drawn.x, `${name} dx`).toBeLessThan(61);
    expect(b.drawn.y - a.drawn.y, `${name} dy`).toBeGreaterThan(-26);
    expect(b.drawn.y - a.drawn.y, `${name} dy`).toBeLessThan(-24);
    // same depth: it looks about the same size (a sphere moved off the axis of a perspective lens is drawn somewhat wider: that is the lens, not a change of distance)
    expect(b.drawn.width / a.drawn.width, `${name} width`).toBeGreaterThan(0.95);
    expect(b.drawn.width / a.drawn.width, `${name} width`).toBeLessThan(1.2);
  }
}, 120_000);

it('the depth handle makes the drawn object smaller or larger without sliding it away (perspective)', async () => {
  for (const [name, obj, cam] of CAMERAS.filter(([n]) => n.includes('perspective'))) {
    const p0: V3 = [0.4, 0.2, 0];
    const a = await scene({ ...obj, posX: p0[0], posY: p0[1], posZ: p0[2] }, cam);
    const far = dragDepth(a.lens, p0, 1.6);
    const b = await scene({ ...obj, posX: far[0], posY: far[1], posZ: far[2] }, cam);
    expect(Math.abs(b.drawn.x - a.drawn.x), `${name} x`).toBeLessThan(0.75);
    expect(Math.abs(b.drawn.y - a.drawn.y), `${name} y`).toBeLessThan(0.75);
    expect(b.drawn.width / a.drawn.width, `${name} size`).toBeGreaterThan(1 / 1.6 - 0.06);
    expect(b.drawn.width / a.drawn.width, `${name} size`).toBeLessThan(1 / 1.6 + 0.06);
  }
}, 120_000);

it('turning: the drawn object turns the way the finger moves (a cone, so its tip shows the direction)', async () => {
  // the middle of a cone's outline lies towards its base, away from the tip: the side the tip points to is the opposite one
  const tipSide = async (rot: Euler, cam?: Record<string, unknown>) => {
    const s = await scene({ shape: 'cone', objectScale: 1, cameraType: 'orthographic', rotX: rot[0], rotY: rot[1], rotZ: rot[2] }, cam);
    return { x: W / 2 - s.drawn.x, y: H / 2 - s.drawn.y, lens: s.lens }; // + = the tip points right / down on screen
  };
  // start with the tip pointing straight at the viewer: nothing to either side
  const start: Euler = [-90, 0, 0];
  const a = await tipSide(start);
  expect(Math.hypot(a.x, a.y)).toBeLessThan(0.5);
  const quarter = (100 * Math.PI) / 2; // a quarter turn on a handle of radius 100 px
  // drag right: the tip (the side facing you) swings to the right
  const right = await tipSide(turnTrackball(a.lens, start, quarter, 0, 100));
  expect(right.x).toBeGreaterThan(4);
  expect(Math.abs(right.y)).toBeLessThan(0.5);
  // drag up: the tip swings up
  const up = await tipSide(turnTrackball(a.lens, start, 0, -quarter, 100));
  expect(up.y).toBeLessThan(-4);
  expect(Math.abs(up.x)).toBeLessThan(0.5);
  // ring: from "tip up", a quarter turn counter-clockwise leaves the tip pointing left
  const upright = await tipSide([0, 0, 0]);
  expect(upright.y).toBeLessThan(-4);
  const rolled = await tipSide(turnRoll(a.lens, [0, 0, 0], Math.PI / 2));
  expect(rolled.x).toBeLessThan(-4);
  expect(Math.abs(rolled.y)).toBeLessThan(0.5);
}, 120_000);

it('the other members of the 3D family use the same transform: a 40 px drag moves what they draw by 40 px', async () => {
  const t = await T();
  // the rasterised members get a small file each: a sphere mesh and a ball of splats
  files.set('ball.obj', textBytes(toObjText(uvSphereMesh(16, 8, 1))));
  putCloud(files, 'ball', ballCloud(600));
  const extra: Record<string, Record<string, unknown>> = { 'model-3d': { model: ['ball.obj'] }, 'splat-3d': { file: ['ball'], orientation: 'asis' }, 'object-3d': { shape: 'custom', model: ['ball.obj'] } };
  for (const type of ['sdf-3d', 'image-to-3d', 'splat-3d', 'model-3d', 'object-3d']) {
    const draw = async (pos: V3) => {
      const out = await t.run(type, { cameraType: 'orthographic', rotX: 0, rotY: 0, rotZ: 0, posX: pos[0], posY: pos[1], posZ: pos[2], ...extra[type] }, type === 'image-to-3d' ? { image: t.checker(64, 64) } : {}, { project });
      const img = out.image as ImageValue | null;
      if (!img) return null;
      const px = await t.pixels(img);
      let sx = 0, sy = 0, sa = 0;
      for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) { const a = px.data[(y * px.width + x) * 4 + 3] / 255; sx += (x + 0.5) * a; sy += (y + 0.5) * a; sa += a; }
      return sa > 20 ? { x: sx / sa, y: sy / sa } : null;
    };
    const a = await draw([0, 0, 0]);
    expect(a, type).not.toBeNull();
    if (!a) continue;
    const def = t.registry.get(type)!;
    const params: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(def.params as Record<string, { default: unknown }>)) params[k] = p.default;
    const lens = lensOf(cameraOf({ ...params, cameraType: 'orthographic' }, null, W, H), W, H);
    const p1 = dragMove(lens, [0, 0, 0], { x: 0.5, y: 0.5 }, { x: 0.5 + 40 / W, y: 0.5 + 20 / H })!;
    const b = await draw(p1);
    expect(b, type).not.toBeNull();
    tested.push(type);
    expect(Math.abs(b!.x - a.x - 40), `${type} dx`).toBeLessThan(1);
    expect(Math.abs(b!.y - a.y - 20), `${type} dy`).toBeLessThan(1);
  }
  expect(tested).toEqual(['sdf-3d', 'image-to-3d', 'splat-3d', 'model-3d', 'object-3d']);
}, 120_000);
const tested: string[] = [];
