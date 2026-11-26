/**
 * The data of a 3D scan taken with the phone (the "3D Scan" node's `scan` param), pure. A later exporter (COLMAP and friends) is
 * written against EXACTLY this format, so it is versioned and every reader goes through `normalizeScan`.
 *
 *  - World space is the WebXR reference space of the session that took the scan, metres, +Y up, as the phone reports it.
 *  - `quat` is the camera-to-world rotation in the WebXR convention: the camera looks down its -Z axis, +Y is up in the picture, +X is right.
 *    (A computer-vision camera looks down +Z with Y pointing down: that is the same rotation turned half a turn about X.)
 *  - `fx fy cx cy` are pinhole intrinsics in pixels of the STORED still, origin top-left, x right, y down:
 *        u = fx * Xc / Zc + cx      v = fy * Yc / Zc + cy      with (Xc, Yc, Zc) = camera-space point, y down, z forward
 *    They come from the projection matrix of the XR view (see `intrinsicsFromProjection`), because the WebXR camera object carries no
 *    intrinsics of its own. The camera picture is taken to fill the view exactly (the way the AR painter draws it), so the matrix
 *    terms apply to the picture's own width and height. No lens distortion is modelled (the picture is as the phone hands it over).
 */
import { qConj, qNorm, rotate, type Quat, type Vec3 } from './motion-math';

export const SCAN_VERSION = 1 as const;
/** The longer side of a stored still never exceeds this (and a still is never scaled up). */
export const SCAN_MAX_SIDE = 1920;
export const SCAN_JPEG_QUALITY = 0.92;
/** Most photos one scan keeps (bounds the memory the photos use before they are saved). */
export const SCAN_MAX_SHOTS = 200;
export const DEFAULT_GRID = { az: 24, el: 6 } as const;
export const DEFAULT_RADIUS = 0.5;
export const MIN_RADIUS = 0.1;
export const MAX_RADIUS = 5;

export interface ScanTarget {
  center: Vec3;
  radius: number;
  /** The surface normal at the tap: (0, 1, 0) on a floor. */
  up: Vec3;
  /** Optional: how far the centre was lifted off the surface, metres (the scan view uses it to know which low rows can be reached). */
  h?: number;
}

export interface ScanShot {
  /** Media asset id of the still (JPEG). */
  asset: string;
  /** Seconds since the scan started. */
  t: number;
  pos: Vec3;
  quat: Quat;
  w: number;
  h: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** 0..1 sharpness. */
  sharp: number;
  /** A low-resolution depth map, `encodeDepth` form (only when the device gave depth). */
  depth?: string;
}

export interface ScanData {
  v: 1;
  units: 'm';
  target: ScanTarget;
  grid: { az: number; el: number };
  shots: ScanShot[];
  /** Optional: how many photos the scan view left out for being blurry (for the quality summary; the exporter can ignore it). */
  rejected?: number;
}

export const emptyScan = (): ScanData => ({ v: SCAN_VERSION, units: 'm', target: { center: [0, 0, 0], radius: DEFAULT_RADIUS, up: [0, 1, 0] }, grid: { ...DEFAULT_GRID }, shots: [] });

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const vec3 = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null);
const unitVec = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
};

/** Is this stored value a scan with at least a target (even without photos)? */
export function isScanData(v: unknown): v is ScanData {
  return !!v && typeof v === 'object' && (v as { v?: unknown }).v === SCAN_VERSION && !!vec3((v as { target?: { center?: unknown } }).target?.center);
}

/**
 * Any stored value as a valid scan. Bad photos are dropped (a missing asset, a pose that is not numbers, a size of zero), numbers are
 * clamped, quaternions and the up vector normalised. Anything that is not a scan gives the empty scan. Never throws.
 */
export function normalizeScan(raw: unknown): ScanData {
  if (!isScanData(raw)) return emptyScan();
  const r = raw as unknown as Record<string, any>;
  const center = vec3(r.target.center)!;
  const up = unitVec(vec3(r.target.up) ?? [0, 1, 0]);
  const az = Math.round(clamp(num(r.grid?.az, DEFAULT_GRID.az), 4, 72));
  const el = Math.round(clamp(num(r.grid?.el, DEFAULT_GRID.el), 1, 24));
  const shots: ScanShot[] = [];
  for (const s of Array.isArray(r.shots) ? r.shots : []) {
    if (!s || typeof s !== 'object' || typeof s.asset !== 'string' || !s.asset) continue;
    const pos = vec3(s.pos);
    const q = Array.isArray(s.quat) && s.quat.length === 4 && s.quat.every((x: unknown) => typeof x === 'number' && Number.isFinite(x)) ? (s.quat as Quat) : null;
    const w = num(s.w, 0);
    const h = num(s.h, 0);
    const fx = num(s.fx, 0);
    const fy = num(s.fy, 0);
    if (!pos || !q || !(w > 0) || !(h > 0) || !(fx > 0) || !(fy > 0)) continue;
    const quat = qNorm(q);
    const out: ScanShot = { asset: s.asset, t: Math.max(0, num(s.t, 0)), pos, quat, w: Math.round(w), h: Math.round(h), fx, fy, cx: num(s.cx, w / 2), cy: num(s.cy, h / 2), sharp: clamp(num(s.sharp, 0), 0, 1) };
    if (typeof s.depth === 'string' && s.depth) out.depth = s.depth;
    shots.push(out);
  }
  return { v: SCAN_VERSION, units: 'm', target: { center, radius: clamp(num(r.target.radius, DEFAULT_RADIUS), MIN_RADIUS, MAX_RADIUS), up, ...(typeof r.target.h === 'number' && Number.isFinite(r.target.h) ? { h: r.target.h } : {}) }, grid: { az, el }, shots: shots.slice(0, SCAN_MAX_SHOTS * 2), ...(typeof r.rejected === 'number' && r.rejected > 0 ? { rejected: Math.round(r.rejected) } : {}) };
}

