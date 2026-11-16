/**
 * Maths of splat rendering as plain TypeScript: the reference the GPU shaders are tested against, plus the pieces that run on the CPU
 * (camera set-up, back-to-front sort, view snapping, the occlusion-compatible order of a picture grid).
 *
 * FORMULAS (all in the tool's frame: x right, y up, z into the screen; pixels are measured from the frame centre, y up)
 *
 *   view vector      t = (d.right, d.up, d.fwd),  d = P - cameraPosition
 *   perspective      f = (short / 2) / tan(fov / 2)                    pixels per unit of x/z
 *                    centre_px = (t.xy / (t.z tanH) + 2 shift) * short / 2
 *                    Jacobian rows (clamped x' = clamp(t.x / t.z), y' likewise):  T0 = (f / t.z) right - (f x' / t.z) fwd,
 *                                                                                   T1 = (f / t.z) up    - (f y' / t.z) fwd
 *   orthographic     f = (short / 2) / orthoHalf,  centre_px = (t.xy / orthoHalf + 2 shift) * short / 2,  T0 = f right, T1 = f up
 *   2D covariance    S = [[T0 Σ T0, T0 Σ T1], [T0 Σ T1, T1 Σ T1]]        (EWA splatting: J W Σ Wᵀ Jᵀ, with W folded into T)
 *   low pass         S += 0.3 I   (px²);  opacity *= sqrt(det S0 / det S)    (Mip-Splatting compensation, optional)
 *   eigen            mid = (a + c) / 2, r = sqrt(((a - c) / 2)² + b²), λ1 = mid + r, λ2 = det / λ1,  major axis angle = atan2(2b, a - c) / 2
 *   quad             half extents K sqrt(λ) with K = min(3.3, sqrt(2 ln(255 α)))  (3.3 σ leaves 1/255 of the opacity at the edge), each
 *                    clamped to `maxPix`; fragment alpha = α exp(-0.5 (u² + v²)) with (u, v) the corner in σ units
 *   Σ of a splat     Σ = M Mᵀ, M = A R(q) diag(scale * size)  (A = object matrix incl. orientation and scale)
 */
import type { CameraValue } from '../types';
import { cameraBasis, type V3 } from './gen-camera';

export type M3 = number[]; // row-major 3x3

/** Rotation matrix (row-major) of a unit quaternion (w, x, y, z). */
export function quatToMat3(w: number, x: number, y: number, z: number): M3 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

