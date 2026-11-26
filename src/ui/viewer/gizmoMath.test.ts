import { describe, expect, it } from 'vitest';
import { orbitPosition, simpleCamera } from '../../engine/lib/gen-camera';
import { rotationZYX } from '../../engine/lib/gen-common';
import type { CameraValue } from '../../engine/types';
import {
  angleStep,
  apply3,
  axisAngle,
  axisTriad,
  depthFactorForDrag,
  depthFactorForWheel,
  dragDepth,
  dragMove,
  dragScale,
  eulerZYX,
  lensOf,
  matrixOf,
  mul3,
  projectPoint,
  rayAt,
  screenAngle,
  screenRadius,
  turnRoll,
  turnTrackball,
  type Euler,
  type V3,
} from './gizmoMath';

const W = 1280;
const H = 720;
const builtin = (o: Partial<Parameters<typeof simpleCamera>[0]> = {}) => simpleCamera({ ortho: false, fovDeg: 30, frameSize: 0.6, x: 0.5, y: 0.5, width: W, height: H, ...o });
const cam = (projection: CameraValue['projection'], o: Partial<CameraValue> = {}): CameraValue => ({ kind: 'camera', projection, fov: 60, orthoSize: 4, position: orbitPosition([0, 0, 0], 4.5, 30, 20), target: [0, 0, 0], roll: 10, shift: [0.1, -0.05], ...o });
const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const transpose = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

describe('projection', () => {
  it('the built-in camera shows the origin at Frame X / Y, and up in the scene is up in the picture', () => {
    for (const ortho of [false, true]) {
      const l = lensOf(builtin({ ortho, x: 0.3, y: 0.8, frameSize: 0.5 }), W, H);
      const c = projectPoint(l, [0, 0, 0]);
      close([c.x, c.y], [0.3, 0.8]);
      expect(c.visible).toBe(true);
      expect(projectPoint(l, [0, 1, 0]).y).toBeLessThan(c.y);
      expect(projectPoint(l, [1, 0, 0]).x).toBeGreaterThan(c.x);
    }
    // orthographic: 2 units span Frame size of the short side, so 1 unit = 0.25 x 720 px here
    const l = lensOf(builtin({ ortho: true, frameSize: 0.5 }), W, H);
    expect((projectPoint(l, [1, 0, 0]).x - 0.5) * W).toBeCloseTo(0.25 * H, 6);
  });

  it('projecting a point and casting the ray back through it meets the point again, for every lens', () => {
    for (const projection of ['orthographic', 'perspective', 'fisheye', 'panoramic', 'cylindrical'] as const) {
      const l = lensOf(cam(projection, { fov: projection === 'fisheye' ? 170 : 60 }), W, H);
      for (let i = 0; i < 40; i++) {
        const p: V3 = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
        const s = projectPoint(l, p);
        expect(s.visible, projection).toBe(true);
        const ray = rayAt(l, s.x, s.y)!;
        expect(ray, projection).not.toBeNull();
        // distance from the point to the ray
        const d: V3 = [p[0] - ray.ro[0], p[1] - ray.ro[1], p[2] - ray.ro[2]];
        const t = dot(d, ray.rd);
        const off = Math.hypot(d[0] - ray.rd[0] * t, d[1] - ray.rd[1] * t, d[2] - ray.rd[2] * t);
        expect(off, projection).toBeLessThan(1e-6);
        expect(t, projection).toBeGreaterThan(0);
      }
    }
  });

  it('a point behind a perspective camera is reported as not visible', () => {
    expect(projectPoint(lensOf(builtin(), W, H), [0, 0, -50]).visible).toBe(false);
  });

  it('screenRadius: the nominal object fills Frame size of the short side with the built-in camera', () => {
    for (const ortho of [false, true]) {
      const l = lensOf(builtin({ ortho, frameSize: 0.6 }), W, H);
      // 1 unit at the origin = half of 0.6 of the short side (perspective: the sphere's outline is what fills it, its centre plane is a touch smaller)
      const r = screenRadius(l, [0, 0, 0], 1);
      expect(r).toBeGreaterThan(0.27);
      expect(r).toBeLessThanOrEqual(0.3 + 1e-9);
      // twice as far = half as large, with perspective only
      const far = screenRadius(l, [0, 0, -l.pos[2]], 1);
      expect(far / r).toBeCloseTo(ortho ? 1 : 0.5, 6);
    }
  });
});

