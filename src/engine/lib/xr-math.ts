/**
 * World AR maths (pure): from what the browser's AR (WebXR) reports to the app's 3D camera, and the few bits of geometry the AR view
 * draws with.
 *
 * Two sets of axes meet here and every conversion between them is in this file:
 *  - WebXR: metres, x right, y up, the viewer looks along MINUS z (right-handed).
 *  - The app's 3D scene (see gen-camera.ts): scene units, x right, y up, z INTO the screen (left-handed). The default camera stands on
 *    -z and looks along +z, so the side of an object the default camera sees faces -z.
 * A point goes from one to the other by flipping z. Nothing else changes, so "up" stays up and a metre stays a metre until the
 * placement's size is applied.
 *
 * The placed object owns the scene: its anchor point on the real surface is the scene's ground point, the surface normal is the
 * scene's up, and the camera is expressed relative to it. Moving, turning or resizing the object in the room therefore moves the
 * CAMERA of the graph the other way; the object itself always sits at the origin of the scene, where every 3D node puts it.
 */
import type { CameraValue } from '../types';
import { cameraBasis } from './gen-camera';
import { qAxisAngle, qConj, qMul, qNorm, rotate, type Quat, type Vec3 } from './motion-math';

/** A position and orientation in WebXR axes (metres). */
export interface XrPose {
  p: Vec3;
  q: Quat;
}

/**
 * The four numbers of a WebXR projection matrix that describe the lens: elements 0, 5, 8 and 9 of the column-major matrix.
 * [0] and [5] are 1 / tan(half the horizontal / vertical field of view); [8] and [9] are how far the optical centre is off the middle
 * of the picture. Near and far planes are left out: the app's 3D nodes do not use them.
 */
export type Lens = [number, number, number, number];

/** Where the object stands in the room. */
export interface Placement {
  /** The point on the real surface, WebXR axes, metres. */
  p: Vec3;
  /** The surface's frame: its y axis is the surface normal (straight up for a floor or a table). */
  q: Quat;
  /** Turn about the normal, degrees (the two-finger twist). */
  yaw: number;
  /** Size multiplier (the pinch). 1 = the node's "Object size". */
  scale: number;
}

/** How the scene is laid on the placement (the World AR Camera node's own settings). */
export interface SceneFit {
  /** Metres per scene unit at scale 1. */
  unit: number;
  /** How far above the surface the scene's origin floats, in scene units (1 stands a 2-unit-high object on the surface). */
  lift: number;
}

export const IDENTITY_POSE: XrPose = { p: [0, 0, 0], q: [0, 0, 0, 1] };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** WebXR axes to scene axes (and back: it is its own inverse). */
export const flipZ = (v: Vec3): Vec3 => [v[0], v[1], -v[2]];

/** The lens numbers of a projection matrix (16 numbers, column-major, as `XRView.projectionMatrix`). */
export function lensOf(projection: ArrayLike<number>): Lens {
  return [projection[0], projection[5], projection[8], projection[9]];
}

/** Width / height of the picture the lens was made for. */
export const lensAspect = (lens: Lens): number => (lens[0] > 1e-9 ? lens[1] / lens[0] : 1);

/** `a` then `b`'s frame: the pose of something that sits at `b` inside the frame `a`. */
export function poseMul(a: XrPose, b: XrPose): XrPose {
  return { p: add(a.p, rotate(a.q, b.p)), q: qNorm(qMul(a.q, b.q)) };
}
export function poseInv(a: XrPose): XrPose {
  const qi = qConj(qNorm(a.q));
  return { p: mul(rotate(qi, a.p), -1), q: qi };
}

/** The placement's full orientation: the surface frame turned by the twist. */
export function placementQuat(pl: Pick<Placement, 'q' | 'yaw'>): Quat {
  return qNorm(qMul(pl.q, qAxisAngle('y', pl.yaw)));
}

/**
 * The twist that turns the object's front (the side the default camera of the 3D nodes sees) towards a viewer standing at `viewer`.
 * The front faces the placement's own +z in WebXR axes (-z of the scene), so the twist is the heading of the viewer seen from the
 * surface point, measured in the surface's own frame.
 */
export function yawFacing(surface: XrPose, viewer: Vec3): number {
  const v = rotate(qConj(qNorm(surface.q)), sub(viewer, surface.p));
  if (Math.hypot(v[0], v[2]) < 1e-6) return 0;
  return (Math.atan2(v[0], v[2]) * 180) / Math.PI;
}

