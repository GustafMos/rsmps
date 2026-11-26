/**
 * From the four corners of a square marker in a camera picture to the camera's place in the room (pure).
 *
 * THE WORLD (the scene axes of the 3D nodes: x right, y up, z into the screen): the marker lies flat on the ground plane with its
 * centre at the origin. Its printed top edge points along +z ("away"), its right edge along +x, and its face looks up (+y). Lengths
 * are in marker widths here; `cameraFromPose` scales them to scene units.
 *
 * THE CAMERA is the same pinhole the 3D nodes use (lib/gen-3d.ts): square pixels, the optical axis through the middle of the picture,
 * and the field of view measured across the picture's SHORTER side. A pose is stored as "where the marker is, seen from the camera":
 * `r` holds the camera-space directions of the world x, y and z axes (three columns; camera space is right, up, forward) and `t` the
 * camera-space position of the marker's centre. Stored this way because that is what the picture measures well: smoothing `t` and
 * `r` keeps the object locked to the marker on screen, where smoothing the camera's own position would make it swim.
 */
import type { CameraValue } from '../types';
import { cameraBasis } from './gen-camera';

export type Pt = [number, number];
export type V3 = [number, number, number];
/** Row-major 3 x 3. */
export type M3 = [number, number, number, number, number, number, number, number, number];

export interface MarkerPose {
  /** Camera-space directions of the world axes: [xr, xu, xf, yr, yu, yf, zr, zu, zf] (three columns of a rotation, one after the other). */
  r: number[];
  /** Camera-space position (right, up, forward) of the marker centre, in marker widths. */
  t: V3;
  /** Root-mean-square distance between the measured corners and the corners this pose predicts, in pixels. */
  error: number;
}

