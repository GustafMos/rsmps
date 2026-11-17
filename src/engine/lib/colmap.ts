/**
 * COLMAP sparse models and the coordinate hand-off to this tool. Pure functions (no GPU, no DOM, no Node), tested against models
 * COLMAP 4.2.1 wrote for a synthetic scene with known cameras (src/engine/lib/colmap.test.ts).
 *
 * READING. `cameras.bin` / `images.bin` / `points3D.bin` (the mapper's binary model) and the `.txt` variants (model_converter):
 *   cameras  id, model, width, height, params (SIMPLE_PINHOLE f cx cy | PINHOLE fx fy cx cy | SIMPLE_RADIAL f cx cy k | RADIAL f cx cy k1 k2 |
 *            OPENCV fx fy cx cy k1 k2 p1 p2 | ...; only the first focal(s) and the principal point are used here)
 *   images   id, qw qx qy qz, tx ty tz, camera id, name. WORLD-TO-CAMERA: X_cam = R(q) X_world + t, camera axes x right, y DOWN, z forward
 *            (right-handed). Camera centre C = -R^T t; rows of R are the camera's right, down and forward axes in world space.
 *
 * CONVENTIONS OF THIS TOOL. World y is up and the frame is the MIRROR of a right-handed one: a camera's right x up = forward
 * (`cameraBasis` in gen-camera.ts: right = cross([0,1,0], forward)). A COLMAP world therefore cannot be mapped by a rotation alone:
 * `sceneFrame` builds M = Ry(heading) * F * Q with Q a rotation taking the estimated up direction to +y and F = diag(1, 1, -1) (the
 * mirror). det(M) = -1. Every point goes X_tool = M (X_colmap - centre); every camera axis goes a_tool = M a_colmap (right -> right, -down
 * -> up, forward -> forward), and then right x up = forward holds in the tool's frame, as `cameraBasis` needs.
 *
 * UP. COLMAP's world has no gravity. People hold cameras upright, so the cameras' RIGHT axes are close to horizontal: up is the direction
 * most perpendicular to all of them (smallest eigenvector of sum r r^T), signed to agree with the average "-down" axis. When the cameras
 * barely turn (a straight dolly) that direction is not determined and the average "-down" axis is used instead (projected off the mean
 * right axis). HEADING: the first registered camera looks along +z, like the tool's default camera.
 *
 * INTRINSICS. The tool's perspective `fov` is the angle over the frame's SHORTER side: fov = 2 atan((short / 2) / f). Lens shift is in
 * units of the shorter side, y up: shift = [(cx - W/2) / short, -(cy - H/2) / short]. fx != fy is approximated by their mean; lens
 * distortion is not represented (train on undistorted images: COLMAP's image_undistorter writes PINHOLE cameras).
 */
import type { CameraValue } from '../types';
import { finishCloud, jacobi3, rotationBetween, type Mat3, type SplatCloud } from './splat-cloud';
import type { V3 } from './gen-camera';

export class ColmapError extends Error {}

export interface ColmapCamera {
  id: number;
  model: string;
  width: number;
  height: number;
  params: number[];
}
export interface ColmapImage {
  id: number;
  /** World-to-camera rotation as a unit quaternion (w, x, y, z). */
  q: [number, number, number, number];
  t: V3;
  cameraId: number;
  name: string;
}
export interface ColmapModel {
  cameras: Map<number, ColmapCamera>;
  images: ColmapImage[];
  /** Sparse points (x y z per point), may be empty. */
  points: Float64Array;
}

/** Model id -> (name, number of params). COLMAP src/colmap/sensor/models.h. */
const MODELS: [string, number][] = [
  ['SIMPLE_PINHOLE', 3], ['PINHOLE', 4], ['SIMPLE_RADIAL', 4], ['RADIAL', 5], ['OPENCV', 8], ['OPENCV_FISHEYE', 8], ['FULL_OPENCV', 12],
  ['FOV', 5], ['SIMPLE_RADIAL_FISHEYE', 4], ['RADIAL_FISHEYE', 5], ['THIN_PRISM_FISHEYE', 12], ['RAD_TAN_THIN_PRISM_FISHEYE', 16],
];

