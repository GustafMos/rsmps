import { describe, expect, it } from 'vitest';
import { createGraph } from '../../graph';
import { cameraBasis } from '../../lib/gen-camera';
import { qAxisAngle, type Quat, type Vec3 } from '../../lib/motion-math';
import { clearRuns, runCount } from '../../lib/physics/sim';
import type { WorldMoment } from '../../lib/world-take';
import { lensFromFov } from '../../lib/xr-math';
import { harness } from '../../testing';
import type { CameraValue, GraphDoc, ImageValue, MotionValue } from '../../types';

/**
 * A camera wired into Physics reaches the objects Physics moves; Floor "Automatic" is the camera's real floor; and with the World AR
 * Camera in the owner's wiring (AR camera -> Physics -> 3D Object, nothing else) a falling ball lands ON the placed surface, at the tapped spot.
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 180_000 };
const SIZE = { width: 180, height: 320 };
const proj = { ...SIZE, fps: 30, loop: false, duration: 10 };

type N = [id: string, type: string, params?: Record<string, unknown>];
type E = [from: string, fromPort: string, to: string, toPort: string];
const mk = (nodes: N[], edges: E[]): GraphDoc => {
  const g = createGraph('t');
  return {
    ...g,
    project: { ...g.project, ...proj },
    nodes: nodes.map(([id, type, params], i) => ({ id, type, x: i * 100, y: 0, params: params ?? {} })),
    edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
  };
};

const lookAt = (p: Vec3, at: Vec3): Quat => {
  const n = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const zc = n([p[0] - at[0], p[1] - at[1], p[2] - at[2]]);
  const xc = n(cross([0, 1, 0], zc));
  const yc = cross(zc, xc);
  const m = [xc[0], yc[0], zc[0], xc[1], yc[1], zc[1], xc[2], yc[2], zc[2]];
  const k = Math.sqrt(Math.max(1e-9, 1 + m[0] + m[4] + m[8])) * 2;
  const q: Quat = [(m[7] - m[5]) / k, (m[2] - m[6]) / k, (m[3] - m[1]) / k, 0.25 * k];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

const moment = (o: { yaw?: number; h?: number } = {}): WorldMoment => ({
  view: { p: [0.2, 0.5, 1.6], q: lookAt([0.2, 0.5, 1.6], [0, 0.1, 0]) },
  lens: lensFromFov(55, SIZE.width / SIZE.height),
  object: { p: [0, o.h ?? 0, 0], q: qAxisAngle('y', o.yaw ?? 0), scale: 1, ...(o.h ? { h: o.h } : {}) },
});
const AR = (o: { yaw?: number; h?: number; lift?: number } = {}): N => ['ar', 'world-ar', { live: moment(o), size: 0.5, lift: o.lift ?? 1 }];
const ball = (y: number, x = 0) => [{ shape: 'sphere', size: [0.95, 1, 1], pos: [x, y, 0], bounce: 0 }];
const view = { shape: 'sphere', cameraType: 'perspective', ambient: 1, specular: 0, ao: 0 };

function toPixel(cam: CameraValue, p: Vec3): [number, number] {
  const b = cameraBasis(cam);
  const rel = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const d = (a: readonly number[]) => rel[0] * a[0] + rel[1] * a[1] + rel[2] * a[2];
  const z = d(b.forward);
  const short = Math.min(SIZE.width, SIZE.height);
  const fovTan = Math.tan((cam.fov * Math.PI) / 360);
  return [SIZE.width / 2 + ((d(b.right) / z / fovTan + cam.shift[0] * 2) * short) / 2, SIZE.height / 2 - ((d(b.up) / z / fovTan + cam.shift[1] * 2) * short) / 2];
}

async function image(t: Awaited<ReturnType<typeof harness>>, g: GraphDoc, seconds: number) {
  return t.pixels((await t.evalGraph(g, 'o', { seconds, port: 'image' })) as ImageValue);
}
const same = (a: { data: ArrayLike<number> }, b: { data: ArrayLike<number> }) => {
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) diff = Math.max(diff, Math.abs(a.data[i] - b.data[i]));
  return diff;
};
function extent(px: { width: number; height: number; data: ArrayLike<number> }) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let bottom = -1;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (px.data[(y * px.width + x) * 4 + 3] > 128) {
        n++;
        sx += x;
        sy += y;
        bottom = y;
      }
  return { n, x: sx / Math.max(1, n), y: sy / Math.max(1, n), bottom };
}

describe('a camera on the Motion wire (engine)', () => {
  const owner = (extra: E[] = []) =>
    mk([AR(), ['p', 'physics', { bodies: ball(1.5), floor: 'auto' }], ['o', 'object-3d', { ...view, objectScale: 0.5 }]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion'], ...extra]);

  it('the object draws exactly as if the camera were wired into it too', T, async () => {
    clearRuns();
    const t = await H();
    const direct = owner([['ar', 'camera', 'o', 'camera']]);
    for (const s of [0, 0.4, 3]) {
      const a = await image(t, owner(), s);
      const b = await image(t, direct, s);
      expect(same(a, b)).toBe(0);
      expect(extent(a).n).toBeGreaterThan(100);
    }
    // the built-in camera looks different, so the test tells them apart
    const none = mk([['p', 'physics', { bodies: ball(1.5), floor: 'auto' }], ['o', 'object-3d', { ...view, objectScale: 0.5 }]], [['p', 'motion1', 'o', 'xform@motion']]);
    expect(same(await image(t, owner(), 3), await image(t, none, 3))).toBeGreaterThan(20);
  });

  it("the object's own Camera wire wins", T, async () => {
    clearRuns();
    const t = await H();
    const other: N = ['ar2', 'world-ar', { live: moment({ yaw: 70 }), size: 0.8, lift: 0.5 }];
    const base: N[] = [AR(), other, ['p', 'physics', { bodies: ball(1.5), floor: 'auto' }], ['o', 'object-3d', { ...view, objectScale: 0.5 }]];
    const own = mk(base, [['ar', 'camera', 'p', 'camera'], ['ar2', 'camera', 'o', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
    const ownOnly = mk(base, [['ar2', 'camera', 'o', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
    expect(same(await image(t, own, 1), await image(t, ownOnly, 1))).toBe(0);
  });

  it('re-renders when the forwarded camera changes', T, async () => {
    clearRuns();
    const t = await H();
    const at = (yaw: number) => mk([AR({ yaw }), ['p', 'physics', { bodies: ball(1.5, 0.6), floor: 'auto' }], ['o', 'object-3d', { ...view, objectScale: 0.5 }]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
    const a = await image(t, at(0), 2);
    const b = await image(t, at(50), 2);
    const a2 = await image(t, at(0), 2);
    expect(same(a, b)).toBeGreaterThan(5);
    expect(same(a, a2)).toBe(0);
  });

  it('a node without a camera input ignores it', T, async () => {
    clearRuns();
    const t = await H();
    const g = mk([AR(), ['p', 'physics', { bodies: ball(1.5), floor: 'auto' }], ['s', 'sdf-shape', { shape: 'sphere', radius: 0.5 }], ['r', 'sdf-render', {}]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 's', 'xform@motion'], ['s', 'sdf', 'r', 'scene']]);
    const m = (await t.evalGraph(g, 'p', { seconds: 1, port: 'motion1' })) as MotionValue;
    expect(m.camera?.kind).toBe('camera');
    const img = (await t.evalGraph(g, 'r', { seconds: 1, port: 'image' })) as ImageValue;
    expect(img).toBeTruthy();
  });
});

describe('Physics floor: Automatic', () => {
  const cam = (ground?: number): CameraValue => ({ kind: 'camera', projection: 'perspective', fov: 50, orthoSize: 4, position: [0, 0, -5], target: [0, 0, 0], roll: 0, shift: [0, 0], ...(ground === undefined ? {} : { ground }) });
  const rest = async (floor: Record<string, unknown>, c?: CameraValue) => {
    const t = await H();
    const out = await t.run('physics', { bodies: ball(3), ...floor }, (c ? { camera: c } : {}) as never, { seconds: 4, project: proj });
    return (out.pos1 as number[])[1];
  };
  it('lands on the camera floor, else on -1; Custom height and Off keep their meaning', T, async () => {
    clearRuns();
    expect(await rest({}, cam(-1.8))).toBeCloseTo(-1.8 + 0.95, 1);
    expect(await rest({}, cam())).toBeCloseTo(-1 + 0.95, 1);
    expect(await rest({})).toBeCloseTo(-1 + 0.95, 1);
    expect(await rest({ floor: 'custom', floorHeight: -0.5 }, cam(-1.8))).toBeCloseTo(-0.5 + 0.95, 1);
    expect(await rest({ floor: 'off' }, cam(-1.8))).toBeLessThan(-3);
  });
  it('old projects: Floor on with a number keeps its height without a real floor and follows the camera that knows one; Floor off is Off', T, async () => {
    clearRuns();
    expect(await rest({ floor: true, floorHeight: -0.25 })).toBeCloseTo(-0.25 + 0.95, 1);
    expect(await rest({ floor: true, floorHeight: -0.25 }, cam())).toBeCloseTo(-0.25 + 0.95, 1);
    expect(await rest({ floor: true, floorHeight: -0.25 }, cam(-1.8))).toBeCloseTo(-1.8 + 0.95, 1);
    expect(await rest({ floorHeight: -0.25 }, cam(-1.8))).toBeCloseTo(-1.8 + 0.95, 1);
    expect(await rest({ floor: false }, cam(-1.8))).toBeLessThan(-3);
  });
  it('noise under 1 mm does not start the run again; a real change does', T, async () => {
    clearRuns();
    const t = await H();
    const at = (g: number) => t.run('physics', { bodies: ball(3) }, { camera: cam(g) } as never, { seconds: 1, project: proj });
    await at(-1.8);
    const n = runCount();
    await at(-1.8 + 0.0002);
    await at(-1.8 - 0.0003);
    expect(runCount()).toBe(n);
    await at(-1.7);
    expect(runCount()).toBe(n + 1);
  });
});

describe('World AR numbers (owner wiring: AR camera -> Physics -> 3D Object)', () => {
  for (const [name, o] of [
    ['placed flat, Lift 1', {}],
    ['placed and turned 40 degrees', { yaw: 40 }],
    ['raised 0.2 m, Lift 1', { h: 0.2 }],
    ['Lift 0.5', { lift: 0.5 }],
  ] as [string, { yaw?: number; h?: number; lift?: number }][]) {
    it(`a falling ball rests on the placed surface and stands at the tapped spot: ${name}`, T, async () => {
      clearRuns();
      const t = await H();
      const lift = o.lift ?? 1;
      const g = mk([AR(o), ['p', 'physics', { bodies: ball(1.5), floor: 'auto' }], ['o', 'object-3d', { ...view, objectScale: 1 }]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
      const cam = (await t.evalGraph(g, 'ar', { seconds: 4, port: 'camera' })) as CameraValue;
      const ground = -lift - (o.h ?? 0) / 0.25;
      expect(cam.ground).toBeCloseTo(ground, 6);
      const m = (await t.evalGraph(g, 'p', { seconds: 4, port: 'motion1' })) as MotionValue;
      // the ball's bottom on the plane: centre = ground + radius
      expect(m.pos[1] - 0.95).toBeCloseTo(ground, 2);
      expect(Math.abs(m.pos[0]) + Math.abs(m.pos[2])).toBeLessThan(0.02);
      const start = (await t.evalGraph(g, 'p', { seconds: 0, port: 'motion1' })) as MotionValue;
      expect(start.pos[1]).toBeCloseTo(1.5, 3);
      // on screen: lowest pixel of the ball on the plane point below it, middle of the ball above the tapped spot
      const e = extent(await image(t, g, 4));
      const [sx, sy] = toPixel(cam, [0, ground, 0]);
      const [cx] = toPixel(cam, [0, m.pos[1], 0]);
      console.log(`${name}: rest centre y ${m.pos[1].toFixed(3)} (surface ${ground.toFixed(3)} + 0.95); bottom row ${e.bottom} vs plane point row ${sy.toFixed(1)}; ball x ${e.x.toFixed(1)} vs spot x ${sx.toFixed(1)}`);
      expect(e.n).toBeGreaterThan(200);
      expect(Math.abs(e.bottom + 0.5 - sy)).toBeLessThan(4);
      expect(Math.abs(e.x - cx)).toBeLessThan(2.5);
      expect(Math.abs(e.x - sx)).toBeLessThan(5);
    });
  }

  it('Ground shadow: the shadow meets the ball where it rests', T, async () => {
    clearRuns();
    const t = await H();
    const mkG = (shadow: boolean) => mk([AR(), ['p', 'physics', { bodies: ball(1.5), floor: 'auto' }], ['o', 'object-3d', { ...view, objectScale: 1, groundShadow: shadow }]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
    const a = await image(t, mkG(false), 4);
    const b = await image(t, mkG(true), 4);
    const e = extent(a);
    let low = -1;
    let n = 0;
    for (let y = 0; y < SIZE.height; y++)
      for (let x = 0; x < SIZE.width; x++) {
        const o = (y * SIZE.width + x) * 4;
        if (Math.abs(a.data[o + 3] - b.data[o + 3]) > 20) {
          n++;
          low = Math.max(low, y);
        }
      }
    console.log(`shadow pixels ${n}, lowest row ${low}, ball bottom ${e.bottom}`);
    expect(n).toBeGreaterThan(30);
    // the shadow lies on the plane the ball rests on: it reaches down to the ball's bottom and just below it
    expect(low).toBeGreaterThanOrEqual(e.bottom - 2);
    expect(low).toBeLessThan(e.bottom + 12);
  });
});