/* ------------------------------------------------------------------ */
/* small maths                                                          */
/* ------------------------------------------------------------------ */

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normV = (a: ArrayLike<number>): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Solve A x = b (n x n, row-major) by elimination with pivoting. Null when singular. */
export function solveLinear(A: number[], b: number[], n: number): number[] | null {
  const m = A.slice();
  const x = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[piv * n + c])) piv = r;
    if (Math.abs(m[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) [m[c * n + k], m[piv * n + k]] = [m[piv * n + k], m[c * n + k]];
      [x[c], x[piv]] = [x[piv], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = m[r * n + c] / m[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) m[r * n + k] -= f * m[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= m[r * n + k] * x[k];
    x[r] = s / m[r * n + r];
  }
  return x;
}

/** The perspective mapping that takes four points to four points (a homography, last entry 1). Null for degenerate input. */
export function homography(src: readonly Pt[], dst: readonly Pt[]): M3 | null {
  const A: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push(x, y, 1, 0, 0, 0, -u * x, -u * y);
    b.push(u);
    A.push(0, 0, 0, x, y, 1, -v * x, -v * y);
    b.push(v);
  }
  const h = solveLinear(A, b, 8);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function mapPoint(H: ArrayLike<number>, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invert3(m: ArrayLike<number>): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as number[];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

/** Rotate the three columns of `r` by the rotation vector `w` (axis times angle, in camera space). */
function rotateColumns(r: number[], w: V3): number[] {
  const angle = Math.hypot(w[0], w[1], w[2]);
  if (angle < 1e-12) return r.slice();
  const k: V3 = [w[0] / angle, w[1] / angle, w[2] / angle];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out: number[] = [];
  for (let col = 0; col < 3; col++) {
    const v: V3 = [r[col * 3], r[col * 3 + 1], r[col * 3 + 2]];
    const kv = crossV(k, v);
    const kd = dot(k, v) * (1 - c);
    out.push(v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd);
  }
  return out;
}

/** Make three nearly-perpendicular columns exactly a rotation again, keeping the first two as they are as far as possible. */
function orthonormalise(r: number[]): number[] {
  const x0 = normV([r[0], r[1], r[2]]);
  const z0 = normV([r[6], r[7], r[8]]);
  // split the error evenly between the two in-plane axes (they are measured equally well)
  const sum = normV([x0[0] + z0[0], x0[1] + z0[1], x0[2] + z0[2]]);
  const dif = normV([x0[0] - z0[0], x0[1] - z0[1], x0[2] - z0[2]]);
  const s = Math.SQRT1_2;
  const x: V3 = [(sum[0] + dif[0]) * s, (sum[1] + dif[1]) * s, (sum[2] + dif[2]) * s];
  const z: V3 = [(sum[0] - dif[0]) * s, (sum[1] - dif[1]) * s, (sum[2] - dif[2]) * s];
  const y = crossV(z, x);
  return [...x, ...y, ...z];
}

/* ------------------------------------------------------------------ */
/* projection                                                           */
/* ------------------------------------------------------------------ */

/** Pixels per unit of "tangent" for a picture of this size and field of view (across the shorter side). */
export function focalPixels(width: number, height: number, fovDeg: number): number {
  return Math.min(width, height) / 2 / Math.tan((Math.min(179, Math.max(1, fovDeg)) * Math.PI) / 360);
}

/** The marker's corners in the world, in marker widths: top-left, top-right, bottom-right, bottom-left (x, z). */
export const MARKER_CORNERS: readonly Pt[] = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];

/** A world point (marker widths) to picture pixels. Null behind the camera. */
export function projectPoint(pose: Pick<MarkerPose, 'r' | 't'>, p: V3, width: number, height: number, fovDeg: number): Pt | null {
  const { r, t } = pose;
  const cx = r[0] * p[0] + r[3] * p[1] + r[6] * p[2] + t[0];
  const cy = r[1] * p[0] + r[4] * p[1] + r[7] * p[2] + t[1];
  const cz = r[2] * p[0] + r[5] * p[1] + r[8] * p[2] + t[2];
  if (cz <= 1e-9) return null;
  const f = focalPixels(width, height, fovDeg);
  return [width / 2 + (f * cx) / cz, height / 2 - (f * cy) / cz];
}

function residuals(r: number[], t: V3, pts: readonly Pt[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = MARKER_CORNERS[i];
    const cz = Math.max(1e-6, r[2] * u + r[8] * v + t[2]);
    out.push((r[0] * u + r[6] * v + t[0]) / cz - pts[i][0], (r[1] * u + r[7] * v + t[1]) / cz - pts[i][1]);
  }
  return out;
}
const sumSq = (v: number[]): number => v.reduce((a, b) => a + b * b, 0);

/** A few damped Gauss-Newton steps on the reprojection error (in tangent units). */
function refine(r0: number[], t0: V3, pts: readonly Pt[]): { r: number[]; t: V3; cost: number } {
  let r = r0;
  let t = t0;
  let res = residuals(r, t, pts);
  let cost = sumSq(res);
  let lambda = 1e-3;
  const eps = 1e-6;
  for (let iter = 0; iter < 12; iter++) {
    const J: number[][] = [];
    for (let k = 0; k < 6; k++) {
      const w: V3 = [0, 0, 0];
      const dt: V3 = [0, 0, 0];
      if (k < 3) w[k] = eps;
      else dt[k - 3] = eps;
      const rr = k < 3 ? rotateColumns(r, w) : r;
      const tt: V3 = [t[0] + dt[0], t[1] + dt[1], t[2] + dt[2]];
      const rs = residuals(rr, tt, pts);
      J.push(rs.map((v, i) => (v - res[i]) / eps));
    }
    const JtJ: number[] = new Array(36).fill(0);
    const Jtr: number[] = new Array(6).fill(0);
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 6; b++) for (let i = 0; i < 8; i++) JtJ[a * 6 + b] += J[a][i] * J[b][i];
      for (let i = 0; i < 8; i++) Jtr[a] -= J[a][i] * res[i];
    }
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = JtJ.slice();
      for (let a = 0; a < 6; a++) A[a * 6 + a] *= 1 + lambda;
      const d = solveLinear(A, Jtr, 6);
      if (!d) {
        lambda *= 10;
        continue;
      }
      const rr = rotateColumns(r, [d[0], d[1], d[2]]);
      const tt: V3 = [t[0] + d[3], t[1] + d[4], t[2] + d[5]];
      const rs = residuals(rr, tt, pts);
      const c = sumSq(rs);
      if (c < cost && tt[2] > 0) {
        improved = true;
        const gain = cost - c;
        r = rr;
        t = tt;
        res = rs;
        cost = c;
        lambda = Math.max(1e-9, lambda * 0.3);
        if (gain < 1e-16) return { r: orthonormalise(r), t, cost };
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  return { r: orthonormalise(r), t, cost };
}

/** The camera looks at the marker's face (not at its back, through the table). */
const facesCamera = (r: number[], t: V3): boolean => r[3] * t[0] + r[4] * t[1] + r[5] * t[2] < 0;

/**
 * The pose of the marker from its four corners (top-left, top-right, bottom-right, bottom-left, in pixels of a `width` x `height`
 * picture that is NOT mirrored).
 *
 * A flat square seen from far away or head-on has two poses that explain the picture almost equally well (tilted towards you or
 * away from you: the well-known "planar pose ambiguity"). Both are computed; the one that fits the corners better wins, and when
 * they fit about equally `prior` (the pose of the frame before) decides, so the object does not flip while tracking.
 */
export function poseFromCorners(corners: readonly Pt[], width: number, height: number, fovDeg: number, prior?: Pick<MarkerPose, 'r' | 't'> | null): MarkerPose | null {
  const f = focalPixels(width, height, fovDeg);
  // to tangent units with y up, so the camera is the identity
  const pts: Pt[] = corners.map((c) => [(c[0] - width / 2) / f, -(c[1] - height / 2) / f]);
  const H = homography(MARKER_CORNERS, pts);
  if (!H) return null;
  // H = s [x-axis, z-axis, t]: the first two columns are the camera-space directions of the marker's right and top edges
  const h1: V3 = [H[0], H[3], H[6]];
  const h2: V3 = [H[1], H[4], H[7]];
  const h3: V3 = [H[2], H[5], H[8]];
  let s = 2 / (Math.hypot(...h1) + Math.hypot(...h2));
  if (!Number.isFinite(s)) return null;
  // the marker is in front of the camera
  if (h3[2] * s < 0) s = -s;
  const x: V3 = [h1[0] * s, h1[1] * s, h1[2] * s];
  const z: V3 = [h2[0] * s, h2[1] * s, h2[2] * s];
  const t: V3 = [h3[0] * s, h3[1] * s, h3[2] * s];
  const first = refine(orthonormalise([...x, ...crossV(z, x), ...z]), t, pts);
  // the other candidate: the marker's face mirrored across the line of sight (half a turn about it, and half a turn in its own plane)
  const v = normV(first.t);
  const half = (a: ArrayLike<number>): V3 => {
    const d = 2 * dot(a, v);
    return [d * v[0] - a[0], d * v[1] - a[1], d * v[2] - a[2]];
  };
  const fx = half([first.r[0], first.r[1], first.r[2]]);
  const fy = half([first.r[3], first.r[4], first.r[5]]);
  const fz = half([first.r[6], first.r[7], first.r[8]]);
  const second = refine([-fx[0], -fx[1], -fx[2], fy[0], fy[1], fy[2], -fz[0], -fz[1], -fz[2]], first.t, pts);
  const toPx = (c: number): number => Math.sqrt(c / 4) * f;
  const cands = [first, second].filter((c) => c.t[2] > 0 && facesCamera(c.r, c.t)).map((c) => ({ r: c.r, t: c.t, error: toPx(c.cost) }));
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const [a, b] = cands[0].error <= cands[1].error ? cands : [cands[1], cands[0]];
  // the two are the same pose: nothing to choose
  if (rotationAngle(a.r, b.r) < 0.02) return a;
  if (prior) {
    // While tracking, stay with the pose next to the last one. With four corners both poses can fit a noisy picture to a fraction
    // of a pixel, so "fits a little better" means nothing; only a clearly better fit (a real change of view) overrules the past.
    const [near, other] = rotationAngle(a.r, prior.r) <= rotationAngle(b.r, prior.r) ? [a, b] : [b, a];
    const side = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) + Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1]);
    return other.error < near.error * 0.3 && near.error - other.error > 0.004 * side ? other : near;
  }
  return a;
}

