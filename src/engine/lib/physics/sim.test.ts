import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotationZYX } from '../gen-common';
import { loadRapier, makeRapierBackend } from './rapier';
import { eulerFromQuat, matrixFromQuat, quatFromEuler, type Quat } from './rotation';
import { DEFAULT_BODY, clearRuns, getRun, noInputs, normalizeBodies, runSignature, type SimRun } from './sim';
import type { BodySpec, FrameInputs, PhysBackend, WorldSpec } from './types';

let backend: PhysBackend;
beforeAll(async () => {
  backend = makeRapierBackend(await loadRapier());
}, 60_000);
afterAll(() => clearRuns());

const world = (o: Partial<WorldSpec> = {}): WorldSpec => ({
  gravity: [0, -9.81, 0],
  floor: true,
  floorHeight: 0,
  floorBounce: 0,
  floorFriction: 0.6,
  walls: false,
  damping: 0,
  roomWidth: 8,
  roomDepth: 8,
  timeScale: 1,
  substeps: 1,
  fps: 60,
  ...o,
});
const body = (o: Partial<BodySpec> = {}): BodySpec => ({ ...DEFAULT_BODY, ...o });
let counter = 0;
/** a fresh run (a unique signature so nothing is shared between tests unless the test asks for it) */
const run = (bodies: BodySpec[], w: WorldSpec, tag = `t${counter++}`): SimRun => getRun(runSignature(bodies, w, tag), bodies, w, backend, 0);
const none = (n: number) => () => noInputs(n);

describe('rotation round trip', () => {
  it('quaternion -> Euler reproduces the matrix of the 3D nodes', () => {
    const cases: [number, number, number][] = [[10, 20, 30], [-170, 45, 120], [90, -30, 5], [0, 0, 0], [33, 89, -40], [200, -60, 310]];
    for (const [x, y, z] of cases) {
      const q = quatFromEuler(x, y, z);
      const e = eulerFromQuat(q);
      const a = rotationZYX(e[0], e[1], e[2]);
      const b = rotationZYX(x, y, z);
      const c = matrixFromQuat(q);
      for (let i = 0; i < 9; i++) {
        expect(a[i]).toBeCloseTo(b[i], 6);
        expect(c[i]).toBeCloseTo(b[i], 6);
      }
    }
  });
  it('gimbal lock still gives the same matrix', () => {
    const q = quatFromEuler(40, 90, 25);
    const e = eulerFromQuat(q);
    const a = rotationZYX(e[0], e[1], e[2]);
    const b = matrixFromQuat(q);
    for (let i = 0; i < 9; i++) expect(a[i]).toBeCloseTo(b[i], 5);
  });
});

