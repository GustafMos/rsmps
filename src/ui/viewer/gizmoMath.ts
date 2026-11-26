/**
 * The maths behind the on-picture handles for 3D objects (XformGizmo.tsx). Pure: no DOM, no GPU.
 *
 * Everything here mirrors what the 3D nodes' shaders do (lib/gen-camera.ts, RAY_WGSL and the frame mapping in lib/gen-3d.ts), run the
 * other way round: the shader turns a pixel into a ray, the gizmo needs to know where a point of the scene lands in the picture, and
 * which point of the scene a finger on the picture means. A GPU test (gizmo-gpu.test.ts) checks this against really rendered pixels.
 *
 * Frame coordinates: x and y from 0 to 1 across the picture, y down (the way the pointer sees it).
 * World: x right, y up, z into the screen (see gen-camera.ts).
 */
import { cameraBasis, type V3 } from '../../engine/lib/gen-camera';
import { rotationZYX } from '../../engine/lib/gen-common';
import type { CameraValue } from '../../engine/types';

export type { V3 };
/** Row-major 3x3. */
export type M3 = number[];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mulS = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const DEG = Math.PI / 180;

/** A camera with a frame, with the same numbers (and the same clamps) the shaders receive. */
export interface Lens {
  projection: CameraValue['projection'];
  pos: V3;
  right: V3;
  up: V3;
  fwd: V3;
  fovTan: number;
  fovRad: number;
  orthoHalf: number;
  shift: [number, number];
  width: number;
  height: number;
}

export function lensOf(cam: CameraValue, width: number, height: number): Lens {
  const b = cameraBasis(cam);
  return {
    projection: cam.projection,
    pos: b.position,
    right: b.right,
    up: b.up,
    fwd: b.forward,
    fovTan: Math.tan((Math.min(cam.projection === 'fisheye' ? 359 : 179, Math.max(1, cam.fov)) * Math.PI) / 360),
    fovRad: (Math.min(360, Math.max(1, cam.fov)) * Math.PI) / 180,
    orthoHalf: Math.max(0.001, cam.orthoSize) / 2,
    shift: [cam.shift[0], cam.shift[1]],
    width,
    height,
  };
}

/** Orthographic and perspective keep straight lines straight, so dragging in "the plane of the screen" is exact for them. */
export const isRectilinear = (l: Lens): boolean => l.projection === 'orthographic' || l.projection === 'perspective';

const cylTan = (l: Lens) => Math.tan(Math.min(1.5, Math.max(0.01, l.fovRad * 0.5)));

/** The viewing ray through a point of the frame, or null where the lens shows nothing (outside a fisheye circle). */
export function rayAt(l: Lens, fx: number, fy: number): { ro: V3; rd: V3 } | null {
  const short = Math.min(l.width, l.height);
  // centred pixels, y up: the same `p`, `uf` and `ff` as frameUV / rayAt in the shaders
  const px = (fx - 0.5) * l.width;
  const py = -(fy - 0.5) * l.height;
  const ufx = px / (short * 0.5) - l.shift[0] * 2;
  const ufy = py / (short * 0.5) - l.shift[1] * 2;
  const ffx = px / (l.width * 0.5) - (l.shift[0] * 2 * short) / l.width;
  const ffy = py / (l.height * 0.5) - (l.shift[1] * 2 * short) / l.height;
  const along = (f: number, r: number, u: number): V3 => add(add(mulS(l.fwd, f), mulS(l.right, r)), mulS(l.up, u));
  const unit = (v: V3): V3 => mulS(v, 1 / (len(v) || 1));
  switch (l.projection) {
    case 'orthographic':
      return { ro: add(l.pos, add(mulS(l.right, ufx * l.orthoHalf), mulS(l.up, ufy * l.orthoHalf))), rd: l.fwd };
    case 'perspective':
      return { ro: l.pos, rd: unit(along(1, ufx * l.fovTan, ufy * l.fovTan)) };
    case 'fisheye': {
      const r = Math.hypot(ufx, ufy);
      if (r > 1) return null;
      const th = r * l.fovRad * 0.5;
      const dx = r > 1e-6 ? ufx / r : 0;
      const dy = r > 1e-6 ? ufy / r : 0;
      return { ro: l.pos, rd: along(Math.cos(th), dx * Math.sin(th), dy * Math.sin(th)) };
    }
    case 'panoramic': {
      const lon = ffx * Math.PI;
      const lat = ffy * Math.PI * 0.5;
      return { ro: l.pos, rd: along(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)) };
    }
    default: {
      const lon = ffx * Math.PI;
      return { ro: l.pos, rd: unit(along(Math.cos(lon), Math.sin(lon), ffy * cylTan(l))) };
    }
  }
}