/**
 * Field of view and lens shift of the app's camera for a WebXR lens, for a picture of `width` x `height`.
 * The app measures the field of view across the picture's shorter side and the shift in units of that side (gen-3d.ts: a point at
 * camera-space (x, y, z) lands at ((x / z) / tan(fov / 2) + 2 * shift) * short / 2 pixels from the middle). WebXR puts it at
 * (lens[0] * x / z - lens[2]) * w / 2. Setting the two equal gives the lines below. When the picture's shape differs from the lens's,
 * the lens's picture is fitted inside (nothing cut off), which is how a clip recorded with the lens is fitted too.
 */
export function lensFor(lens: Lens, width: number, height: number): { fov: number; shift: [number, number] } {
  const a = lensAspect(lens);
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  const w = W / H >= a ? H * a : W;
  const h = W / H >= a ? H : W / a;
  const short = Math.min(W, H);
  const fovTan = short / (w * Math.max(1e-6, lens[0]));
  return { fov: (2 * Math.atan(fovTan) * 180) / Math.PI, shift: [(-lens[2] * w) / (2 * short), (-lens[3] * h) / (2 * short)] };
}

/** A camera from its position and axes in scene axes. The roll is whatever makes the camera's right axis the given one. */
export function cameraFromAxes(position: Vec3, forward: Vec3, right: Vec3, lens: { fov: number; shift: [number, number] }): CameraValue {
  const f = unit(forward);
  const target = add(position, f);
  const b = cameraBasis({ position, target, roll: 0 });
  const roll = (Math.atan2(dot(right, b.up), dot(right, b.right)) * 180) / Math.PI;
  return { kind: 'camera', projection: 'perspective', fov: lens.fov, orthoSize: 2.8, position, target, roll, shift: lens.shift };
}

/**
 * The app camera for a WebXR view, relative to the placed object. This is the function everything hangs on: the live AR view, the
 * recorded take and the pixel test all go through it.
 */
export function worldCamera(view: XrPose, lens: Lens, placement: Placement, fit: SceneFit, canvas: { width: number; height: number }): CameraValue {
  const qi = qConj(placementQuat(placement));
  const k = 1 / Math.max(1e-6, placement.scale * fit.unit);
  // the camera in the placement's own frame, in scene units, still in WebXR axes
  const local = sub(mul(rotate(qi, sub(view.p, placement.p)), k), [0, fit.lift, 0]);
  const vq = qNorm(view.q);
  const forward = rotate(qi, rotate(vq, [0, 0, -1]));
  const right = rotate(qi, rotate(vq, [1, 0, 0]));
  return cameraFromAxes(flipZ(local), flipZ(forward), flipZ(right), lensFor(lens, canvas.width, canvas.height));
}

/** Where a scene point (scene axes, scene units) is in the room (WebXR axes, metres). The inverse of what `worldCamera` does to the camera. */
export function sceneToWorld(point: Vec3, placement: Placement, fit: SceneFit): Vec3 {
  const local = mul(add(flipZ(point), [0, fit.lift, 0]), placement.scale * fit.unit);
  return add(placement.p, rotate(placementQuat(placement), local));
}

/** A camera that sees nothing of the scene: far away and looking away. Used while nothing is placed yet. */
export function awayCamera(): CameraValue {
  return { kind: 'camera', projection: 'perspective', fov: 40, orthoSize: 2.8, position: [0, 0, -1e6], target: [0, 0, -2e6], roll: 0, shift: [0, 0] };
}

/* ------------------------------------------------------------------ geometry the AR view draws with */

/** The four corners of a rectangle in the room, in the order bottom-left, bottom-right, top-left, top-right. */
export type Corners = [Vec3, Vec3, Vec3, Vec3];

/** A point of the view's picture (-1..1 across and up) pushed `depth` metres into the room along the view. */
export function unproject(view: XrPose, lens: Lens, ndcX: number, ndcY: number, depth: number): Vec3 {
  const v: Vec3 = [((ndcX + lens[2]) * depth) / lens[0], ((ndcY + lens[3]) * depth) / lens[1], -depth];
  return add(view.p, rotate(qNorm(view.q), v));
}

/** Where a point of the room lands in the view's picture (-1..1), or null when it is behind the viewer. */
export function project(view: XrPose, lens: Lens, point: Vec3): [number, number] | null {
  const v = rotate(qConj(qNorm(view.q)), sub(point, view.p));
  const d = -v[2];
  if (d <= 1e-6) return null;
  return [(lens[0] * v[0]) / d - lens[2], (lens[1] * v[1]) / d - lens[3]];
}

