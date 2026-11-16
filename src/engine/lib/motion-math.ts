/**
 * Phone motion maths (pure): quaternions, the W3C device-orientation conversion, the scene frame, Euler extraction, angle unwrapping,
 * the one-euro filter and small helpers shared by the phone page, the desktop receiver and the nodes.
 *
 * Frames used here:
 *  - World (W3C): x east, y north, z up (right handed). `deviceOrientationToQuat` gives the device -> world rotation.
 *  - Device: x right, y up (towards the top edge), z out of the screen towards the user.
 *  - Scene (RSMPS 3D): x right, y up, z INTO the screen (left handed). A phone held upright with its back camera looking along +z is the
 *    identity pose. `worldToScene` turns a device -> world quaternion into the orientation of that "camera-like" frame in the scene.
 * Quaternions are [x, y, z, w], unit length, Hamilton product (a * b applies b first).
 */

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];
/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const qDot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
export function qNorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l < 1e-12 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qAxisAngle(axis: 'x' | 'y' | 'z', deg: number): Quat {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return axis === 'x' ? [s, 0, 0, Math.cos(h)] : axis === 'y' ? [0, s, 0, Math.cos(h)] : [0, 0, s, Math.cos(h)];
}
/** Shortest-path interpolation (t 0..1). */
export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = qDot(a, b);
  let bb: Quat = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}
/** Same rotation, flipped to the hemisphere of `ref` (keeps a stream continuous). */
export const qAlign = (q: Quat, ref: Quat): Quat => (qDot(q, ref) < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);

/** Logarithm of a unit quaternion: the rotation vector (axis * half-angle), 3 numbers. */
export function qLog(q: Quat): Vec3 {
  const n = Math.hypot(q[0], q[1], q[2]);
  if (n < 1e-9) return [0, 0, 0];
  const k = Math.atan2(n, q[3]) / n;
  return [q[0] * k, q[1] * k, q[2] * k];
}
export function qExp(v: Vec3): Quat {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-9) return [0, 0, 0, 1];
  const s = Math.sin(n) / n;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(n)];
}

export function matFromQuat(q: Quat): Mat3 {
  const [x, y, z, w] = qNorm(q);
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
export function quatFromMat(m: ArrayLike<number>): Quat {
  const tr = m[0] + m[4] + m[8];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, 0.25 * s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s];
  }
  return qNorm(q);
}
export function rotate(q: Quat, v: Vec3): Vec3 {
  const m = matFromQuat(q);
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/* ------------------------------------------------------------------ device orientation -> quaternion */

/**
 * W3C DeviceOrientation (alpha about z, beta about x, gamma about y; intrinsic Z-X'-Y'') to the device -> world quaternion, then the
 * screen orientation angle (`screen.orientation.angle`, 0 / 90 / 180 / 270) is applied so the result follows the screen, not the chassis.
 */
export function deviceOrientationToQuat(alphaDeg: number, betaDeg: number, gammaDeg: number, screenAngleDeg = 0): Quat {
  let q = qMul(qMul(qAxisAngle('z', alphaDeg), qAxisAngle('x', betaDeg)), qAxisAngle('y', gammaDeg));
  if (screenAngleDeg) q = qMul(q, qAxisAngle('z', -screenAngleDeg));
  return qNorm(q);
}

const S_WORLD_TO_SCENE: Mat3 = [1, 0, 0, 0, 0, 1, 0, 1, 0]; // (east, north, up) -> (east, up, north)
const F_FLIP_Z: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, -1];
function mulMat(a: ArrayLike<number>, b: ArrayLike<number>): Mat3 {
  const r = new Array(9).fill(0) as number[];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r as Mat3;
}
/**
 * Device -> world quaternion into the scene frame: the rotation of a camera-like frame (x right, y up, z = the back camera's view
 * direction) in scene axes. Phone upright, back camera looking north = identity. Pointing the camera east gives yaw +90 (turn right).
 */
export function worldToScene(q: Quat): Quat {
  return quatFromMat(mulMat(mulMat(S_WORLD_TO_SCENE, matFromQuat(q)), F_FLIP_Z));
}
/** Orientation relative to a reference pose (the reference becomes identity). */
export const relativeTo = (ref: Quat, q: Quat): Quat => qNorm(qMul(qConj(ref), q));

/* ------------------------------------------------------------------ angles */

export interface LookAngles {
  yaw: number;
  pitch: number;
  roll: number;
}
/**
 * Camera-style angles of a scene quaternion, degrees: yaw = turn to the right, pitch = look up, roll = tilt clockwise (right edge down)
 * as the user sees it. Not unwrapped (yaw/roll in -180..180, pitch in -90..90).
 */