export interface Projected {
  /** Frame coordinates (0..1, y down). Can lie outside 0..1 when the point is out of the picture. */
  x: number;
  y: number;
  /** Distance from the camera along its viewing direction (orthographic, perspective) or along the ray (the others). */
  depth: number;
  /** False when the lens cannot show the point (behind a perspective camera, outside a fisheye circle). */
  visible: boolean;
}

/** Where a point of the scene lands in the picture: the inverse of `rayAt`. */
export function projectPoint(l: Lens, p: V3): Projected {
  const d = sub(p, l.pos);
  const x = dot(d, l.right);
  const y = dot(d, l.up);
  const z = dot(d, l.fwd);
  const dist = len(d);
  const short = Math.min(l.width, l.height);
  const fromUf = (ufx: number, ufy: number, depth: number, visible: boolean): Projected => ({
    x: 0.5 + ((ufx + l.shift[0] * 2) * short * 0.5) / l.width,
    y: 0.5 - ((ufy + l.shift[1] * 2) * short * 0.5) / l.height,
    depth,
    visible,
  });
  const fromFf = (ffx: number, ffy: number, visible: boolean): Projected => ({
    x: 0.5 + (ffx + (l.shift[0] * 2 * short) / l.width) * 0.5,
    y: 0.5 - (ffy + (l.shift[1] * 2 * short) / l.height) * 0.5,
    depth: dist,
    visible,
  });
  switch (l.projection) {
    case 'orthographic':
      return fromUf(x / l.orthoHalf, y / l.orthoHalf, z, true);
    case 'perspective': {
      const zz = Math.max(z, 1e-4);
      return fromUf(x / (zz * l.fovTan), y / (zz * l.fovTan), z, z > 1e-4);
    }
    case 'fisheye': {
      const th = Math.acos(Math.max(-1, Math.min(1, z / (dist || 1))));
      const r = th / (l.fovRad * 0.5);
      const h = Math.hypot(x, y);
      return fromUf(h > 1e-9 ? (x / h) * r : 0, h > 1e-9 ? (y / h) * r : 0, dist, r <= 1 && dist > 1e-6);
    }
    case 'panoramic':
      return fromFf(Math.atan2(x, z) / Math.PI, Math.asin(Math.max(-1, Math.min(1, y / (dist || 1)))) / (Math.PI * 0.5), dist > 1e-6);
    default: {
      const flat = Math.hypot(x, z);
      return fromFf(Math.atan2(x, z) / Math.PI, y / (flat || 1e-9) / cylTan(l), flat > 1e-6);
    }
  }
}

/**
 * How large a thing of `worldRadius` at `p` looks, as a fraction of the picture's shorter side (so 0.5 = it spans the whole short side).
 * Exact for orthographic and perspective, by angle for the wide lenses.
 */
export function screenRadius(l: Lens, p: V3, worldRadius: number): number {
  const d = sub(p, l.pos);
  const dist = len(d) || 1e-6;
  switch (l.projection) {
    case 'orthographic':
      return (worldRadius / l.orthoHalf) * 0.5;
    case 'perspective':
      return (worldRadius / (Math.max(dot(d, l.fwd), 1e-4) * l.fovTan)) * 0.5;
    case 'fisheye':
      return (Math.atan(worldRadius / dist) / (l.fovRad * 0.5)) * 0.5;
    case 'panoramic':
      return (Math.atan(worldRadius / dist) / Math.PI) * (l.height / Math.min(l.width, l.height));
    default:
      return (worldRadius / (Math.hypot(dot(d, l.right), dot(d, l.fwd)) || 1e-6) / cylTan(l)) * 0.5 * (l.height / Math.min(l.width, l.height));
  }
}