/** Pixel size of the stored still for a camera picture of this size: the longer side at most `SCAN_MAX_SIDE`, never scaled up. */
export function stillSize(width: number, height: number, maxSide = SCAN_MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, maxSide / Math.max(1, width, height));
  return { w: Math.max(2, Math.round(width * k)), h: Math.max(2, Math.round(height * k)) };
}

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/**
 * Pinhole intrinsics, in pixels of a w x h picture, from the 16 numbers (column-major) of a WebXR projection matrix.
 *
 * A point at camera-space (X, Y, Z) with the WebXR axes (x right, y up, looking down -Z), distance d = -Z, lands at
 *   ndc.x = m[0] * X / d - m[8]        ndc.y = m[5] * Y / d - m[9]
 * and the picture pixel is  u = (ndc.x + 1) / 2 * w,  v = (1 - ndc.y) / 2 * h  (y down). So
 *   fx = m[0] * w / 2    cx = (1 - m[8]) * w / 2
 *   fy = m[5] * h / 2    cy = (1 + m[9]) * h / 2
 * The camera picture is assumed to fill the whole view (stretched to it if its shape differs by a hair), which is how the AR
 * painter lays it over the view. The terms m[8] and m[9] are the principal point's offset from the middle of the picture.
 */
export function intrinsicsFromProjection(m: ArrayLike<number>, w: number, h: number): Intrinsics {
  return { fx: (m[0] * w) / 2, fy: (m[5] * h) / 2, cx: ((1 - m[8]) * w) / 2, cy: ((1 + m[9]) * h) / 2 };
}

/** Where a world point lands in a shot's picture (pixels, y down), or null when it is behind the camera. The exporter's check. */
export function projectToShot(shot: Pick<ScanShot, 'pos' | 'quat' | 'fx' | 'fy' | 'cx' | 'cy'>, point: Vec3): [number, number] | null {
  const c = rotate(qConj(qNorm(shot.quat)), [point[0] - shot.pos[0], point[1] - shot.pos[1], point[2] - shot.pos[2]]); // WebXR camera axes
  const z = -c[2];
  if (z <= 1e-6) return null;
  return [(shot.fx * c[0]) / z + shot.cx, (shot.fy * -c[1]) / z + shot.cy]; // y down
}

/* ------------------------------------------------------------------ depth maps */

/** A depth map as the WebXR depth API gives it, already a plain array. */
export interface DepthMap {
  width: number;
  height: number;
  /** Metres per unit of the stored values. */
  rawValueToMeters: number;
  /** 16 numbers, column-major: normalised view coordinates to normalised depth-buffer coordinates. */
  normDepthBufferFromNormView: number[];
  /** Row-major, 16 bits per value (0 = no measurement). */
  data: Uint16Array;
}

export const DEPTH_MAX_SIDE = 48;

/** Shrink a depth map so its longer side is at most `maxSide` (nearest sample, keeps the first row at the top). */
export function shrinkDepth(src: DepthMap, maxSide = DEPTH_MAX_SIDE): DepthMap {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (k === 1) return src;
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const data = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = src.data[Math.min(src.height - 1, Math.floor(((y + 0.5) / h) * src.height)) * src.width + Math.min(src.width - 1, Math.floor(((x + 0.5) / w) * src.width))];
  return { ...src, width: w, height: h, data };
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
};

/**
 * One compact text: `d1;width;height;rawValueToMeters;m0,m1,...,m15;base64 of the little-endian 16-bit values`. It stays inline in the
 * shot (about 1.5 to 4 KB at 48 pixels on the longer side), so the scan json needs no extra files.
 */
export function encodeDepth(d: DepthMap): string {
  const bytes = new Uint8Array(d.data.length * 2);
  for (let i = 0; i < d.data.length; i++) {
    bytes[i * 2] = d.data[i] & 255;
    bytes[i * 2 + 1] = d.data[i] >> 8;
  }
  return `d1;${d.width};${d.height};${d.rawValueToMeters};${d.normDepthBufferFromNormView.join(',')};${b64(bytes)}`;
}

/** The inverse of `encodeDepth`; null for anything else. */
export function decodeDepth(text: string): DepthMap | null {
  const p = text.split(';');
  if (p.length !== 6 || p[0] !== 'd1') return null;
  const width = Number(p[1]);
  const height = Number(p[2]);
  const rawValueToMeters = Number(p[3]);
  const normDepthBufferFromNormView = p[4].split(',').map(Number);
  if (!(width > 0) || !(height > 0) || !Number.isFinite(rawValueToMeters) || normDepthBufferFromNormView.length !== 16 || normDepthBufferFromNormView.some((v) => !Number.isFinite(v))) return null;
  let bin: string;
  try {
    bin = atob(p[5]);
  } catch {
    return null;
  }
  if (bin.length !== width * height * 2) return null;
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
  return { width, height, rawValueToMeters, normDepthBufferFromNormView, data };
}