class Reader {
  o = 0;
  readonly dv: DataView;
  constructor(readonly buf: ArrayBuffer) {
    this.dv = new DataView(buf);
  }
  need(n: number) {
    if (this.o + n > this.buf.byteLength) throw new ColmapError('The COLMAP model file is cut short.');
  }
  u8() { this.need(1); return this.dv.getUint8(this.o++); }
  u32() { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  u64() { this.need(8); const lo = this.dv.getUint32(this.o, true), hi = this.dv.getUint32(this.o + 4, true); this.o += 8; if (hi > 0x1fffff) throw new ColmapError('A count in the COLMAP model is implausibly large.'); return hi * 2 ** 32 + lo; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  str() {
    const start = this.o;
    const u8 = new Uint8Array(this.buf);
    while (this.o < u8.length && u8[this.o] !== 0) this.o++;
    if (this.o >= u8.length) throw new ColmapError('An image name in the COLMAP model is not terminated.');
    const s = new TextDecoder().decode(u8.subarray(start, this.o));
    this.o++;
    return s;
  }
}

export function parseCamerasBin(buf: ArrayBuffer): Map<number, ColmapCamera> {
  const r = new Reader(buf);
  const n = r.u64();
  const out = new Map<number, ColmapCamera>();
  for (let i = 0; i < n; i++) {
    const id = r.u32();
    const modelId = r.i32();
    const m = MODELS[modelId];
    if (!m) throw new ColmapError(`Unknown COLMAP camera model ${modelId}.`);
    const width = r.u64(), height = r.u64();
    const params = Array.from({ length: m[1] }, () => r.f64());
    out.set(id, { id, model: m[0], width, height, params });
  }
  return out;
}

export function parseImagesBin(buf: ArrayBuffer): ColmapImage[] {
  const r = new Reader(buf);
  const n = r.u64();
  const out: ColmapImage[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.u32();
    const q: [number, number, number, number] = [r.f64(), r.f64(), r.f64(), r.f64()];
    const t: V3 = [r.f64(), r.f64(), r.f64()];
    const cameraId = r.u32();
    const name = r.str();
    const np = r.u64();
    r.need(np * 24);
    r.o += np * 24; // x, y (f64) + point3D id (i64)
    out.push({ id, q, t, cameraId, name });
  }
  return out;
}

export function parsePointsBin(buf: ArrayBuffer): Float64Array {
  const r = new Reader(buf);
  const n = r.u64();
  const xyz = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    r.u64();
    xyz[i * 3] = r.f64(); xyz[i * 3 + 1] = r.f64(); xyz[i * 3 + 2] = r.f64();
    r.o += 3; // rgb
    r.f64(); // error
    const len = r.u64();
    r.need(len * 8);
    r.o += len * 8;
  }
  return xyz;
}

const dataLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

export function parseCamerasTxt(text: string): Map<number, ColmapCamera> {
  const out = new Map<number, ColmapCamera>();
  for (const l of dataLines(text)) {
    const w = l.split(/\s+/);
    const id = Number(w[0]);
    out.set(id, { id, model: w[1], width: Number(w[2]), height: Number(w[3]), params: w.slice(4).map(Number) });
  }
  return out;
}

/** images.txt has two lines per image; the second (2D points) may be EMPTY, so lines are taken in pairs from the raw text. */
export function parseImagesTxt(text: string): ColmapImage[] {
  const lines = text.split(/\r?\n/).filter((l) => !l.startsWith('#'));
  const out: ColmapImage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i].trim().split(/\s+/);
    if (w.length < 10) continue;
    out.push({ id: Number(w[0]), q: [Number(w[1]), Number(w[2]), Number(w[3]), Number(w[4])], t: [Number(w[5]), Number(w[6]), Number(w[7])], cameraId: Number(w[8]), name: w.slice(9).join(' ') });
    i++; // skip the points line
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Poses                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Row-major 3x3 times vector. */
export const mulMV = (m: Mat3 | number[], v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const mulMM = (a: Mat3 | number[], b: Mat3 | number[]): Mat3 => {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
};
export const det3 = (m: Mat3 | number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Row-major rotation matrix of a unit quaternion (w, x, y, z). */
export function quatToMat([w, x, y, z]: readonly number[]): Mat3 {
  const l = Math.hypot(w, x, y, z) || 1;
  w /= l; x /= l; y /= l; z /= l;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}

/** Unit quaternion (w, x, y, z) of a row-major rotation matrix (Shepperd). */
export function matToQuat(m: Mat3 | number[]): [number, number, number, number] {
  const tr = m[0] + m[4] + m[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const l = Math.hypot(w, x, y, z);
  return w < 0 ? [-w / l, -x / l, -y / l, -z / l] : [w / l, x / l, y / l, z / l];
}

export interface CameraPose {
  name: string;
  /** Camera centre in COLMAP world. */
  centre: V3;
  right: V3;
  down: V3;
  forward: V3;
}

export function poseOf(img: ColmapImage): CameraPose {
  const R = quatToMat(img.q);
  const right: V3 = [R[0], R[1], R[2]];
  const down: V3 = [R[3], R[4], R[5]];
  const forward: V3 = [R[6], R[7], R[8]];
  // C = -R^T t
  const t = img.t;
  const centre: V3 = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  return { name: img.name, centre, right, down, forward };
}

/** The up direction in COLMAP world (see the file comment). Needs at least one image. */
export function estimateUpFromCameras(poses: readonly CameraPose[]): { up: V3; basis: 'right-axes' | 'down-axes' } {
  if (!poses.length) throw new ColmapError('No camera poses to orient the scene with.');
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const md: V3 = [0, 0, 0];
  const mr: V3 = [0, 0, 0];
  for (const p of poses) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += p.right[i] * p.right[j];
    for (let i = 0; i < 3; i++) { md[i] -= p.down[i]; mr[i] += p.right[i]; }
  }
  const { values, vectors } = jacobi3(S.map((v) => v / poses.length));
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  const [lo, mid] = [values[order[0]], values[order[1]]];
  const minusDown = norm(md);
  // A turning camera spreads its right axes over the horizontal plane: the smallest eigenvalue is clearly the smallest.
  if (mid > 1e-9 && lo / mid < 0.25 && mid > 0.02) {
    let up = norm(vectors[order[0]] as V3);
    if (dot(up, minusDown) < 0) up = [-up[0], -up[1], -up[2]];
    return { up, basis: 'right-axes' };
  }
  const r = norm(mr);
  const k = dot(minusDown, r);
  return { up: norm([minusDown[0] - k * r[0], minusDown[1] - k * r[1], minusDown[2] - k * r[2]]), basis: 'down-axes' };
}

/** Rotation about +y by `a` radians, row-major. */
const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const MIRROR_Z: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, -1];

export interface SceneFrame {
  /** Row-major, orthogonal, det -1: COLMAP world direction -> tool direction. */
  M: Mat3;
  /** COLMAP world point that becomes the tool's origin. */
  centre: V3;
  up: V3;
  basis: 'right-axes' | 'down-axes';
}

/** Median of each axis (robust centre of the sparse points; falls back to the camera centres). */
function medianCentre(xyz: ArrayLike<number>, n: number): V3 {
  const out: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const v = Float64Array.from({ length: n }, (_, i) => xyz[i * 3 + a]).sort();
    out[a] = n ? v[n >> 1] : 0;
  }
  return out;
}

export function sceneFrame(poses: readonly CameraPose[], points?: Float64Array | null): SceneFrame {
  const { up, basis } = estimateUpFromCameras(poses);
  const Q = rotationBetween(up, [0, 1, 0]);
  let M = mulMM(MIRROR_Z, Q);
  // heading: the first camera (by name order) looks along +z
  const first = [...poses].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  const f = mulMV(M, first.forward);
  if (Math.hypot(f[0], f[2]) > 1e-6) M = mulMM(rotY(-Math.atan2(f[0], f[2])), M);
  const centre = points && points.length >= 3 ? medianCentre(points, points.length / 3) : medianCentre(poses.flatMap((p) => p.centre), poses.length);
  return { M, centre, up, basis };
}

export const toTool = (fr: SceneFrame, p: V3): V3 => mulMV(fr.M, [p[0] - fr.centre[0], p[1] - fr.centre[1], p[2] - fr.centre[2]]);

/** Focal length (px) and principal point of a camera, whatever the model. */
export function intrinsicsOf(cam: ColmapCamera): { fx: number; fy: number; cx: number; cy: number } {
  const p = cam.params;
  const two = cam.model === 'PINHOLE' || cam.model.startsWith('OPENCV') || cam.model === 'FULL_OPENCV' || cam.model === 'THIN_PRISM_FISHEYE' || cam.model === 'RAD_TAN_THIN_PRISM_FISHEYE';
  return two ? { fx: p[0], fy: p[1], cx: p[2], cy: p[3] } : { fx: p[0], fy: p[0], cx: p[1], cy: p[2] };
}

/** The tool's CameraValue that sees what COLMAP image `pose` saw (in the tool frame `fr`), for a frame of the camera's size. */
export function cameraValueOf(fr: SceneFrame, pose: CameraPose, cam: ColmapCamera): CameraValue {
  const position = toTool(fr, pose.centre);
  const forward = norm(mulMV(fr.M, pose.forward));
  const right = norm(mulMV(fr.M, pose.right));
  return cameraFromAxes(position, forward, right, cam);
}

export function cameraFromAxes(position: V3, forward: V3, right: V3, cam: Pick<ColmapCamera, 'width' | 'height' | 'model' | 'params'>): CameraValue {
  const { fx, fy, cx, cy } = intrinsicsOf(cam as ColmapCamera);
  const short = Math.min(cam.width, cam.height);
  const f = (fx + fy) / 2;
  // roll: the angle from cameraBasis' roll-free right axis to the wanted one, measured towards its up axis
  const upRef: V3 = Math.abs(forward[1]) > 0.999 ? [0, 0, forward[1] > 0 ? -1 : 1] : [0, 1, 0];
  const right0 = norm(cross(upRef, forward));
  const up0 = cross(forward, right0);
  const roll = (Math.atan2(dot(right, up0), dot(right, right0)) * 180) / Math.PI;
  return {
    kind: 'camera',
    projection: 'perspective',
    fov: (2 * Math.atan(short / 2 / f) * 180) / Math.PI,
    orthoSize: 2,
    position,
    target: [position[0] + forward[0], position[1] + forward[1], position[2] + forward[2]],
    roll,
    shift: [(cx - cam.width / 2) / short, -(cy - cam.height / 2) / short],
  };
}

/**
 * How much the camera MOVED compared with how far away the scene is: the largest distance between two camera centres divided by the median
 * camera-to-point distance (`parallax`). Splats need the camera to travel sideways; a camera that only turns on the spot (a pan) gives a
 * model COLMAP happily "solves" (every frame registered, 0.27 px reprojection error) with nothing usable to train on. Measured on the synthetic
 * stage-0 scene: a full orbit 1.62, a 100 degree arc 1.53, a 15-frame pan on the spot 0.14 (noise). `PARALLAX_FAIL` / `PARALLAX_WARN`.
 */
export const PARALLAX_FAIL = 0.15;
export const PARALLAX_WARN = 0.3;
export function solveStats(poses: readonly CameraPose[], points: Float64Array): { cameras: number; points: number; parallax: number } {
  let span = 0;
  for (let i = 0; i < poses.length; i++)
    for (let j = i + 1; j < poses.length; j++) span = Math.max(span, Math.hypot(poses[i].centre[0] - poses[j].centre[0], poses[i].centre[1] - poses[j].centre[1], poses[i].centre[2] - poses[j].centre[2]));
  const n = points.length / 3;
  const d: number[] = [];
  const step = Math.max(1, Math.floor(n / 2000));
  for (const p of poses) for (let k = 0; k < n; k += step) d.push(Math.hypot(points[k * 3] - p.centre[0], points[k * 3 + 1] - p.centre[1], points[k * 3 + 2] - p.centre[2]));
  d.sort((a, b) => a - b);
  const med = d.length ? d[d.length >> 1] : 0;
  return { cameras: poses.length, points: n, parallax: med > 0 ? span / med : 0 };
}

/**
 * Least-squares similarity Y ~ s R X + t (Umeyama 1991; R a proper rotation). For tests and evaluation: comparing solved cameras with a
 * ground truth that lives in another frame.
 */
export function fitSimilarity(X: readonly V3[], Y: readonly V3[]): { s: number; R: Mat3; t: V3; rms: number } {
  const n = X.length;
  const mx = [0, 1, 2].map((k) => X.reduce((s, x) => s + x[k], 0) / n) as V3;
  const my = [0, 1, 2].map((k) => Y.reduce((s, y) => s + y[k], 0) / n) as V3;
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Mat3;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    const a = [X[i][0] - mx[0], X[i][1] - mx[1], X[i][2] - mx[2]];
    const b = [Y[i][0] - my[0], Y[i][1] - my[1], Y[i][2] - my[2]];
    vx += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += (b[r] * a[c]) / n;
  }
  vx /= n;
  const T = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  const e = jacobi3(mulMM(T(S), S));
  const ord = [0, 1, 2].sort((a, b) => e.values[b] - e.values[a]);
  const vs = ord.map((i) => norm(e.vectors[i] as V3));
  const D = ord.map((i) => Math.sqrt(Math.max(0, e.values[i])));
  const us = vs.map((v, k) => (D[k] > 1e-12 ? norm(mulMV(S, v)) : ([0, 0, 0] as V3)));
  if (D[2] <= 1e-12) us[2] = cross(us[0], us[1]);
  const V: Mat3 = [vs[0][0], vs[1][0], vs[2][0], vs[0][1], vs[1][1], vs[2][1], vs[0][2], vs[1][2], vs[2][2]];
  const U: Mat3 = [us[0][0], us[1][0], us[2][0], us[0][1], us[1][1], us[2][1], us[0][2], us[1][2], us[2][2]];
  const d = det3(U) * det3(V) < 0 ? -1 : 1;
  const R = mulMM(mulMM(U, [1, 0, 0, 0, 1, 0, 0, 0, d]), T(V));
  const s = (D[0] + D[1] + d * D[2]) / vx;
  const Rm = mulMV(R, mx);
  const t: V3 = [my[0] - s * Rm[0], my[1] - s * Rm[1], my[2] - s * Rm[2]];
  let e2 = 0;
  for (let i = 0; i < n; i++) {
    const p = mulMV(R, X[i]);
    e2 += (s * p[0] + t[0] - Y[i][0]) ** 2 + (s * p[1] + t[1] - Y[i][1]) ** 2 + (s * p[2] + t[2] - Y[i][2]) ** 2;
  }
  return { s, R, t, rms: Math.sqrt(e2 / n) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Cloud                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The cloud in the tool's frame: p' = M (p - centre). Covariances follow (Sigma' = M Sigma M^T: rotation M R, with one axis flipped when
 * det(M) < 0 so it stays a rotation) and degree-1 spherical harmonics follow the direction (the SH-1 basis is linear in the direction:
 * f(d) = C1 g.d with g = (-k2, -k0, k1) per channel, so g' = M g).
 */
export function transformCloud(cloud: SplatCloud, fr: Pick<SceneFrame, 'M' | 'centre'>, upHint: '+y' | null = '+y'): SplatCloud {
  const n = cloud.count;
  const M = fr.M;
  const flip = det3(M) < 0;
  const positions = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4);
  const sh1 = cloud.sh1 ? new Float32Array(n * 9) : null;
  for (let i = 0; i < n; i++) {
    const p = toTool(fr as SceneFrame, [cloud.positions[i * 3], cloud.positions[i * 3 + 1], cloud.positions[i * 3 + 2]]);
    positions.set(p, i * 3);
    let R = mulMM(M, quatToMat([cloud.rotations[i * 4], cloud.rotations[i * 4 + 1], cloud.rotations[i * 4 + 2], cloud.rotations[i * 4 + 3]]));
    if (flip) R = [R[0], R[1], -R[2], R[3], R[4], -R[5], R[6], R[7], -R[8]];
    rotations.set(matToQuat(R), i * 4);
    if (sh1 && cloud.sh1) {
      for (let c = 0; c < 3; c++) {
        const k = [cloud.sh1[i * 9 + c * 3], cloud.sh1[i * 9 + c * 3 + 1], cloud.sh1[i * 9 + c * 3 + 2]];
        const g = mulMV(M, [-k[2], -k[0], k[1]]);
        sh1[i * 9 + c * 3] = -g[1];
        sh1[i * 9 + c * 3 + 1] = g[2];
        sh1[i * 9 + c * 3 + 2] = -g[0];
      }
    }
  }
  return finishCloud({ count: n, positions, scales: cloud.scales.slice(), rotations, colors: cloud.colors.slice(), opacity: cloud.opacity.slice(), sh1, shDegreeInFile: cloud.shDegreeInFile, upHint }, cloud.source);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Camera path over time                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A solved camera at a clip time, in the tool frame (what the node stores and animates). */
export interface PathKey {
  seconds: number;
  position: V3;
  /** Unit quaternion (w, x, y, z) of the rotation whose columns are right, up, forward (a proper rotation in the tool's frame). */
  q: [number, number, number, number];
}
export interface CameraPath {
  keys: PathKey[];
  /** Intrinsics of the frames COLMAP saw (after undistortion). */
  width: number;
  height: number;
  fov: number;
  shift: [number, number];
}

export function pathKeyOf(seconds: number, position: V3, forward: V3, right: V3): PathKey {
  const up = cross(forward, right); // right x up = forward  <=>  up = forward x right
  // columns right, up, forward; this triple satisfies right x up = forward, i.e. it is a proper rotation
  return { seconds, position, q: matToQuat([right[0], up[0], forward[0], right[1], up[1], forward[1], right[2], up[2], forward[2]]) };
}

function slerp(a: readonly number[], b: readonly number[], t: number): [number, number, number, number] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b.slice();
  d = Math.abs(d);
  if (d > 0.9995) {
    const o = a.map((v, i) => v + (bb[i] - v) * t);
    const l = Math.hypot(...o);
    return o.map((v) => v / l) as [number, number, number, number];
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => wa * v + wb * bb[i]) as [number, number, number, number];
}

/** The path at `seconds` (held before the first and after the last key; positions linear, rotations slerped). */
export function cameraAt(path: CameraPath, seconds: number): { position: V3; forward: V3; right: V3 } | null {
  const k = path.keys;
  if (!k.length) return null;
  let i = 0;
  while (i < k.length - 1 && k[i + 1].seconds <= seconds) i++;
  const a = k[i];
  const b = k[Math.min(i + 1, k.length - 1)];
  const t = b.seconds > a.seconds ? Math.min(1, Math.max(0, (seconds - a.seconds) / (b.seconds - a.seconds))) : 0;
  const q = slerp(a.q, b.q, t);
  const R = quatToMat(q);
  return {
    position: [a.position[0] + (b.position[0] - a.position[0]) * t, a.position[1] + (b.position[1] - a.position[1]) * t, a.position[2] + (b.position[2] - a.position[2]) * t],
    right: [R[0], R[3], R[6]],
    forward: [R[2], R[5], R[8]],
  };
}
