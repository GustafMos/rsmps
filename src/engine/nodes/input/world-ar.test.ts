import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';
import type { CameraValue, ImageValue } from '../../types';
import { cameraBasis } from '../../lib/gen-camera';
import { qAxisAngle, qMul, qNorm, type Quat, type Vec3 } from '../../lib/motion-math';
import { buildWorldTake, type WorldMoment, type WorldSample } from '../../lib/world-take';
import { lensFromFov, type Lens } from '../../lib/xr-math';

/* Plain matrix maths, written out here on purpose and sharing no code with xr-math.ts: this is what a WebXR page would do with the
   browser's own matrices. Column-major 4x4, column vectors. */
type M4 = number[];
const mul4 = (a: M4, b: M4): M4 => {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const apply4 = (m: M4, v: number[]): number[] => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
const translate = (t: Vec3): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
const scale = (s: Vec3): M4 => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
const rot = ([x, y, z, w]: Quat): M4 => [
  1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
  2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
  2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
  0, 0, 0, 1,
];
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** What `XRView.transform.inverse.matrix` is: the inverse of a rigid transform. */
const viewMatrixOf = (p: Vec3, q: Quat): M4 => mul4(rot(conj(q)), translate([-p[0], -p[1], -p[2]]));
/** What `XRView.projectionMatrix` is (OpenGL convention, looking along -z). */
const projectionOf = (l: Lens, near = 0.05, far = 100): M4 => [l[0], 0, 0, 0, 0, l[1], 0, 0, l[2], l[3], (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];

interface Setup {
  view: { p: Vec3; q: Quat };
  lens: Lens;
  object: { p: Vec3; q: Quat; scale: number };
  size: number;
  lift: number;
  /** Where the 3D Object is moved to inside the scene (scene units). */
  pos: Vec3;
  canvas: { width: number; height: number };
}

/** Pixel (x right, y down) where a scene point must appear, by the browser's matrices alone. */
function expectedPixel(s: Setup): [number, number] {
  const unit = (s.size / 2) * s.object.scale;
  // scene (z into the screen) -> the placement's frame (WebXR axes): flip z, lift, size; then the placement's pose in the room
  const model = mul4(translate(s.object.p), mul4(rot(s.object.q), mul4(scale([unit, unit, unit]), mul4(translate([0, s.lift, 0]), scale([1, 1, -1])))));
  const clip = apply4(mul4(projectionOf(s.lens), mul4(viewMatrixOf(s.view.p, s.view.q), model)), [s.pos[0], s.pos[1], s.pos[2], 1]);
  const ndc = [clip[0] / clip[3], clip[1] / clip[3]];
  return [((ndc[0] + 1) / 2) * s.canvas.width, ((1 - ndc[1]) / 2) * s.canvas.height];
}

/** A viewer at `p` looking at `at` with the top of the phone towards `up`, as a WebXR orientation (it looks along -z). */
function lookAt(p: Vec3, at: Vec3, up: Vec3 = [0, 1, 0]): Quat {
  const n = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const zc = n([p[0] - at[0], p[1] - at[1], p[2] - at[2]]); // the camera's +z points backwards
  const xc = n(cross(up, zc));
  const yc = cross(zc, xc);
  // rotation matrix with columns xc, yc, zc -> quaternion
  const m = [xc[0], yc[0], zc[0], xc[1], yc[1], zc[1], xc[2], yc[2], zc[2]];
  const tr = m[0] + m[4] + m[8];
  let q: Quat;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    q = [(m[7] - m[5]) / k, (m[2] - m[6]) / k, (m[3] - m[1]) / k, 0.25 * k];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const k = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [0.25 * k, (m[1] + m[3]) / k, (m[2] + m[6]) / k, (m[7] - m[5]) / k];
  } else if (m[4] > m[8]) {
    const k = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[1] + m[3]) / k, 0.25 * k, (m[5] + m[7]) / k, (m[2] - m[6]) / k];
  } else {
    const k = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[2] + m[6]) / k, (m[5] + m[7]) / k, 0.25 * k, (m[3] - m[1]) / k];
  }
  return qNorm(q);
}

const momentOf = (s: Setup): WorldMoment => ({ view: s.view, lens: s.lens, object: s.object });