describe('dragging an object on the picture', () => {
  const lenses = () => [lensOf(builtin(), W, H), lensOf(builtin({ ortho: true }), W, H), lensOf(cam('perspective'), W, H), lensOf(cam('orthographic'), W, H)];

  it('the object follows the finger exactly and stays at the same depth (perspective and orthographic)', () => {
    for (const l of lenses()) {
      const p0: V3 = [0.4, -0.2, 0.7];
      const c0 = projectPoint(l, p0);
      // the finger grabs a little off-centre and moves 200 px right, 90 px up
      const grab = { x: c0.x + 0.01, y: c0.y - 0.02 };
      const now = { x: grab.x + 200 / W, y: grab.y - 90 / H };
      const p1 = dragMove(l, p0, grab, now)!;
      const c1 = projectPoint(l, p1);
      expect((c1.x - c0.x) * W).toBeCloseTo(200, 6);
      expect((c1.y - c0.y) * H).toBeCloseTo(-90, 6);
      expect(c1.depth).toBeCloseTo(c0.depth, 9);
    }
  });

  it('built-in camera: right on screen is +X, up on screen is +Y, Z does not change, by the amount the lens says', () => {
    const l = lensOf(builtin(), W, H);
    const p = dragMove(l, [0, 0, 0], { x: 0.5, y: 0.5 }, { x: 0.5 + 100 / W, y: 0.5 - 50 / H })!;
    expect(p[2]).toBeCloseTo(0, 9);
    // Frame size 0.6 of 720 px = 432 px for a sphere of radius 1; in the plane through its centre that is 2 / cos(15 deg) units (30 deg perspective)
    const pxPerUnit = ((0.6 * H) / 2) * Math.cos((15 * Math.PI) / 180);
    expect(p[0]).toBeCloseTo(100 / pxPerUnit, 6);
    expect(p[1]).toBeCloseTo(50 / pxPerUnit, 6);
  });

  it('movement scales with distance under perspective: the same finger travel moves a far object further', () => {
    const l = lensOf(builtin(), W, H);
    const drag = (z: number) => {
      const c = projectPoint(l, [0, 0, z]);
      return dragMove(l, [0, 0, z], c, { x: c.x + 100 / W, y: c.y })![0];
    };
    expect(drag(-l.pos[2]) / drag(0)).toBeCloseTo(2, 6); // twice as far from the camera
  });

  it('wide lenses: the object follows the finger and keeps its distance from the camera', () => {
    for (const projection of ['fisheye', 'panoramic', 'cylindrical'] as const) {
      const l = lensOf(cam(projection, { fov: projection === 'fisheye' ? 170 : 60 }), W, H);
      const p0: V3 = [0.3, 0.2, -0.4];
      const c0 = projectPoint(l, p0);
      const p1 = dragMove(l, p0, c0, { x: c0.x + 0.05, y: c0.y + 0.04 })!;
      const c1 = projectPoint(l, p1);
      close([c1.x - c0.x, c1.y - c0.y], [0.05, 0.04]);
      expect(c1.depth).toBeCloseTo(c0.depth, 9);
    }
  });

  it('a finger outside a fisheye circle moves nothing', () => {
    const l = lensOf(cam('fisheye', { fov: 170, shift: [0, 0] }), W, H);
    expect(dragMove(l, [0, 0, 0], { x: 0.5, y: 0.5 }, { x: 0.99, y: 0.5 })).toBeNull();
  });

  it('depth: away makes it smaller, closer makes it larger, and it stays under the handle', () => {
    for (const l of [lensOf(builtin(), W, H), lensOf(cam('perspective'), W, H)]) {
      const p0: V3 = [0.5, 0.3, 0.2];
      const c0 = projectPoint(l, p0);
      const far = dragDepth(l, p0, 2);
      const near = dragDepth(l, p0, 0.5);
      const cf = projectPoint(l, far);
      close([cf.x, cf.y], [c0.x, c0.y]);
      expect(screenRadius(l, far, 1)).toBeLessThan(screenRadius(l, p0, 1));
      expect(screenRadius(l, near, 1)).toBeGreaterThan(screenRadius(l, p0, 1));
      // away and back again is where it started
      close(dragDepth(l, far, 0.5), p0);
    }
    // the built-in camera looks along +Z: pushing away raises Move Z
    expect(dragDepth(lensOf(builtin(), W, H), [0, 0, 0], 1.5)[2]).toBeGreaterThan(0);
    expect(dragDepth(lensOf(builtin({ ortho: true }), W, H), [0, 0, 0], 1.5)[2]).toBeGreaterThan(0);
    // never through the camera
    const l = lensOf(builtin(), W, H);
    expect(dragDepth(l, [0, 0, 0], 1e-9)[2]).toBeGreaterThan(l.pos[2]);
  });

  it('gesture to depth factor: dragging up or wheeling up pushes away, 150 px doubles the distance', () => {
    expect(depthFactorForDrag(-150)).toBeCloseTo(2, 2);
    expect(depthFactorForDrag(150)).toBeCloseTo(0.5, 2);
    expect(depthFactorForDrag(0)).toBe(1);
    expect(depthFactorForWheel(-100)).toBeGreaterThan(1);
    expect(depthFactorForWheel(100)).toBeLessThan(1);
    expect(depthFactorForWheel(100) * depthFactorForWheel(-100)).toBeCloseTo(1, 12);
    expect(depthFactorForWheel(1e9)).toBeGreaterThan(0.5); // one wild wheel event cannot throw the object away
  });

  it('size: twice as far from the centre is twice as large, inside the limits', () => {
    expect(dragScale(1, 100, 200)).toBeCloseTo(2);
    expect(dragScale(1.5, 100, 50)).toBeCloseTo(0.75);
    expect(dragScale(1, 100, 1e6)).toBe(20);
    expect(dragScale(1, 100, 0)).toBe(0.01);
    expect(dragScale(3, 0, 50)).toBe(3);
  });
});