/** How far in front of the viewer a point is (metres along the viewing direction). */
export function depthOf(view: XrPose, point: Vec3): number {
  return -rotate(qConj(qNorm(view.q)), sub(point, view.p))[2];
}

/**
 * The picture of the object was rendered for the view `rendered`, but it is shown a frame or two later, when the phone has moved on.
 * Instead of gluing it to the screen (it would swim), it is hung in the room as a rectangle that exactly fills the lens of the view
 * it was rendered for, at the object's distance. Seen from that same view it covers the screen; seen from the new one it is where the
 * object really is. Exact for turning the phone, and for moving it as far as the object is flat at that distance.
 */
export function layerCorners(rendered: XrPose, lens: Lens, depth: number): Corners {
  const d = Math.max(0.05, depth);
  return [unproject(rendered, lens, -1, -1, d), unproject(rendered, lens, 1, -1, d), unproject(rendered, lens, -1, 1, d), unproject(rendered, lens, 1, 1, d)];
}

export type CardMode = 'upright' | 'flat' | 'billboard';

/**
 * A picture as a card in the room: `width` metres wide (times the placement's scale), `aspect` = width / height.
 * upright: stands on the surface, facing the way the placement faces. flat: lies on the surface, its top away from the front.
 * billboard: stands on the surface and turns about the normal to face `viewer`.
 */
export function cardCorners(placement: Placement, mode: CardMode, width: number, aspect: number, viewer: Vec3): Corners {
  const w = (width * placement.scale) / 2;
  const h = (width * placement.scale) / Math.max(1e-6, aspect);
  const q = mode === 'billboard' ? placementQuat({ q: placement.q, yaw: yawFacing({ p: placement.p, q: placement.q }, viewer) }) : placementQuat(placement);
  const at = (x: number, y: number, z: number): Vec3 => add(placement.p, rotate(q, [x, y, z]));
  // the front faces +z: a viewer standing on +z and looking back at the card has the placement's +x on their right
  if (mode === 'flat') return [at(-w, 0, h / 2), at(w, 0, h / 2), at(-w, 0, -h / 2), at(w, 0, -h / 2)];
  return [at(-w, 0, 0), at(w, 0, 0), at(-w, h, 0), at(w, h, 0)];
}

/** The ring that shows where the object would land: a square of `radius` metres lying on the surface. */
export function reticleCorners(surface: XrPose, radius: number): Corners {
  const at = (x: number, z: number): Vec3 => add(surface.p, rotate(qNorm(surface.q), [x, 0, z]));
  return [at(-radius, radius), at(radius, radius), at(-radius, -radius), at(radius, -radius)];
}

/** The ray into the room through a point of the view's picture (-1..1). */
export function viewRay(view: XrPose, lens: Lens, ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
  return { origin: view.p, dir: unit(sub(unproject(view, lens, ndcX, ndcY, 1), view.p)) };
}

/** Where a ray meets a plane, or null when it runs away from it, alongside it, or meets it more than `maxDistance` metres away. */
export function rayPlane(origin: Vec3, dir: Vec3, point: Vec3, normal: Vec3, maxDistance = 20): Vec3 | null {
  const dn = dot(dir, normal);
  if (Math.abs(dn) < 1e-5) return null;
  const t = dot(sub(point, origin), normal) / dn;
  if (t <= 0 || t > maxDistance) return null;
  return add(origin, mul(dir, t));
}

/* ------------------------------------------------------------------ 4x4 matrices (column-major, as WebGL and WebXR use them) */

export function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/** The view matrix (room to viewer) of a pose. */
export function viewMatrix(view: XrPose): Float32Array {
  const qi = qConj(qNorm(view.q));
  const x = rotate(qi, [1, 0, 0]);
  const y = rotate(qi, [0, 1, 0]);
  const z = rotate(qi, [0, 0, 1]);
  const t = mul(rotate(qi, view.p), -1);
  return new Float32Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t[0], t[1], t[2], 1]);
}

/** A full projection matrix for a lens (only used where the browser did not hand one over: tests and the take). */
export function projectionMatrix(lens: Lens, near = 0.05, far = 100): Float32Array {
  return new Float32Array([lens[0], 0, 0, 0, 0, lens[1], 0, 0, lens[2], lens[3], (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
}

/** A symmetric lens from a vertical field of view in degrees and the picture's width / height. */
export function lensFromFov(fovYDeg: number, aspect: number): Lens {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  return [f / aspect, f, 0, 0];
}