/**
 * Drag an object: the finger went down at `grab` and is now at `now` (frame coordinates). The object keeps its offset from the finger.
 * Orthographic / perspective: it slides in the plane through `p0` that faces the camera, so its distance into the picture does not
 * change. Fisheye, panorama, cylinder: it keeps its distance from the camera instead (their "screen plane" is a sphere).
 * Returns null when the finger is somewhere the lens does not look.
 */
export function dragMove(l: Lens, p0: V3, grab: { x: number; y: number }, now: { x: number; y: number }): V3 | null {
  const c = projectPoint(l, p0);
  const ray = rayAt(l, c.x + (now.x - grab.x), c.y + (now.y - grab.y));
  if (!ray) return null;
  if (isRectilinear(l)) {
    const denom = dot(ray.rd, l.fwd);
    if (denom < 1e-6) return null;
    const t = dot(sub(p0, ray.ro), l.fwd) / denom;
    if (!(t > 0) && l.projection === 'perspective') return null;
    return add(ray.ro, mulS(ray.rd, t));
  }
  return add(ray.ro, mulS(ray.rd, len(sub(p0, l.pos))));
}

/**
 * Push away (`factor` > 1) or pull closer (< 1). With perspective the object travels along its own line of sight, so it stays under
 * the handle and only gets smaller or larger. An orthographic camera shows no depth: the object moves along the viewing direction.
 */
export function dragDepth(l: Lens, p: V3, factor: number): V3 {
  if (l.projection === 'orthographic') return add(p, mulS(l.fwd, Math.log(Math.max(1e-3, factor)) * 2));
  const d = sub(p, l.pos);
  const dist = len(d);
  if (dist < 1e-6) return add(p, mulS(l.fwd, 0.2));
  // never through the camera: keep at least a small distance in front of it
  const next = Math.max(0.2, dist * factor);
  return add(l.pos, mulS(d, next / dist));
}

/** The factor for `dragDepth` from a vertical drag in screen pixels: up = away. 150 px doubles or halves the distance. */
export const depthFactorForDrag = (dyPx: number): number => Math.exp(-dyPx / 216);
/** ...and from mouse-wheel movement: wheel up (negative delta) = away. */
export const depthFactorForWheel = (deltaY: number): number => Math.exp(-Math.max(-400, Math.min(400, deltaY)) * 0.0015);

/* -------------------------------------------------------------------------- */
/* Rotation                                                                    */
/* -------------------------------------------------------------------------- */

