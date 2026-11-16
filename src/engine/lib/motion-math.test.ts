import { describe, expect, it } from 'vitest';
import { rotationZYX } from './gen-common';
import { cameraBasis } from './gen-camera';
import {
  OneEuro, QuatFilter, Unwrapper, deadzone, deviceOrientationToQuat, envelope, lookAngles, matFromQuat, objectRotation, qAxisAngle, qExp, qLog, qMul, qNorm, qSlerp,
  quatFromLook, relativeTo, rotate, unwrapAngle, wrapAngle, worldToScene, type Quat,
} from './motion-math';
import { applyRig, defaultRigCamera } from './motion-rig';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};
const sceneAngles = (a: number, b: number, g: number, screen = 0) => lookAngles(worldToScene(deviceOrientationToQuat(a, b, g, screen)));

describe('device orientation to quaternion (W3C)', () => {
  it('flat on a table, top to the north, screen up: identity device->world', () => {
    close(deviceOrientationToQuat(0, 0, 0), [0, 0, 0, 1]);
  });
  it('is unit length for any angles', () => {
    for (const [a, b, g] of [[10, 20, 30], [359, 179, -89], [90, 90, 0]]) expect(Math.hypot(...deviceOrientationToQuat(a, b, g))).toBeCloseTo(1, 9);
  });
  it('known poses in the scene frame', () => {
    // upright, facing the user (back camera looks north): neutral
    const up = sceneAngles(0, 90, 0);
    close([up.yaw, up.pitch, up.roll], [0, 0, 0], 1e-6);
    // flat on the table: the back camera looks straight down
    expect(sceneAngles(0, 0, 0).pitch).toBeCloseTo(-90, 6);
    // upright but turned 90 degrees counter-clockwise from above (alpha +90): looks west = turn left
    expect(sceneAngles(90, 90, 0).yaw).toBeCloseTo(-90, 6);
    expect(sceneAngles(270, 90, 0).yaw).toBeCloseTo(90, 6);
    // tilted back so the camera looks up (beta 90 -> 120 tips the top away from the user)
    const tilt = sceneAngles(0, 120, 0);
    expect(tilt.pitch).toBeCloseTo(30, 6);
    expect(tilt.yaw).toBeCloseTo(0, 6);
  });
  it('rolling the phone about its back camera axis is roll, clockwise = positive', () => {
    const q = qMul(deviceOrientationToQuat(0, 90, 0), qAxisAngle('z', -20));
    const a = lookAngles(worldToScene(q));
    close([a.yaw, a.pitch, a.roll], [0, 0, 20], 1e-6);
  });
  it('screen orientation: a phone held in landscape reads like the upright one', () => {
    const chassis = qMul(deviceOrientationToQuat(0, 90, 0), qAxisAngle('z', 90)); // rotated 90 degrees counter-clockwise
    const landscape = lookAngles(worldToScene(qMul(chassis, qAxisAngle('z', -90))));
    close([landscape.yaw, landscape.pitch, landscape.roll], [0, 0, 0], 1e-6);
    // and the helper applies the same correction when given the screen angle
    const viaHelper = deviceOrientationToQuat(0, 90, 0, 90);
    close(viaHelper, qNorm(qMul(deviceOrientationToQuat(0, 90, 0), qAxisAngle('z', -90))));
  });
  it('relative to a reference: the reference pose becomes identity, later turns stay turns', () => {
    const ref = worldToScene(deviceOrientationToQuat(40, 90, 0));
    close(relativeTo(ref, ref), [0, 0, 0, 1]);
    const turned = worldToScene(deviceOrientationToQuat(40 - 30, 90, 0)); // 30 degrees to the right
    expect(lookAngles(relativeTo(ref, turned)).yaw).toBeCloseTo(30, 5);
  });
});

describe('angles', () => {
  it('quatFromLook and lookAngles round-trip', () => {
    for (const [y, p, r] of [[0, 0, 0], [30, 10, -5], [-120, 45, 20], [170, -60, 80], [-179, 0, 0]]) {
      const a = lookAngles(quatFromLook(y, p, r));
      close([a.yaw, a.pitch, a.roll], [y, p, r], 1e-6);
    }
  });
  it('unwrapping keeps a continuous turn instead of jumping at +-180', () => {
    const u = new Unwrapper();
    const out: number[] = [];
    for (let a = 150; a <= 210; a += 10) out.push(u.push(wrapAngle(a)));
    expect(out).toEqual([150, 160, 170, 180, 190, 200, 210].map((v, i) => (i === 3 ? out[3] : v)));
    expect(Math.abs(out[3] - 180)).toBeLessThan(1e-9);
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(11);
    expect(unwrapAngle(350, 5)).toBe(365);
    expect(unwrapAngle(-170, 175)).toBe(-185);
  });
  it('object rotation trio reproduces the rotation exactly in the order 3D Object uses (Rz * Ry * Rx)', () => {
    for (const [y, p, r] of [[0, 0, 0], [30, 10, -5], [-120, 45, 20], [170, -60, 80], [75, 85, 100]]) {
      const q = quatFromLook(y, p, r);
      const [x, yy, z] = objectRotation(q);
      close(rotationZYX(x, yy, z), matFromQuat(q), 1e-9);
    }
    // large tilts, near the gimbal pole too
    for (const q of [quatFromLook(10, 89.9, 3), qNorm([0.3, 0.5, -0.2, 0.7]), qNorm([0.7, 0.1, 0.7, 0.1])] as Quat[]) {
      const [x, y, z] = objectRotation(q);
      close(rotationZYX(x, y, z), matFromQuat(q), 1e-5);
    }
  });
  it('log / exp and slerp', () => {
    const q = qNorm([0.2, -0.4, 0.3, 0.8]);
    close(qExp(qLog(q)), q, 1e-9);
    close(qSlerp([0, 0, 0, 1], qAxisAngle('y', 90), 0.5), qAxisAngle('y', 45), 1e-9);
  });
});

