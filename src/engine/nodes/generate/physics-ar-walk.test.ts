import { describe, expect, it } from 'vitest';
import { createGraph } from '../../graph';
import { cameraBasis } from '../../lib/gen-camera';
import { qAxisAngle, type Quat, type Vec3 } from '../../lib/motion-math';
import { clearRuns, runsStarted } from '../../lib/physics/sim';
import { buildWorldTake, type WorldMoment, type WorldSample } from '../../lib/world-take';
import { lensFromFov } from '../../lib/xr-math';
import { harness } from '../../testing';
import type { CameraValue, GraphDoc, ImageValue, MotionValue } from '../../types';

/**
 * A phone walking around a physics-driven object in the World AR view, frame by frame the way the AR loop asks the engine: every frame
 * stamps the phone's pose (and a little tracking jitter on the placed object) into the World AR Camera and asks for the picture at
 * the project clock (real time, wrapped at the project length; the AR view also hands over the live physics clock). The object must
 * stay where it is in the room: its centre on screen is the projection of its real place with the CURRENT camera, the same as an
 * object wired straight to the camera, and the run must not start over.
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 300_000 };
const SIZE = { width: 180, height: 320 };
const FPS = 30;
const DUR = 4;
const proj = { ...SIZE, fps: FPS, loop: true, duration: DUR };

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
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lookAt = (p: Vec3, at: Vec3): Quat => {
  const zc = norm([p[0] - at[0], p[1] - at[1], p[2] - at[2]]);
  const xc = norm(cross([0, 1, 0], zc));
  const yc = cross(zc, xc);
  const m = [xc[0], yc[0], zc[0], xc[1], yc[1], zc[1], xc[2], yc[2], zc[2]];
  const k = Math.sqrt(Math.max(1e-9, 1 + m[0] + m[4] + m[8])) * 2;
  const q: Quat = [(m[7] - m[5]) / k, (m[2] - m[6]) / k, (m[3] - m[1]) / k, 0.25 * k];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/** The phone at real time `t`: walks round the object while the tracker wobbles the anchor by millimetres and degrees. */
const moment = (t: number, live: boolean): WorldMoment => {
  const a = -0.9 + t * 0.3;
  const p: Vec3 = [1.7 * Math.sin(a), 0.5, 1.7 * Math.cos(a)];
  return {
    view: { p, q: lookAt(p, [0, 0.1, 0]) },
    lens: lensFromFov(55, SIZE.width / SIZE.height),
    object: { p: [0.004 * Math.sin(t * 7), 0, 0.004 * Math.cos(t * 5)], q: qAxisAngle('y', ((2 * Math.PI) / 180) * Math.sin(t * 3)), scale: 1 },
    ...(live ? { physics: t } : {}),
  };
};
const AR = (m: WorldMoment): N => ['ar', 'world-ar', { live: m, size: 0.5, lift: 1 }];
const view = { shape: 'sphere', cameraType: 'perspective', ambient: 1, specular: 0, ao: 0, objectScale: 0.5 };
const R = 0.95;
const GROUND = -1;
const REST_Y = GROUND + R;

function toPixel(cam: CameraValue, p: Vec3): [number, number] {
  const b = cameraBasis(cam);
  const rel = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const d = (a: readonly number[]) => rel[0] * a[0] + rel[1] * a[1] + rel[2] * a[2];
  const z = d(b.forward);
  const short = Math.min(SIZE.width, SIZE.height);
  const fovTan = Math.tan((cam.fov * Math.PI) / 360);
  return [SIZE.width / 2 + ((d(b.right) / z / fovTan) * short) / 2, SIZE.height / 2 - ((d(b.up) / z / fovTan) * short) / 2];
}
function centre(px: { width: number; height: number; data: ArrayLike<number> }) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (px.data[(y * px.width + x) * 4 + 3] > 128) {
        n++;
        sx += x;
        sy += y;
      }
  return { n, x: sx / Math.max(1, n), y: sy / Math.max(1, n) };
}