/** Angle in radians between two rotations (stored as three columns). */
export function rotationAngle(a: number[], b: number[]): number {
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += a[i] * b[i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

/* ------------------------------------------------------------------ */
/* camera value                                                         */
/* ------------------------------------------------------------------ */

export interface WorldOptions {
  fov: number;
  /** Width of the marker in scene units. */
  markerWidth: number;
  /** Height of the marker's plane in the scene (0 = through the origin; -0.55 = the underside of the standard cube). */
  floor: number;
}

/** The scene camera for a pose: where the phone is and how it is turned, in the world described at the top of this file. */
export function cameraFromPose(pose: Pick<MarkerPose, 'r' | 't'>, o: WorldOptions): CameraValue {
  const { r, t } = pose;
  const s = o.markerWidth;
  // camera position = minus the marker position, turned back into world axes
  const position: V3 = [-(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]) * s, -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]) * s + o.floor, -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]) * s];
  const right: V3 = [r[0], r[3], r[6]];
  const forward: V3 = [r[2], r[5], r[8]];
  // look at a point as far away as the marker, so the target is near it (only the direction matters to the 3D nodes)
  const d = Math.max(1e-3, Math.hypot(t[0], t[1], t[2]) * s);
  const target: V3 = [position[0] + forward[0] * d, position[1] + forward[1] * d, position[2] + forward[2] * d];
  // roll: the angle from the roll-free right axis to the wanted one, measured towards the up axis (as lib/motion-rig.ts does)
  const b = cameraBasis({ position, target, roll: 0 });
  const roll = (Math.atan2(dot(right, b.up), dot(right, b.right)) * 180) / Math.PI;
  return { kind: 'camera', projection: 'perspective', fov: o.fov, orthoSize: 2.8, position, target, roll, shift: [0, 0] };
}