describe('physics run', () => {
  it('a dropped sphere lands on the floor at the expected time and rests on it', async () => {
    const h = 5;
    const r = run([body({ pos: [0, h, 0], size: [0.5, 1, 1], bounce: 0 })], world());
    await r.ensure(240, none(1));
    const R = 0.5;
    // the centre starts at h; it touches when the centre is at R: fall of (h - R)
    const tHit = Math.sqrt((2 * (h - R)) / 9.81);
    let first = -1;
    for (let k = 0; k <= 240; k++) if (r.body(k, 0)!.pos[1] <= R + 0.02) { first = k; break; }
    expect(Math.abs(first / 60 - tHit)).toBeLessThan(2 / 60);
    const end = r.body(240, 0)!;
    expect(end.pos[1]).toBeGreaterThan(R - 0.06);
    expect(end.pos[1]).toBeLessThan(R + 0.06);
    expect(Math.abs(end.pos[0])).toBeLessThan(1e-3);
  });

  it('bounciness 1 comes back high, bounciness 0 stays down', async () => {
    const w1 = world({ floorBounce: 1 });
    const bouncy = run([body({ pos: [0, 4, 0], bounce: 1 })], w1);
    const dead = run([body({ pos: [0, 4, 0], bounce: 0 })], world());
    await bouncy.ensure(150, none(1));
    await dead.ensure(150, none(1));
    let peak = 0;
    let t0 = -1;
    for (let k = 0; k <= 150; k++) {
      const y = bouncy.body(k, 0)!.pos[1];
      if (t0 < 0 && y < 0.6) t0 = k;
      if (t0 >= 0 && k > t0 + 3) peak = Math.max(peak, y);
    }
    expect(peak).toBeGreaterThan(2.5);
    for (let k = 100; k <= 150; k++) expect(dead.body(k, 0)!.pos[1]).toBeLessThan(0.6);
  });

  it('a box on a tilted ramp slides with low friction and sticks with high friction', async () => {
    const ramp = body({ shape: 'box', size: [6, 0.4, 3], pos: [0, 0, 0], rot: [0, 0, -30], kind: 'fixed', friction: 0.5 });
    const mk = (fr: number) => body({ shape: 'box', size: [0.6, 0.6, 0.6], pos: [-1.2, 1.1, 0], rot: [0, 0, -30], friction: fr });
    const w = world({ floor: false });
    const slippery = run([ramp, { ...mk(0.02) }], { ...w, floorFriction: 0 });
    const grippy = run([{ ...ramp, friction: 2 }, { ...mk(2) }], w);
    await slippery.ensure(120, none(2));
    await grippy.ensure(120, none(2));
    const sx = slippery.body(120, 1)!.pos;
    const gx = grippy.body(120, 1)!.pos;
    const s0 = slippery.body(0, 1)!.pos;
    expect(sx[0] - s0[0]).toBeGreaterThan(1.5);
    expect(Math.abs(gx[0] - s0[0])).toBeLessThan(0.3);
  });

  it('two bodies collide and keep their momentum roughly', async () => {
    const w = world({ gravity: [0, 0, 0], floor: false });
    const a = body({ pos: [-3, 0, 0], vel: [4, 0, 0], mass: 1, bounce: 1, friction: 0 });
    const b = body({ pos: [3, 0, 0], vel: [0, 0, 0], mass: 2, bounce: 1, friction: 0 });
    const r = run([a, b], w);
    await r.ensure(180, none(2));
    const p0 = 1 * 4;
    const dx = (k: number, i: number) => r.body(k, i)!.pos[0] - r.body(k - 1, i)!.pos[0];
    const v = (k: number, i: number) => dx(k, i) * 60;
    const p1 = 1 * v(180, 0) + 2 * v(180, 1);
    expect(Math.abs(p1 - p0)).toBeLessThan(0.3);
    expect(v(180, 1)).toBeGreaterThan(1); // the heavy one was shoved forward
  });

  it('is deterministic: two fresh runs match bit for bit at frame 240', async () => {
    const bodies = [body({ pos: [0, 3, 0] }), body({ shape: 'box', pos: [0.3, 5, 0.2], rot: [20, 30, 10], size: [1, 1, 1] }), body({ shape: 'capsule', pos: [-0.4, 7, 0], size: [0.3, 1, 1] })];
    const a = run(bodies, world({ floorBounce: 0.3 }), 'det-a');
    await a.ensure(240, none(3));
    const b = run(bodies, world({ floorBounce: 0.3 }), 'det-b');
    await b.ensure(240, none(3));
    expect(a).not.toBe(b);
    expect(Array.from(a.frames[240])).toEqual(Array.from(b.frames[240]));
  });

  it('scrubbing gives the same frame 200 every time, and stepping from a different gap is identical', async () => {
    const bodies = [body({ pos: [0, 3, 0] }), body({ shape: 'box', pos: [0.3, 5, 0.2], rot: [20, 30, 10], size: [1, 1, 1] })];
    const r = run(bodies, world());
    await r.ensure(200, none(2));
    const first = Array.from(r.frames[200]);
    await r.ensure(50, none(2));
    const mid = r.body(50, 0)!;
    await r.ensure(200, none(2));
    expect(Array.from(r.frames[200])).toEqual(first);
    expect(mid).toBeTruthy();
    // a different run that reached 200 in two jumps
    const r2 = run(bodies, world());
    await r2.ensure(77, none(2));
    await r2.ensure(200, none(2));
    expect(Array.from(r2.frames[200])).toEqual(first);
  });

  it('the same signature shares one run; changing a setting makes another', () => {
    const bodies = [body()];
    const a = getRun(runSignature(bodies, world(), 'same'), bodies, world(), backend, 0);
    const b = getRun(runSignature(bodies, world(), 'same'), bodies, world(), backend, 0);
    const c = getRun(runSignature(bodies, world({ gravity: [0, -3, 0] }), 'same'), bodies, world({ gravity: [0, -3, 0] }), backend, 0);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('a kinematic body shoves a dynamic one', async () => {
    const w = world({ gravity: [0, 0, 0], floor: false });
    const bodies = [body({ kind: 'kinematic', shape: 'box', size: [1, 1, 1], pos: [-3, 0, 0] }), body({ pos: [0, 0, 0], size: [0.5, 1, 1] })];
    const r = run(bodies, w);
    await r.ensure(120, (k) => ({ ...noInputs(2), move: [[-3 + k * 0.06, 0, 0], null] }));
    expect(r.body(120, 1)!.pos[0]).toBeGreaterThan(1);
  });

  it('a Push impulse changes the velocity on the frame the number rises above 0, once', async () => {
    const w = world({ gravity: [0, 0, 0], floor: false });
    const r = run([body({ pos: [0, 0, 0] })], w);
    const inputs = (k: number): FrameInputs => ({ ...noInputs(1), push: [3, 0, 0], pushNow: k >= 10 && k < 20 ? 1 : 0 });
    await r.ensure(40, inputs);
    expect(r.body(9, 0)!.pos[0]).toBe(0);
    const vx = (r.body(40, 0)!.pos[0] - r.body(39, 0)!.pos[0]) * 60;
    expect(vx).toBeCloseTo(3, 1); // pushed once (not 10 times) by 3 units per second
  });

  it('a sphere at rest goes to sleep', async () => {
    const r = run([body({ pos: [0, 0.5, 0], bounce: 0 })], world());
    await r.ensure(400, none(1));
    expect(r.body(400, 0)!.asleep).toBe(true);
    expect(r.moving(400)).toBe(0);
  });

  it('normalizeBodies keeps at most 16 and fills defaults', () => {
    const list = normalizeBodies(Array.from({ length: 30 }, () => ({ shape: 'weird', pos: [1, 'x'] })));
    expect(list.length).toBe(16);
    expect(list[0].shape).toBe('sphere');
    expect(list[0].pos).toEqual([1, 2, 0]);
  });
});

describe('performance', () => {
  for (const n of [8, 64, 256]) {
    it(`${n} bodies: time per simulated frame`, async () => {
      const bodies: BodySpec[] = [];
      for (let i = 0; i < n; i++) bodies.push(body({ shape: i % 2 ? 'box' : 'sphere', size: [0.4, 0.8, 0.8], pos: [(i % 8) * 0.9 - 3, 1 + Math.floor(i / 8) * 0.9, ((i * 7) % 5) * 0.3] }));
      const w = world();
      const r = new (await import('./sim')).SimRun(bodies, w, backend, 0);
      const t0 = performance.now();
      await r.ensure(120, none(n));
      const ms = (performance.now() - t0) / 120;
      console.log(`physics perf: ${n} bodies, ${ms.toFixed(3)} ms per frame`);
      r.free();
      expect(ms).toBeLessThan(50);
    }, 60_000);
  }
});

export type { Quat };