export function mul3(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
export const transpose3 = (a: M3): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
export const apply3 = (a: M3, v: V3): V3 => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Σ = M Mᵀ with M = A R diag(s), in world space. `A` row-major, `s` already includes the size multiplier. */
export function worldCovariance(A: M3, q: [number, number, number, number], s: V3): M3 {
  const R = quatToMat3(q[0], q[1], q[2], q[3]);
  const AR = mul3(A, R);
  const M = [AR[0] * s[0], AR[1] * s[1], AR[2] * s[2], AR[3] * s[0], AR[4] * s[1], AR[5] * s[2], AR[6] * s[0], AR[7] * s[1], AR[8] * s[2]];
  return mul3(M, transpose3(M));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Camera                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface ViewSetup {
  pos: V3;
  right: V3;
  up: V3;
  fwd: V3;
  persp: boolean;
  tanH: number;
  orthoHalf: number;
  width: number;
  height: number;
  /** 2 x lens shift (the `uf` offset of the family's ray set-up). */
  shift: [number, number];
  near: number;
  /** True when the camera's lens (fisheye, panoramic, cylindrical) was replaced by a perspective one. */
  lensFallback: boolean;
}

export const SPLAT_NEAR = 0.02;

/** Splats follow the family's camera. Perspective and orthographic are exact; other lenses fall back to a perspective lens of 5..120 deg. */
export function viewSetup(cam: CameraValue, width: number, height: number): ViewSetup {
  const b = cameraBasis(cam);
  const ortho = cam.projection === 'orthographic';
  const persp = cam.projection === 'perspective';
  const fov = persp ? Math.min(179, Math.max(1, cam.fov)) : cam.fov >= 5 && cam.fov <= 120 ? cam.fov : 60;
  return {
    pos: b.position,
    right: b.right,
    up: b.up,
    fwd: b.forward,
    persp: !ortho,
    tanH: Math.tan((fov * Math.PI) / 360),
    orthoHalf: Math.max(0.001, cam.orthoSize) / 2,
    width,
    height,
    shift: [cam.shift[0] * 2, cam.shift[1] * 2],
    near: SPLAT_NEAR,
    lensFallback: !ortho && !persp,
  };
}

export interface ProjectedSplat {
  ok: boolean;
  /** Pixels from the frame centre, y up. */
  centre: [number, number];
  /** Screen covariance (xx, xy, yy) in px², before the low-pass. */
  cov: [number, number, number];
  /** Distance along the ray (perspective) or along the view axis (orthographic): what the depth output stores. */
  depth: number;
}

export function projectRef(v: ViewSetup, cw: V3, sigma: M3): ProjectedSplat {
  const d: V3 = [cw[0] - v.pos[0], cw[1] - v.pos[1], cw[2] - v.pos[2]];
  const t: V3 = [dot3(d, v.right), dot3(d, v.up), dot3(d, v.fwd)];
  const short = Math.min(v.width, v.height);
  let T0: V3;
  let T1: V3;
  let centre: [number, number];
  let depth: number;
  if (!v.persp) {
    const f = short / 2 / v.orthoHalf;
    centre = [(t[0] / v.orthoHalf + v.shift[0]) * (short / 2), (t[1] / v.orthoHalf + v.shift[1]) * (short / 2)];
    T0 = [v.right[0] * f, v.right[1] * f, v.right[2] * f];
    T1 = [v.up[0] * f, v.up[1] * f, v.up[2] * f];
    depth = t[2];
  } else {
    if (t[2] < v.near) return { ok: false, centre: [0, 0], cov: [0, 0, 0], depth: 0 };
    const f = short / 2 / v.tanH;
    centre = [(t[0] / (t[2] * v.tanH) + v.shift[0]) * (short / 2), (t[1] / (t[2] * v.tanH) + v.shift[1]) * (short / 2)];
    const spx = v.shift[0] * (short / 2);
    const spy = v.shift[1] * (short / 2);
    const x = Math.min(Math.max(t[0] / t[2], (-0.65 * v.width - spx) / f), (0.65 * v.width - spx) / f);
    const y = Math.min(Math.max(t[1] / t[2], (-0.65 * v.height - spy) / f), (0.65 * v.height - spy) / f);
    const iz = 1 / t[2];
    T0 = [0, 1, 2].map((k) => v.right[k] * f * iz - v.fwd[k] * f * x * iz) as V3;
    T1 = [0, 1, 2].map((k) => v.up[k] * f * iz - v.fwd[k] * f * y * iz) as V3;
    depth = Math.hypot(d[0], d[1], d[2]);
  }
  const s0 = apply3(sigma, T0);
  const s1 = apply3(sigma, T1);
  return { ok: true, centre, cov: [dot3(T0, s0), dot3(T1, s0), dot3(T1, s1)], depth };
}

export interface QuadRef {
  alpha: number;
  lambda1: number;
  lambda2: number;
  /** Major axis direction (unit, screen, y up). */
  axis1: [number, number];
  axis2: [number, number];
  /** Half extents of the quad along each axis, px. */
  ext1: number;
  ext2: number;
}

/** Low pass, compensation, eigen-decomposition and quad extents of a projected covariance (Gaussian shape). */
export function quadRef(cov: [number, number, number], opacity: number, o: { antialias: boolean; maxPix: number }): QuadRef | null {
  const det0 = Math.max(cov[0] * cov[2] - cov[1] * cov[1], 0);
  const a = cov[0] + 0.3;
  const c = cov[2] + 0.3;
  const b = cov[1];
  const det1 = a * c - b * b;
  const alpha = o.antialias ? opacity * Math.sqrt(det0 / det1) : opacity;
  if (alpha < 1 / 255) return null;
  const mid = (a + c) / 2;
  const r = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const l1 = mid + r;
  const l2 = Math.max(det1 / l1, 1e-4);
  const ang = 0.5 * Math.atan2(2 * b, a - c);
  const axis1: [number, number] = [Math.cos(ang), Math.sin(ang)];
  const K = Math.min(3.3, Math.sqrt(2 * Math.log(Math.max(255 * alpha, 1.0001))));
  return { alpha, lambda1: l1, lambda2: l2, axis1, axis2: [-axis1[1], axis1[0]], ext1: Math.min(K * Math.sqrt(l1), o.maxPix), ext2: Math.min(K * Math.sqrt(l2), o.maxPix) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Sorting                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface SortView {
  /** Camera position in the cloud's own (file) space, snapped. */
  pos: V3;
  /** Unit view direction in file space, snapped. */
  fwd: V3;
  persp: boolean;
  /** Splats nearer than this (file-space depth) are left out of the order. */
  near: number;
  key: string;
}

/**
 * The view of a sort, in the FILE frame of the cloud, snapped to a grid so that every camera inside one cell gives the SAME key and
 * therefore the same sort (a pure function of the key: the cache can never change what a render produces). Position grid = radius / 512,
 * direction grid = 1/1024 per component (about 0.06 degrees).
 *
 * `A` (row-major) and `t` map file space to the world: world = A (p - c) + t, A = s Q with Q orthogonal (any rotation or reflection).
 */
export function sortView(view: ViewSetup, A: M3, t: V3, c: V3, radius: number): SortView {
  const s2 = A[0] * A[0] + A[1] * A[1] + A[2] * A[2];
  const s = Math.sqrt(s2);
  const At = transpose3(A);
  const toFile = (w: V3): V3 => {
    const q = apply3(At, [w[0] - t[0], w[1] - t[1], w[2] - t[2]]);
    return [q[0] / s2 + c[0], q[1] / s2 + c[1], q[2] / s2 + c[2]];
  };
  const g = Math.max(radius / 512, 1e-9);
  const snapP = (p: V3): V3 => [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g, Math.round(p[2] / g) * g];
  const f0 = apply3(At, view.fwd);
  const fl = Math.hypot(...f0) || 1;
  const fi: V3 = [Math.round((f0[0] / fl) * 1024), Math.round((f0[1] / fl) * 1024), Math.round((f0[2] / fl) * 1024)];
  const fn = Math.hypot(...fi) || 1;
  const fwd: V3 = [fi[0] / fn, fi[1] / fn, fi[2] / fn];
  if (view.persp) {
    const pos = snapP(toFile(view.pos));
    return { pos, fwd, persp: true, near: view.near / s, key: `p|${pos.map((v) => Math.round(v / g)).join(',')}|${fi.join(',')}` };
  }
  return { pos: [0, 0, 0], fwd, persp: false, near: -Infinity, key: `o|${fi.join(',')}` };
}

export interface SortScratch {
  keys: Uint16Array;
  depth: Float32Array;
  counts: Uint32Array;
}

export const newSortScratch = (n: number): SortScratch => ({ keys: new Uint16Array(n), depth: new Float32Array(n), counts: new Uint32Array(65536) });

/**
 * Back-to-front order of splat centres by depth along the view direction: a 16-bit counting sort (a depth pass, a key pass, a scatter
 * pass, and one prefix sum over the 65,536 buckets). Depth is quantised between the nearest and farthest included splat; ties keep index
 * order, so the result is a pure function of (positions, view). Splats in front of the near plane are not part of the order (and not drawn).
 */
export function sortBackToFront(positions: Float32Array, n: number, v: SortView, scratch?: SortScratch): { order: Uint32Array; count: number } {
  const s = scratch && scratch.keys.length >= n && scratch.depth.length >= n ? scratch : newSortScratch(n);
  const { keys, depth, counts } = s;
  counts.fill(0);
  const [cx, cy, cz] = v.pos;
  const [fx, fy, fz] = v.fwd;
  const base = cx * fx + cy * fy + cz * fz;
  const near = v.persp ? v.near : -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const d = positions[p] * fx + positions[p + 1] * fy + positions[p + 2] * fz - base;
    depth[i] = d;
    if (d < near) continue;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  if (!(hi >= lo)) return { order: new Uint32Array(0), count: 0 };
  const k = 65535 / Math.max(hi - lo, 1e-20);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    if (d < near) continue;
    const key = 65535 - Math.min(65535, Math.floor((d - lo) * k)); // far first
    keys[i] = key;
    counts[key]++;
    m++;
  }
  let sum = 0;
  for (let b = 0; b < 65536; b++) {
    const c = counts[b];
    counts[b] = sum;
    sum += c;
  }
  const order = new Uint32Array(m);
  for (let i = 0; i < n; i++) {
    if (depth[i] < near) continue;
    order[counts[keys[i]]++] = i;
  }
  return { order, count: m };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Picture grids: occlusion-compatible order (McMillan)                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface AxisOrder {
  /** Cells before this index lie on the near-origin side of the epipole. */
  split: number;
  /** +1 = from the outside towards the epipole (farthest first), -1 = the reverse. */
  dir: number;
}

/** Instance position k -> cell index along one axis of n cells. Mirrors `axisIndex` in the shader. */
export function axisIndex(k: number, n: number, o: AxisOrder): number {
  const kk = o.dir < 0 ? n - 1 - k : k;
  return kk < o.split ? kk : n - 1 - (kk - o.split);
}

/**
 * Drawing order for a picture whose pixels were unprojected through a CAPTURE camera and are drawn from another camera: an
 * occlusion-compatible traversal of the grid (rows outer, columns inner, each from the outside towards the epipole, the projection of
 * the new camera's centre into the picture) draws every surface sample before any sample that hides it. Exact for a single-layer depth
 * picture, needs no depth buffer and no sort, so it works on video frames. If the new camera is behind the picture plane the direction
 * reverses; an orthographic capture camera always uses outside-in; an orthographic new camera puts the epipole at infinity.
 */
export function pictureOrder(
  capture: ViewSetup,
  view: ViewSetup,
  grid: { w: number; h: number; imgW: number; imgH: number },
): { x: AxisOrder; y: AxisOrder } {
  const ishort = Math.min(grid.imgW, grid.imgH);
  const BIG = 1e7;
  // Epipole in picture pixels (centre origin, y up) and the direction rule
  let ex: number;
  let ey: number;
  let dir = 1;
  const toFrame = (w: V3): V3 => [dot3(w, capture.right), dot3(w, capture.up), dot3(w, capture.fwd)];
  if (view.persp) {
    const d: V3 = [view.pos[0] - capture.pos[0], view.pos[1] - capture.pos[1], view.pos[2] - capture.pos[2]];
    const p = toFrame(d);
    if (capture.persp) {
      const z = Math.abs(p[2]) < 1e-9 ? 1e-9 : p[2];
      ex = (p[0] / (z * capture.tanH) + capture.shift[0]) * (ishort / 2);
      ey = (p[1] / (z * capture.tanH) + capture.shift[1]) * (ishort / 2);
      dir = z > 0 ? 1 : -1;
    } else {
      ex = (p[0] / capture.orthoHalf + capture.shift[0]) * (ishort / 2);
      ey = (p[1] / capture.orthoHalf + capture.shift[1]) * (ishort / 2);
    }
  } else {
    // new camera at infinity, looking along view.fwd
    const f = toFrame(view.fwd);
    if (capture.persp) {
      const z = Math.abs(f[2]) < 1e-9 ? 1e-9 : f[2];
      ex = (f[0] / (z * capture.tanH) + capture.shift[0]) * (ishort / 2);
      ey = (f[1] / (z * capture.tanH) + capture.shift[1]) * (ishort / 2);
      dir = z > 0 ? -1 : 1;
    } else {
      ex = -Math.sign(f[0] || 1) * BIG;
      ey = -Math.sign(f[1] || 1) * BIG;
    }
  }
  const clampPx = (v: number) => Math.max(-BIG, Math.min(BIG, v));
  ex = clampPx(ex);
  ey = clampPx(ey);
  // picture pixel -> grid cell coordinates: u = 0.5 + x / imgW, v = 0.5 - y / imgH
  const gx = (0.5 + ex / grid.imgW) * grid.w;
  const gy = (0.5 - ey / grid.imgH) * grid.h;
  const split = (e: number, n: number) => Math.min(n, Math.max(0, Math.ceil(e - 0.5)));
  return { x: { split: split(gx, grid.w), dir }, y: { split: split(gy, grid.h), dir } };
}