/** The reverse of `cameraFromPose`, for tests and for drawing: the pose of a scene camera that looks at a marker at the origin. */
export function poseFromCamera(cam: Pick<CameraValue, 'position' | 'target' | 'roll'>, o: Pick<WorldOptions, 'markerWidth' | 'floor'>): MarkerPose {
  const b = cameraBasis(cam);
  const r = [b.right[0], b.up[0], b.forward[0], b.right[1], b.up[1], b.forward[1], b.right[2], b.up[2], b.forward[2]];
  const c: V3 = [cam.position[0] / o.markerWidth, (cam.position[1] - o.floor) / o.markerWidth, cam.position[2] / o.markerWidth];
  const t: V3 = [-dot(b.right, c), -dot(b.up, c), -dot(b.forward, c)];
  return { r, t, error: 0 };
}

/** A camera that sees nothing of the scene: far away and looking further away. Used while the marker is not found. */
export function awayCamera(fov: number): CameraValue {
  return { kind: 'camera', projection: 'perspective', fov, orthoSize: 2.8, position: [0, 1e6, 0], target: [0, 2e6, 0], roll: 0, shift: [0, 0] };
}

/* ------------------------------------------------------------------ */
/* smoothing                                                            */
/* ------------------------------------------------------------------ */

export type Quat = [number, number, number, number];