export function lookAngles(q: Quat): LookAngles {
  const m = matFromQuat(q);
  const f: Vec3 = [m[2], m[5], m[8]];
  const r: Vec3 = [m[0], m[3], m[6]];
  const pitch = Math.asin(Math.max(-1, Math.min(1, f[1])));
  const flat = Math.hypot(f[0], f[2]);
  const yaw = flat < 1e-6 ? Math.atan2(-r[2], r[0]) : Math.atan2(f[0], f[2]);
  // horizon-level right vector h and level up u0 for this view direction
  let h: Vec3;
  if (flat < 1e-6) h = [Math.cos(yaw), 0, -Math.sin(yaw)];
  else h = [f[2] / flat, 0, -f[0] / flat];
  const u0: Vec3 = [f[1] * h[2] - f[2] * h[1], f[2] * h[0] - f[0] * h[2], f[0] * h[1] - f[1] * h[0]];
  const roll = -Math.atan2(r[0] * u0[0] + r[1] * u0[1] + r[2] * u0[2], r[0] * h[0] + r[1] * h[1] + r[2] * h[2]);
  return { yaw: yaw * RAD, pitch: pitch * RAD, roll: roll * RAD };
}
/** The scene quaternion for given look angles (inverse of `lookAngles`, no gimbal ambiguity for |pitch| < 90). */
export function quatFromLook(yawDeg: number, pitchDeg: number, rollDeg: number): Quat {
  // yaw turns right about +y (left-handed scene: positive turns +z towards +x), pitch tilts up, roll tilts clockwise.
  const yaw = matFromAxisAngleLH('y', yawDeg);
  const pitch = matFromAxisAngleLH('x', -pitchDeg);
  const roll = matFromAxisAngleLH('z', -rollDeg);
  return quatFromMat(mulMat(mulMat(yaw, pitch), roll));
}
/** A rotation in the scene's (left-handed) axes by the usual formulas: positive angle takes +z towards +x about y, +y towards +z about x... (see tests). */
function matFromAxisAngleLH(axis: 'x' | 'y' | 'z', deg: number): Mat3 {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * The three numbers (degrees) for 3D Object's `rotX / rotY / rotZ`, in exactly the order that node uses (rotationZYX: Rz * Ry * Rx), so the
 * object takes the same orientation as the phone: `rotationZYX(x, y, z)` equals the matrix of `q`. Not unwrapped.
 */
export function objectRotation(q: Quat): Vec3 {
  const m = matFromQuat(q);
  const y = Math.asin(Math.max(-1, Math.min(1, -m[6])));
  if (Math.abs(m[6]) > 0.999999) return [Math.atan2(-m[5], m[4]) * RAD, y * RAD, 0]; // gimbal lock: all turn goes into X
  return [Math.atan2(m[7], m[8]) * RAD, y * RAD, Math.atan2(m[3], m[0]) * RAD];
}

/** Shift `next` by whole turns so it is the closest equivalent to `prev` (continuous angles, no jump at +-180). */
export function unwrapAngle(prev: number, next: number): number {
  return next + 360 * Math.round((prev - next) / 360);
}
/** Wrap to -180..180. */
export const wrapAngle = (a: number): number => a - 360 * Math.round(a / 360);

/** Unwraps a stream of angles; remembers the last value. */
export class Unwrapper {
  last: number | null = null;
  push(a: number): number {
    const v = this.last === null ? a : unwrapAngle(this.last, a);
    this.last = v;
    return v;
  }
  reset(): void {
    this.last = null;
  }
}

/* ------------------------------------------------------------------ filters */

/**
 * One-euro filter (Casiez et al.): low lag on fast moves, strong smoothing when nearly still. `minCutoff` in Hz (lower = smoother),
 * `beta` speed coefficient. Time is passed in seconds, so irregular sample times are fine.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(public minCutoff = 1.5, public beta = 0.02, public dCutoff = 1) {}
  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, tSec: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tSec;
      return value;
    }
    const dt = tSec - this.t;
    if (dt <= 1e-6) return this.x;
    this.t = tSec;
    const dRaw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}
/** `smoothing` 0..1 (0 = off) to a one-euro setting. */
export function smoothingToEuro(smoothing: number): { minCutoff: number; beta: number } {
  const s = Math.max(0, Math.min(1, smoothing));
  return { minCutoff: 30 * Math.pow(0.5 / 30, s), beta: 0.02 * (1 + 4 * s) };
}

/** One-euro on a quaternion stream (components on one hemisphere, then renormalised). */
export class QuatFilter {
  private f: OneEuro[] = [new OneEuro(), new OneEuro(), new OneEuro(), new OneEuro()];
  private last: Quat | null = null;
  constructor(smoothing = 0.3) {
    this.set(smoothing);
  }
  set(smoothing: number): void {
    const { minCutoff, beta } = smoothingToEuro(smoothing);
    for (const f of this.f) {
      f.minCutoff = minCutoff;
      f.beta = beta;
    }
  }
  filter(q: Quat, tSec: number): Quat {
    const a = this.last ? qAlign(q, this.last) : q;
    const out = qNorm([this.f[0].filter(a[0], tSec), this.f[1].filter(a[1], tSec), this.f[2].filter(a[2], tSec), this.f[3].filter(a[3], tSec)]);
    this.last = out;
    return out;
  }
  reset(): void {
    this.f.forEach((f) => f.reset());
    this.last = null;
  }
}

/* ------------------------------------------------------------------ small helpers */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Dead zone: 0 inside +-`dz` of zero, then rescaled so the output still reaches the full value. */
export function deadzone(v: number, dz: number, full = 1): number {
  if (dz <= 0) return v;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / Math.max(1e-9, full - dz)) * full;
}
/** Asymmetric attack / release follower (seconds). */
export function envelope(prev: number, target: number, dt: number, attack: number, release: number): number {
  const tc = target > prev ? attack : release;
  if (tc <= 1e-6) return target;
  return prev + (target - prev) * (1 - Math.exp(-dt / tc));
}