describe("rotation in the nodes' own convention (Rotate X, then Y, then Z)", () => {
  it("axisAngle about the scene axes is the same as the nodes' rotation matrix", () => {
    close(axisAngle([1, 0, 0], 0.7), rotationZYX((0.7 * 180) / Math.PI, 0, 0), 1e-9);
    close(axisAngle([0, 1, 0], -1.1), rotationZYX(0, (-1.1 * 180) / Math.PI, 0), 1e-9);
    close(axisAngle([0, 0, 2], 2.2), rotationZYX(0, 0, (2.2 * 180) / Math.PI), 1e-9);
  });

  it('angles -> matrix -> angles gives the same rotation back, and the same numbers when asked to stay near them', () => {
    for (let i = 0; i < 300; i++) {
      const e: Euler = [rnd() * 720 - 360, rnd() * 720 - 360, rnd() * 720 - 360];
      const m = matrixOf(e);
      const free = eulerZYX(m);
      expect(maxDiff(matrixOf(free), m)).toBeLessThan(1e-9);
      for (const v of free) expect(Math.abs(v)).toBeLessThanOrEqual(360);
      expect(maxDiff(eulerZYX(m, e), e)).toBeLessThan(1e-6);
    }
  });

  it('the spawn pose (25, 35, 0) survives a round trip untouched', () => {
    close(eulerZYX(matrixOf([25, 35, 0]), [25, 35, 0]), [25, 35, 0], 1e-9);
  });

  it('gimbal lock (Rotate Y at +-90) still returns the right rotation', () => {
    for (const y of [90, -90]) {
      for (const [x, z] of [[20, 50], [-130, 10], [0, 0], [170, -170]]) {
        const m = matrixOf([x, y, z]);
        const e = eulerZYX(m, [x, y, z]);
        expect(maxDiff(matrixOf(e), m)).toBeLessThan(1e-6);
        expect(e[2]).toBe(z);
      }
    }
  });

  it("values stay inside the fields' range of -360..360", () => {
    // turning on past 360 wraps instead of leaving the range
    const m = mul3(axisAngle([1, 0, 0], (10 * Math.PI) / 180), matrixOf([355, 0, 0]));
    const w = eulerZYX(m, [355, 0, 0]);
    expect(Math.abs(w[0])).toBeLessThanOrEqual(360);
    expect(maxDiff(matrixOf(w), m)).toBeLessThan(1e-9);
  });

  /** Where the point of the object that faces the camera goes on screen (in handle radii, y down) after the object is turned from rot0 to rot1. */
  const frontPointShift = (l: ReturnType<typeof lensOf>, rot0: Euler, rot1: Euler) => {
    const front: V3 = [-l.fwd[0], -l.fwd[1], -l.fwd[2]]; // offset from the centre, towards the camera
    // carry the point with the object: scene offset -> object space with rot0 -> scene with rot1
    const moved = apply3(matrixOf(rot1), apply3(transpose(matrixOf(rot0)), front));
    return { x: dot(moved, l.right), y: -dot(moved, l.up) };
  };

  it('trackball: a drag to the right turns the side facing you to the right, a drag down turns it down, by as much as the finger moved', () => {
    for (const l of [lensOf(builtin(), W, H), lensOf(cam('perspective'), W, H), lensOf(cam('orthographic', { roll: -40 }), W, H)]) {
      for (const rot0 of [[0, 0, 0], [25, 35, 0], [-140, 70, 200]] as Euler[]) {
        const right = frontPointShift(l, rot0, turnTrackball(l, rot0, 30, 0, 100));
        // 30 px on a 100 px handle = 0.3 rad, so the front point moves sin(0.3) of the radius
        expect(right.x).toBeCloseTo(Math.sin(0.3), 9);
        expect(Math.abs(right.y)).toBeLessThan(1e-9);
        const down = frontPointShift(l, rot0, turnTrackball(l, rot0, 0, 30, 100));
        expect(down.y).toBeCloseTo(Math.sin(0.3), 9);
        expect(Math.abs(down.x)).toBeLessThan(1e-9);
        const diag = frontPointShift(l, rot0, turnTrackball(l, rot0, -20, 20, 100));
        expect(diag.x).toBeLessThan(0);
        expect(diag.y).toBeGreaterThan(0);
        expect(-diag.x).toBeCloseTo(diag.y, 9);
      }
    }
  });

  it('trackball with the built-in camera from no rotation: sideways is Rotate Y alone, up and down is Rotate X alone', () => {
    const l = lensOf(builtin(), W, H);
    const r = turnTrackball(l, [0, 0, 0], 50, 0, 100);
    expect(Math.abs(r[1])).toBeCloseTo((0.5 * 180) / Math.PI, 6);
    expect(Math.abs(r[0]) + Math.abs(r[2])).toBeLessThan(1e-9);
    const d = turnTrackball(l, [0, 0, 0], 0, 50, 100);
    expect(Math.abs(d[0])).toBeCloseTo((0.5 * 180) / Math.PI, 6);
    expect(Math.abs(d[1]) + Math.abs(d[2])).toBeLessThan(1e-9);
  });

  it('trackball: no movement changes nothing, and coming back to the start restores the start', () => {
    const l = lensOf(cam('perspective'), W, H);
    const rot0: Euler = [25, 35, 0];
    expect(turnTrackball(l, rot0, 0, 0, 100)).toEqual(rot0);
    // wander off (remembering the last values, as the gizmo does) and return
    let near = turnTrackball(l, rot0, 300, -120, 100);
    near = turnTrackball(l, rot0, 150, 200, 100, near);
    near = turnTrackball(l, rot0, 1e-7, 0, 100, near);
    expect(maxDiff(matrixOf(near), matrixOf(rot0))).toBeLessThan(1e-6);
  });

  it('a long trackball drag moves the numbers smoothly: no flips of 180 degrees, and a whole turn only where a field reaches the end of its range', () => {
    const l = lensOf(builtin(), W, H);
    const rot0: Euler = [25, 35, 0];
    let near = rot0;
    for (let px = 0; px <= 1200; px += 4) {
      const next = turnTrackball(l, rot0, px, px * 0.37, 100, near);
      let wraps = 0;
      next.forEach((v, i) => {
        const d = Math.abs(v - near[i]);
        if (d > 300) {
          // the field ran into +-360 and came back in at the other side: the same angle, one whole turn less
          wraps++;
          expect(Math.abs(d - 360), `at ${px}px`).toBeLessThan(30);
          expect(Math.abs(near[i]), `at ${px}px`).toBeGreaterThan(330);
        } else expect(d, `at ${px}px`).toBeLessThan(30);
      });
      expect(wraps).toBeLessThanOrEqual(1);
      expect(maxDiff(matrixOf(next), mul3(axisAngle([-0.37 * px, -px, 0], Math.hypot(px, px * 0.37) / 100), matrixOf(rot0))), `at ${px}px`).toBeLessThan(1e-6);
      near = next;
    }
  });

  it('roll ring: counter-clockwise on screen turns the object counter-clockwise on screen', () => {
    for (const l of [lensOf(builtin(), W, H), lensOf(cam('perspective'), W, H)]) {
      const rot0: Euler = [10, -20, 30];
      const rot1 = turnRoll(l, rot0, 0.4);
      // follow the point of the object that sits at its right-hand side on screen
      const moved = apply3(matrixOf(rot1), apply3(transpose(matrixOf(rot0)), l.right));
      expect(Math.atan2(dot(moved, l.up), dot(moved, l.right))).toBeCloseTo(0.4, 9);
    }
    // built-in camera, no rotation: a roll is exactly Rotate Z
    const z = turnRoll(lensOf(builtin(), W, H), [0, 0, 0], 0.5);
    expect(Math.abs(z[2])).toBeCloseTo((0.5 * 180) / Math.PI, 6);
    expect(Math.abs(z[0]) + Math.abs(z[1])).toBeLessThan(1e-9);
  });

  it('screen angles: counter-clockwise is positive with y down, and steps take the short way across the seam', () => {
    expect(screenAngle(0, 0, 10, 0)).toBeCloseTo(0);
    expect(screenAngle(0, 0, 0, -10)).toBeCloseTo(Math.PI / 2); // straight up on screen
    expect(angleStep(3.1, -3.1)).toBeCloseTo(2 * Math.PI - 6.2, 9);
    expect(angleStep(-3.1, 3.1)).toBeCloseTo(-(2 * Math.PI - 6.2), 9);
  });

  it('axis triad: with no rotation and the built-in camera X points right, Y up, Z into the picture', () => {
    const t = axisTriad(lensOf(builtin(), W, H), [0, 0, 0]);
    close(t[0], [1, 0]);
    close(t[1], [0, -1]);
    close(t[2], [0, 0]);
  });
});