export const mul3 = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
export const apply3 = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/** Rotation by `rad` about a (not necessarily unit) axis, in the same sense as rotationZYX's own axes (Rodrigues). */
export function axisAngle(axis: V3, rad: number): M3 {
  const n = len(axis);
  if (n < 1e-12 || Math.abs(rad) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n];
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

export type Euler = [number, number, number];

const nearAngle = (deg: number, ref: number): number => deg + 360 * Math.round((ref - deg) / 360);

/**
 * The Rotate X / Y / Z (degrees) that give matrix `m` in the 3D nodes' convention: `rotationZYX`, i.e. turn about X first, then Y,
 * then Z, each about the fixed scene axes. A rotation has many such triples; this returns the one closest to `near` (the values the
 * fields show now), so the numbers move smoothly under the finger instead of jumping by 180 or 360 degrees. Each angle stays inside
 * `limit` (the fields' range).
 */
export function eulerZYX(m: M3, near: Euler = [0, 0, 0], limit = 360): Euler {
  const sy = Math.max(-1, Math.min(1, -m[6]));
  let a: Euler;
  let b: Euler;
  if (Math.abs(sy) > 0.999999) {
    // looking straight down the Y turn: X and Z turn about the same line, so keep Z where it is and put everything in X
    const z = near[2] * DEG;
    const y = (sy > 0 ? 90 : -90) * DEG;
    // m = Rz Ry Rx  =>  Rx = Ry^-1 Rz^-1 m
    const rx = mul3(mul3(axisAngle([0, 1, 0], -y), axisAngle([0, 0, 1], -z)), m);
    const x = Math.atan2(rx[7], rx[4]);
    a = b = [x / DEG, y / DEG, near[2]];
  } else {
    const y = Math.asin(sy);
    const x = Math.atan2(m[7], m[8]);
    const z = Math.atan2(m[3], m[0]);
    a = [x / DEG, y / DEG, z / DEG];
    b = [x / DEG + 180, 180 - y / DEG, z / DEG + 180]; // the same rotation, reached the other way round
  }
  const fit = (e: Euler): { e: Euler; cost: number } => {
    const out = e.map((v, i) => {
      let w = nearAngle(v, near[i]);
      while (w > limit) w -= 360;
      while (w < -limit) w += 360;
      return w;
    }) as Euler;
    return { e: out, cost: Math.abs(out[0] - near[0]) + Math.abs(out[1] - near[1]) + Math.abs(out[2] - near[2]) };
  };
  const fa = fit(a);
  const fb = fit(b);
  return fa.cost <= fb.cost ? fa.e : fb.e;
}

/** The object's rotation matrix for its Rotate X / Y / Z (object space to scene). */
export const matrixOf = (rot: Euler): M3 => rotationZYX(rot[0], rot[1], rot[2]);

/**
 * Free "trackball" turn. The finger has moved (dxPx, dyPx) on screen (y down) since it went down on an object whose handle circle is
 * `radiusPx` large: the object turns as if the finger held the side of it that faces the camera, so that side follows the finger
 * (a drag to the right turns the front of the object to the right). `rot0` = the rotation when the finger went down; the result is
 * the same wherever the finger wandered in between, so coming back to the start restores the start exactly.
 */
export function turnTrackball(l: Pick<Lens, 'right' | 'up' | 'fwd'>, rot0: Euler, dxPx: number, dyPx: number, radiusPx: number, near: Euler = rot0): Euler {
  const dUp = -dyPx;
  const d = Math.hypot(dxPx, dUp);
  if (d < 1e-9) return rot0;
  // the axis lies in the screen, across the drag: axis x (towards the camera) must point along the drag
  const axis = add(mulS(l.right, dUp), mulS(l.up, -dxPx));
  return eulerZYX(mul3(axisAngle(axis, d / Math.max(1, radiusPx)), matrixOf(rot0)), near);
}

/** Turn about the line of sight by `rad` (positive = counter-clockwise as seen on screen): the outer ring of the gizmo. */
export function turnRoll(l: Pick<Lens, 'fwd'>, rot0: Euler, rad: number, near: Euler = rot0): Euler {
  return eulerZYX(mul3(axisAngle(l.fwd, rad), matrixOf(rot0)), near);
}

/** Angle of a screen point about a centre, counter-clockwise, y down on screen. */
export const screenAngle = (cx: number, cy: number, x: number, y: number): number => Math.atan2(-(y - cy), x - cx);
/** The step from angle `a` to angle `b`, the short way round (so a ring drag can cross the +-180 seam). */
export const angleStep = (a: number, b: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/** Uniform size from a corner handle: the finger was `d0` px from the centre and is now `d1` px away. */
export function dragScale(s0: number, d0: number, d1: number, min = 0.01, max = 20): number {
  if (d0 < 1) return s0;
  return Math.min(max, Math.max(min, s0 * (Math.max(1, d1) / d0)));
}

/** Where the object's own X / Y / Z axes point on screen (unit length 1 = in the screen plane; shorter = towards or away from you). */
export function axisTriad(l: Pick<Lens, 'right' | 'up'>, rot: Euler): [number, number][] {
  const m = matrixOf(rot);
  return [0, 1, 2].map((i) => {
    const col: V3 = [m[i], m[3 + i], m[6 + i]];
    return [dot(col, l.right), -dot(col, l.up)] as [number, number];
  });
}

export const roundTo = (v: number, decimals: number): number => Number(v.toFixed(decimals));
export const clampTo = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