export function quatFromColumns(r: number[]): Quat {
  // matrix entries m[row][col] = r[col * 3 + row]
  const m00 = r[0], m10 = r[1], m20 = r[2], m01 = r[3], m11 = r[4], m21 = r[5], m02 = r[6], m12 = r[7], m22 = r[8];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function columnsFromQuat(q: Quat): number[] {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
}

/** Spherical interpolation, the short way round. */
export function slerp(a: Quat, b: Quat, k: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = d < 0 ? -1 : 1;
  d = Math.min(1, Math.abs(d));
  const th = Math.acos(d);
  let wa = 1 - k;
  let wb = k;
  if (th > 1e-5) {
    const s = Math.sin(th);
    wa = Math.sin((1 - k) * th) / s;
    wb = Math.sin(k * th) / s;
  }
  const q: Quat = [a[0] * wa + b[0] * wb * sign, a[1] * wa + b[1] * wb * sign, a[2] * wa + b[2] * wb * sign, a[3] * wa + b[3] * wb * sign];
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** What the live smoother remembers between frames. Plain data. */
export interface SmoothState {
  t: V3;
  q: Quat;
  /** Smoothed velocity (marker widths per second) and turning rate (radians per second, as a rotation vector). */
  vt: V3;
  vr: V3;
}

/**
 * Live smoothing that does not trail badly: a "one euro" filter, on the marker's position and on its rotation separately. While the
 * phone is nearly still it smooths strongly (that is when jitter shows); the faster it moves the less it smooths, so the object keeps
 * up with the picture. `amount` 0 = off, 1 = very calm. `dt` in seconds.
 */
export function smoothStep(prev: SmoothState | null, pose: Pick<MarkerPose, 'r' | 't'>, dt: number, amount: number): SmoothState {
  let q = quatFromColumns(pose.r);
  if (!prev || amount <= 0) return { t: [...pose.t] as V3, q, vt: [0, 0, 0], vr: [0, 0, 0] };
  // no time went by (the same frame asked for twice): nothing to add
  if (!(dt > 1e-6)) return prev;
  if (q[0] * prev.q[0] + q[1] * prev.q[1] + q[2] * prev.q[2] + q[3] * prev.q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  const alpha = (hz: number): number => 1 - Math.exp(-2 * Math.PI * hz * dt);
  const a = Math.min(1, amount);
  // cut-off while still: 12 Hz (barely any smoothing) down to 0.25 Hz
  const base = 0.25 + 12 * (1 - a) ** 3;
  // The speed is smoothed as a direction, not as a size: jitter points a different way every frame and so cancels out, a real move
  // keeps its direction and adds up. That is what lets the filter tell the two apart.
  const ad = alpha(1);
  const vt: V3 = [0, 0, 0];
  const vr: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    vt[k] = prev.vt[k] + ((pose.t[k] - prev.t[k]) / dt - prev.vt[k]) * ad;
    // small-angle rotation vector between the two quaternions
    vr[k] = prev.vr[k] + ((2 * (q[k] - prev.q[k])) / dt - prev.vr[k]) * ad;
  }
  // measured against the distance to the marker, so the same hand movement counts the same near and far
  const depth = Math.max(0.2, Math.hypot(...pose.t));
  const kt = alpha(base + (10 * Math.hypot(...vt)) / depth);
  const kr = alpha(base + 8 * Math.hypot(...vr));
  return {
    t: [prev.t[0] + (pose.t[0] - prev.t[0]) * kt, prev.t[1] + (pose.t[1] - prev.t[1]) * kt, prev.t[2] + (pose.t[2] - prev.t[2]) * kt],
    q: slerp(prev.q, q, kr),
    vt,
    vr,
  };
}

/** Weighted mean of poses (for the zero-lag smoothing of an analysed clip). Weights need not sum to 1. */
export function blendPoses(poses: readonly Pick<MarkerPose, 'r' | 't'>[], weights: readonly number[]): { r: number[]; t: V3 } | null {
  let sw = 0;
  const t: V3 = [0, 0, 0];
  const q: Quat = [0, 0, 0, 0];
  let ref: Quat | null = null;
  // start from the heaviest pose so the signs of the quaternions are aligned to the one that matters most
  let heavy = -1;
  for (let i = 0; i < poses.length; i++) if (weights[i] > 0 && (heavy < 0 || weights[i] > weights[heavy])) heavy = i;
  if (heavy < 0) return null;
  ref = quatFromColumns(poses[heavy].r);
  for (let i = 0; i < poses.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    sw += w;
    for (let k = 0; k < 3; k++) t[k] += poses[i].t[k] * w;
    const qi = quatFromColumns(poses[i].r);
    const sign = qi[0] * ref[0] + qi[1] * ref[1] + qi[2] * ref[2] + qi[3] * ref[3] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) q[k] += qi[k] * w * sign;
  }
  const l = Math.hypot(...q);
  if (!(sw > 0) || l < 1e-9) return null;
  return { r: columnsFromQuat([q[0] / l, q[1] / l, q[2] / l, q[3] / l]), t: [t[0] / sw, t[1] / sw, t[2] / sw] };
}