async function renderCentroid(t: Awaited<ReturnType<typeof harness>>, s: Setup, extra: Record<string, unknown> = {}): Promise<{ x: number; y: number; mass: number }> {
  let g = createGraph('world-ar');
  const cam = addNode(g, t.registry, 'world-ar', { x: 0, y: 0 }, { live: momentOf(s), size: s.size, lift: s.lift, ...extra });
  g = cam.graph;
  // a small ball: its middle is where the scene point is, whatever the perspective
  const obj = addNode(g, t.registry, 'object-3d', { x: 0, y: 0 }, { shape: 'sphere', objectScale: 0.12, posX: s.pos[0], posY: s.pos[1], posZ: s.pos[2], rotX: 0, rotY: 0 });
  g = connect(obj.graph, t.registry, { node: cam.node.id, port: 'camera' }, { node: obj.node.id, port: 'camera' });
  const r = await t.engine.evaluate({ graph: g, node: obj.node.id, port: 'image', canvas: s.canvas });
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  const px = await t.pixels(r.value as ImageValue);
  expect(px.width).toBe(s.canvas.width);
  expect(px.height).toBe(s.canvas.height);
  let sx = 0;
  let sy = 0;
  let m = 0;
  for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
    const a = px.data[(y * px.width + x) * 4 + 3];
    sx += a * (x + 0.5);
    sy += a * (y + 0.5);
    m += a;
  }
  return { x: sx / Math.max(1, m), y: sy / Math.max(1, m), mass: m / 255 };
}

const PORTRAIT = { width: 180, height: 320 };
const LANDSCAPE = { width: 320, height: 180 };
const floor: Quat = [0, 0, 0, 1];

describe("world-ar: the 3D Object lands where the browser's own matrices put it (GPU)", () => {
  const eye: Vec3 = [0.3, 1.4, 1.6];
  const front = { p: [0, 0.25, 1.5] as Vec3, q: lookAt([0, 0.25, 1.5], [0, 0.25, 0]) };
  const base = { lens: lensFromFov(60, 9 / 16), object: { p: [0, 0, 0] as Vec3, q: floor, scale: 1 }, size: 0.5, lift: 1, canvas: PORTRAIT };
  const cases: [string, Setup][] = [
    ['looking straight at the object, portrait', { ...base, view: front, pos: [0, 0, 0] }],
    ["object moved to the scene's right (+x) appears right of the middle", { ...base, view: front, pos: [1.2, 0, 0] }],
    ['object moved up (+y)', { ...base, view: front, pos: [0, 1.5, 0] }],
    ['object moved away from the front (+z of the scene), seen from the side', { ...base, view: { p: [1.5, 0.4, 0.2], q: lookAt([1.5, 0.4, 0.2], [0, 0.2, 0]) }, pos: [0, 0, 2] }],
    ['standing, looking down at an object on the floor somewhere else in the room', { view: { p: eye, q: lookAt(eye, [-0.2, 0.1, -0.5]) }, lens: lensFromFov(62, 9 / 16), object: { p: [-0.4, 0.02, -0.7], q: qAxisAngle('y', 40), scale: 1.6 }, size: 0.3, lift: 1, pos: [0.5, 0.3, -0.8], canvas: PORTRAIT }],
    ['phone held sideways (landscape)', { view: { p: eye, q: lookAt(eye, [0, 0.3, 0]) }, lens: lensFromFov(38, 16 / 9), object: { p: [0.2, 0, -0.1], q: qAxisAngle('y', -70), scale: 0.8 }, size: 0.6, lift: 0, pos: [-0.6, 0.8, 0.4], canvas: LANDSCAPE }],
    ['phone rolled a quarter turn while the picture stays portrait', { ...base, view: { p: eye, q: lookAt(eye, [0, 0.3, 0], [1, 0, 0]) }, pos: [0.7, 0.2, 0.3] }],
    ['a lens whose centre is off the middle of the picture', { ...base, view: { p: eye, q: lookAt(eye, [0, 0.3, 0]) }, lens: [lensFromFov(60, 9 / 16)[0], lensFromFov(60, 9 / 16)[1], 0.12, -0.07], pos: [0.3, 0.4, -0.5] }],
    ['object on a wall (the surface normal is horizontal)', { ...base, view: { p: [0.4, 1.2, 1.8], q: lookAt([0.4, 1.2, 1.8], [0, 1.1, 0]) }, object: { p: [0, 1, 0], q: qMul(qAxisAngle('x', 90), qAxisAngle('y', 25)), scale: 1 }, size: 0.4, pos: [0.6, 0.5, 0.2] }],
    ['looking almost straight down', { ...base, view: { p: [0.05, 1.5, 0.1], q: lookAt([0.05, 1.5, 0.1], [0, 0, 0], [0, 0, -1]) }, lift: 0, pos: [0.4, 0, 0.6] }],
  ];
  for (const [name, s] of cases) {
    it(name, async () => {
      const t = await harness();
      const c = await renderCentroid(t, s);
      const [ex, ey] = expectedPixel(s);
      console.log(`${name}: rendered ${c.x.toFixed(2)}, ${c.y.toFixed(2)}  expected ${ex.toFixed(2)}, ${ey.toFixed(2)}  (${Math.round(c.mass)} px)`);
      expect(c.mass).toBeGreaterThan(20); // the ball is in the picture at all
      // a small ball's picture is centred on its middle to well under a pixel; 1.5 px leaves room for its slight perspective skew
      expect(Math.abs(c.x - ex)).toBeLessThan(1.5);
      expect(Math.abs(c.y - ey)).toBeLessThan(1.5);
    });
  }

  it('the cases really tell left from right and up from down (the expected points are far from the middle)', () => {
    const [ex, ey] = expectedPixel(cases[1][1]);
    expect(ex).toBeGreaterThan(PORTRAIT.width / 2 + 20);
    expect(expectedPixel(cases[2][1])[1]).toBeLessThan(ey - 20);
  });

  it('pinching bigger makes the ball bigger and keeps its place on the surface point', async () => {
    const t = await harness();
    const s: Setup = { ...base, view: { p: [0, 0.6, 2], q: lookAt([0, 0.6, 2], [0, 0.2, 0]) }, lift: 0, pos: [0, 0, 0] };
    const a = await renderCentroid(t, s);
    const b = await renderCentroid(t, { ...s, object: { ...s.object, scale: 2 } });
    expect(b.mass / a.mass).toBeGreaterThan(3.3); // twice the size = four times the area
    expect(b.mass / a.mass).toBeLessThan(4.7);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  });
});