describe('walking round a physics object in the AR view', () => {
  it('stays on its real place on screen, equal to the same object wired straight to the camera, with no restart', T, async () => {
    clearRuns();
    const t = await H();
    const ball = [{ shape: 'sphere', size: [R, 1, 1], pos: [0, 1.5, 0], bounce: 0 }];
    const withPhysics = (m: WorldMoment) => mk([AR(m), ['p', 'physics', { bodies: ball, floor: 'auto' }], ['o', 'object-3d', view]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
    // direct: no physics at all, the object stands at the resting place
    const direct = (m: WorldMoment) => mk([AR(m), ['o', 'object-3d', { ...view, posY: REST_Y }]], [['ar', 'camera', 'o', 'camera']]);
    const started0 = runsStarted();
    let worst = 0;
    let worstDirect = 0;
    let worstAt = 0;
    const lines: string[] = [];
    const walk = 7.5; // seconds: crosses the 4 s project length
    for (let i = 0; i < walk * FPS; i += 3) {
      const real = i / FPS;
      const m = moment(real, true);
      const secs = real % DUR; // what the AR loop passes as the project clock
      const cam = (await t.evalGraph(withPhysics(m), 'ar', { seconds: secs, port: 'camera' })) as CameraValue;
      const a = centre(await t.pixels((await t.evalGraph(withPhysics(m), 'o', { seconds: secs, port: 'image' })) as ImageValue));
      if (real < 2.2) continue; // the fall is over after about 1.5 s
      const b = centre(await t.pixels((await t.evalGraph(direct(m), 'o', { seconds: secs, port: 'image' })) as ImageValue));
      const [sx, sy] = toPixel(cam, [0, REST_Y, 0]);
      const err = Math.hypot(a.x - sx, a.y - sy);
      const errDirect = Math.hypot(b.x - sx, b.y - sy);
      if (err > worst) [worst, worstAt] = [err, real];
      worstDirect = Math.max(worstDirect, errDirect);
      if (i % 15 === 0) lines.push(`t=${real.toFixed(1)}s physics err ${err.toFixed(2)} px, direct err ${errDirect.toFixed(2)} px`);
    }
    console.log(lines.join('\n'), `\nworst physics ${worst.toFixed(2)} px (at ${worstAt.toFixed(1)} s), worst direct ${worstDirect.toFixed(2)} px, runs started ${runsStarted() - started0}`);
    expect(worstDirect).toBeLessThan(1.5);
    expect(worst).toBeLessThan(1.5);
    expect(runsStarted() - started0).toBe(1);
  });

  it('the camera the object is drawn with is the current one (no lag through Physics)', T, async () => {
    clearRuns();
    const t = await H();
    const ball = [{ shape: 'sphere', size: [R, 1, 1], pos: [0, REST_Y, 0], bounce: 0 }];
    for (let i = 0; i < 20; i++) {
      const m = moment(i / FPS, true);
      const g = mk([AR(m), ['p', 'physics', { bodies: ball, floor: 'auto' }], ['o', 'object-3d', view]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
      const cam = (await t.evalGraph(g, 'ar', { seconds: i / FPS, port: 'camera' })) as CameraValue;
      const mv = (await t.evalGraph(g, 'p', { seconds: i / FPS, port: 'motion1' })) as MotionValue;
      expect(mv.camera?.position).toEqual(cam.position);
    }
  });
});

describe('Height and the floor in the AR view', () => {
  const ball = [{ shape: 'sphere', size: [R, 1, 1], pos: [0, 1.5, 0], bounce: 0 }];
  /** Where the ball's bottom rests in the room, metres up from the surface it was placed on (the real surface is the placed point). */
  async function restBottom(floor: Record<string, unknown>, h: number): Promise<number> {
    const t = await H();
    const m: WorldMoment = { ...moment(0, true), object: { p: [0, h, 0], q: [0, 0, 0, 1], scale: 1, ...(h ? { h } : {}) }, physics: 5 };
    const g = mk([AR(m), ['p', 'physics', { bodies: ball, ...floor }], ['o', 'object-3d', view]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
    const mv = (await t.evalGraph(g, 'p', { seconds: 1, port: 'motion1' })) as MotionValue;
    const unit = 0.25; // Object size 0.5 m: one scene unit is 0.25 m
    // the object frame's origin is the lifted point (raised by h); the ball's bottom is (rest height - radius) scene units from it
    return h + (mv.pos[1] - R) * unit;
  }

  it('Automatic and an old project: the bodies rest on the placed surface whatever the Height is', T, async () => {
    clearRuns();
    const a = [await restBottom({ floor: 'auto' }, 0), await restBottom({ floor: 'auto' }, 0.2), await restBottom({ floor: 'auto' }, 0.5)];
    const o = [await restBottom({ floor: 'old' }, 0), await restBottom({ floor: 'old' }, 0.2), await restBottom({ floor: 'old' }, 0.5)];
    // an old project (no Floor setting stored, or Floor on) reads as the old fixed height
    const legacy = [await restBottom({ floor: true }, 0), await restBottom({}, 0.2), await restBottom({ floor: true }, 0.5)];
    console.log('rest bottom (m above placed point), Height 0 / 0.2 / 0.5:', 'auto', a.map((v) => v.toFixed(3)), 'old project', o.map((v) => v.toFixed(3)), 'legacy forms', legacy.map((v) => v.toFixed(3)));
    for (const r of [a, o, legacy]) for (const v of r) expect(v).toBeCloseTo(-0.25, 3);
  });

  it('an explicit Custom height stays a fixed height in the object frame (it rises with Height: the old bug, now opt-in)', T, async () => {
    clearRuns();
    const low = await restBottom({ floor: 'custom', floorHeight: -1 }, 0);
    const high = await restBottom({ floor: 'custom', floorHeight: -1 }, 0.5);
    // the frame itself is what rises: the floor goes up by exactly the Height, the real surface does not
    expect(high - low).toBeCloseTo(0.5, 3);
  });

  it('a take recorded with live physics replays the same fall, restart included', T, async () => {
    clearRuns();
    const t = await H();
    const samples: WorldSample[] = [];
    const clockAt = (i: number) => (i < 60 ? i / FPS : (i - 60) / FPS); // restarted after 2 s
    for (let i = 0; i < 120; i++) samples.push({ t: i / FPS, ...moment(i / FPS, true), physics: clockAt(i) });
    const take = buildWorldTake(samples, { fps: FPS })!;
    const live = async (clock: number) => {
      const g = mk([AR({ ...moment(0, true), physics: clock }), ['p', 'physics', { bodies: ball, floor: 'auto' }], ['o', 'object-3d', view]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
      return ((await t.evalGraph(g, 'p', { seconds: 0, port: 'motion1' })) as MotionValue).pos[1];
    };
    const replay = async (i: number) => {
      const g = mk([['ar', 'world-ar', { take, size: 0.5, lift: 1 }], ['p', 'physics', { bodies: ball, floor: 'auto' }], ['o', 'object-3d', view]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]);
      return ((await t.evalGraph(g, 'p', { seconds: i / FPS, port: 'motion1' })) as MotionValue).pos[1];
    };
    for (const i of [5, 12, 20, 45, 61, 66, 75, 100]) {
      const want = await live(clockAt(i));
      expect(Math.abs((await replay(i)) - want)).toBeLessThan(0.02);
    }
    // the fall really is in the take: high at the restart, low before it
    expect(await replay(60)).toBeGreaterThan(1.4);
    expect(await replay(59)).toBeLessThan(-0.04);
  });

  it('cost per frame: eight bodies, the run advanced', T, async () => {
    clearRuns();
    const t = await H();
    const many = Array.from({ length: 8 }, (_, i) => ({ shape: i % 2 ? 'box' : 'sphere', size: [0.4, 0.4, 0.4], pos: [(i % 4) * 0.8 - 1.2, 1 + Math.floor(i / 4), 0], bounce: 0.2 }));
    const mkG = (m: WorldMoment, withPhysics: boolean) =>
      withPhysics ? mk([AR(m), ['p', 'physics', { bodies: many, floor: 'auto' }], ['o', 'object-3d', view]], [['ar', 'camera', 'p', 'camera'], ['p', 'motion1', 'o', 'xform@motion']]) : mk([AR(m), ['o', 'object-3d', view]], [['ar', 'camera', 'o', 'camera']]);
    const time = async (withPhysics: boolean) => {
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) await t.evalGraph(mkG(moment(3 + i / FPS, true), withPhysics), 'o', { seconds: (3 + i / FPS) % DUR, port: 'image' });
      return (performance.now() - t0) / 60;
    };
    await time(true); // warm up: runs the first 3 s of the simulation
    const a = await time(false);
    const b = await time(true);
    console.log(`per frame: ${a.toFixed(1)} ms without physics, ${b.toFixed(1)} ms with 8 bodies (run already advanced), difference ${(b - a).toFixed(1)} ms`);
    expect(b - a).toBeLessThan(15);
  });
});