describe('filters and helpers', () => {
  it('one-euro: constant stays constant, noise variance drops, fast moves keep up', () => {
    const f = new OneEuro(1, 0.02);
    for (let i = 0; i < 20; i++) expect(f.filter(5, i / 60)).toBeCloseTo(5, 9);
    const g = new OneEuro(1, 0.0);
    let s = 1;
    const noisy: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      s = (s * 16807) % 2147483647;
      const n = (s / 2147483647 - 0.5) * 2;
      noisy.push(n);
      out.push(g.filter(n, i / 60));
    }
    const v = (a: number[]) => a.reduce((x, y) => x + y * y, 0) / a.length;
    expect(v(out.slice(30))).toBeLessThan(v(noisy.slice(30)) * 0.3);
    const h = new OneEuro(1, 5);
    let last = 0;
    for (let i = 0; i < 30; i++) last = h.filter(i * 10, i / 60);
    expect(290 - last).toBeLessThan(40);
  });
  it('quaternion filter keeps unit length and follows across a sign flip', () => {
    const f = new QuatFilter(0.5);
    for (let i = 0; i < 20; i++) {
      const q = qAxisAngle('y', i * 4);
      const out = f.filter(i % 2 ? ([-q[0], -q[1], -q[2], -q[3]] as Quat) : q, i / 60);
      expect(Math.hypot(...out)).toBeCloseTo(1, 9);
    }
  });
  it('dead zone and envelope', () => {
    expect(deadzone(0.05, 0.1)).toBe(0);
    expect(deadzone(1, 0.1)).toBeCloseTo(1, 9);
    expect(deadzone(-0.55, 0.1)).toBeCloseTo(-0.5, 9);
    expect(envelope(0, 1, 0.1, 0, 1)).toBe(1);
    expect(envelope(1, 0, 0.1, 0, 1)).toBeGreaterThan(0.85);
  });
  it('rotate agrees with the matrix', () => {
    const q = qAxisAngle('y', 90);
    close(rotate(q, [0, 0, 1]), [1, 0, 0], 1e-9);
  });
});

describe('camera rig', () => {
  it('look mode: the camera basis equals the phone orientation (forward, right, up)', () => {
    for (const [y, p, r] of [[0, 0, 0], [40, 15, 0], [-100, -30, 25], [160, 50, -40]]) {
      const cam = applyRig(defaultRigCamera(), y, p, r, [0, 0, 0], { orbit: false, lockRoll: false, heightOffset: 0, moveScale: 1 });
      const b = cameraBasis(cam);
      const m = matFromQuat(quatFromLook(y, p, r));
      close(b.forward, [m[2], m[5], m[8]], 1e-9);
      close(b.right, [m[0], m[3], m[6]], 1e-9);
      close(b.up, [m[1], m[4], m[7]], 1e-9);
    }
  });
  it('neutral phone gives the default camera', () => {
    const base = defaultRigCamera();
    close(applyRig(base, 0, 0, 0, [0, 0, 0], { orbit: false, lockRoll: false, heightOffset: 0, moveScale: 1 }).target, base.target, 1e-9);
    const orb = applyRig(base, 0, 0, 0, [0, 0, 0], { orbit: true, lockRoll: false, heightOffset: 0, moveScale: 1 });
    close(orb.position, base.position, 1e-9);
  });
  it('orbit mode keeps the target and the distance; turning right moves the camera to the left of the target', () => {
    const base = defaultRigCamera();
    const cam = applyRig(base, 90, 0, 0, [0, 0, 0], { orbit: true, lockRoll: false, heightOffset: 0, moveScale: 1 });
    close(cam.target, base.target, 1e-9);
    expect(Math.hypot(...cam.position)).toBeCloseTo(4.5, 9);
    expect(cam.position[0]).toBeCloseTo(-4.5, 6);
  });
  it('lock roll, height offset and move scale', () => {
    const base = defaultRigCamera();
    const a = applyRig(base, 0, 0, 30, [1, 0, 2], { orbit: false, lockRoll: true, heightOffset: 0.5, moveScale: 2 });
    expect(a.roll).toBe(0);
    close(a.position, [2, 0.5, -4.5 + 4], 1e-9);
    const b = applyRig(base, 0, 0, 30, [0, 0, 0], { orbit: false, lockRoll: false, heightOffset: 0, moveScale: 1 });
    expect(b.roll).toBe(-30);
  });
});