describe('world-ar: sources', () => {
  const run = async (params: Record<string, unknown>, seconds = 0, canvas = PORTRAIT) => {
    const t = await harness();
    const n = addNode(createGraph('w'), t.registry, 'world-ar', { x: 0, y: 0 }, params);
    const r = await t.engine.evaluate({ graph: n.graph, node: n.node.id, port: 'camera', seconds, canvas });
    if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
    return r.value as unknown as CameraValue;
  };
  it('nothing to follow: an ordinary camera looking at the object, so it can be designed in the viewer', async () => {
    const cam = await run({});
    expect(cam.projection).toBe('perspective');
    expect(cameraBasis(cam).forward[2]).toBeGreaterThan(0.9);
    expect(cam.position[2]).toBeLessThan(-1);
  });
  it('tracked but nothing placed: the object is out of sight', async () => {
    const cam = await run({ live: { view: { p: [0, 1, 0], q: [0, 0, 0, 1] }, lens: lensFromFov(60, 0.56), object: null } });
    expect(Math.hypot(...cam.position)).toBeGreaterThan(1e5);
  });
  it('a recorded take plays by the clock, and the live pose wins over it while the AR view is open', async () => {
    const lens = lensFromFov(60, 9 / 16);
    const samples: WorldSample[] = [];
    for (let i = 0; i <= 30; i++) samples.push({ t: i / 30, frame: i, view: { p: [i / 30, 1, 2], q: [0, 0, 0, 1] }, lens, object: { p: [0, 0, 0], q: [0, 0, 0, 1], scale: 1 } });
    const take = buildWorldTake(samples, { fps: 30 })!;
    const project = { fps: 30 };
    void project;
    const at0 = await run({ take, size: 2, lift: 0 }, 0);
    const at1 = await run({ take, size: 2, lift: 0 }, 1);
    // size 2 m = 1 m per scene unit: the camera walked 1 m to the right, 2 m in front of the object (scene -z)
    expect(at0.position[0]).toBeCloseTo(0, 3);
    expect(at1.position[0]).toBeCloseTo(1, 3);
    expect(at1.position[1]).toBeCloseTo(1, 3);
    expect(at1.position[2]).toBeCloseTo(-2, 3);
    const shifted = await run({ take, size: 2, lift: 0, startAt: 0.5 }, 1);
    expect(shifted.position[0]).toBeCloseTo(0.5, 3);
    const live = await run({ take, size: 2, lift: 0, live: { view: { p: [5, 1, 2], q: [0, 0, 0, 1] }, lens, object: { p: [0, 0, 0], q: [0, 0, 0, 1], scale: 1 } } }, 0);
    expect(live.position[0]).toBeCloseTo(5, 5);
  });
  it('a broken take or live value is ignored, not an error', async () => {
    const cam = await run({ take: { v: 1, kind: 'something-else' }, live: 'nonsense' });
    expect(cam.position[2]).toBeLessThan(-1);
  });
});
