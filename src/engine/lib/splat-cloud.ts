/**
 * Gaussian splats: the in-memory format shared by every splat node, the parsers' output and (later) a reconstruction process.
 *
 * `SplatCloud` is structure-of-arrays, f32, in the FILE's own coordinate frame (no orientation applied):
 *   positions  count x 3   world position
 *   scales     count x 3   LINEAR standard deviations along the splat's own axes (the .ply stores log(scale); parsers apply exp)
 *   rotations  count x 4   unit quaternion (w, x, y, z): the file's `rot_0..3` order; normalised by the parsers
 *   colors     count x 3   base (DC) colour, display-referred, nominally 0..1 (NOT clamped here: 0.5 + 0.28209479177387814 * f_dc)
 *   opacity    count       0..1 (sigmoid of the file's value)
 *   sh1        count x 9   OPTIONAL spherical-harmonics degree 1: [channel r,g,b][k = 0..2] = the file's f_rest_{c * perChannel + k}.
 *                          Higher degrees (2 and 3) are read past and DISCARDED (they cost 8 + 15 more floats per channel for a
 *                          subtle view-dependent shine; degree 1 carries most of it). `shDegreeInFile` says what the file had.
 *
 * HAND-OFF FOR RECONSTRUCTION: a future training / reconstruction step produces a SplatCloud and writes it with `writeSplatPly`
 * (a standard 3DGS .ply) into the asset library; the Gaussian Splat node reads it back like any downloaded file. Nothing else
 * in the engine needs to know where a cloud came from.
 */
import type { V3 } from './gen-camera';

export interface SplatBounds {
  min: V3;
  max: V3;
  centre: V3;
  /** Radius of a sphere around `centre` (full bounds: reaches every splat centre; core: the 99th percentile distance). */
  radius: number;
}

export type UpHint = '+y' | '-y' | '+z' | null;

export interface SplatCloud {
  /** Content hash (count + a sample of the data): equal clouds share GPU buffers and sort caches. */
  id: string;
  source: 'ply' | 'splat' | 'generated';
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacity: Float32Array;
  sh1: Float32Array | null;
  shDegreeInFile: number;
  /** Every splat centre. */
  bounds: SplatBounds;
  /** Robust bounds that ignore floaters: per-axis 1..99 percentile box, radius = 99th percentile distance from its centre. */
  core: SplatBounds;
  /** `comment up +y|-y|+z` of a .ply written by this tool (or anyone who follows the convention); null when the file does not say. */
  upHint: UpHint;
}

/** SH DC constant: colour = SH_C0 * f_dc + 0.5. */
export const SH_C0 = 0.28209479177387814;
/** SH degree 1 constant (used by the shader and the reference). */
export const SH_C1 = 0.4886025119029199;

export const MAX_SPLATS_IN_FILE = 1 << 26;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export { sigmoid };

function fnv(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}

/** Content id: count, bounds and a deterministic sample of positions / opacities / colours. */
export function cloudId(c: Pick<SplatCloud, 'count' | 'positions' | 'opacity' | 'colors'>): string {
  let h1 = 2166136261;
  let h2 = 0x9e3779b1;
  const n = c.count;
  h1 = fnv(h1, n);
  const step = Math.max(1, Math.floor(n / 4096));
  const u = new Uint32Array(c.positions.buffer, c.positions.byteOffset, c.positions.length);
  const o = new Uint32Array(c.opacity.buffer, c.opacity.byteOffset, c.opacity.length);
  const k = new Uint32Array(c.colors.buffer, c.colors.byteOffset, c.colors.length);
  for (let i = 0; i < n; i += step) {
    h1 = fnv(h1, u[i * 3]);
    h1 = fnv(h1, u[i * 3 + 1]);
    h1 = fnv(h1, u[i * 3 + 2]);
    h2 = fnv(h2 + o[i], k[i * 3] ^ k[i * 3 + 1]);
  }
  if (n > 0) {
    h1 = fnv(h1, u[(n - 1) * 3]);
    h2 = fnv(h2, o[n - 1]);
  }
  return `${n}:${h1.toString(36)}${h2.toString(36)}`;
}

function boundsOf(positions: Float32Array, n: number): SplatBounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (n === 0) return { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], radius: 1 };
  const centre: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - centre[0];
    const dy = positions[i * 3 + 1] - centre[1];
    const dz = positions[i * 3 + 2] - centre[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { min, max, centre, radius: Math.max(Math.sqrt(r2), 1e-6) };
}

/**
 * Robust bounds: a deterministic stride sample (at most 65,536 points) gives per-axis 1..99 percentiles; the radius is the 99th
 * percentile of the distance from the centre of that box. Floaters far from the scene do not change it.
 */
export function robustBounds(positions: Float32Array, n: number): SplatBounds {
  if (n === 0) return boundsOf(positions, 0);
  const m = Math.min(n, 65536);
  const stride = n / m;
  const axis = [new Float32Array(m), new Float32Array(m), new Float32Array(m)];
  for (let k = 0; k < m; k++) {
    const i = Math.min(n - 1, Math.floor(k * stride));
    axis[0][k] = positions[i * 3];
    axis[1][k] = positions[i * 3 + 1];
    axis[2][k] = positions[i * 3 + 2];
  }
  const min: V3 = [0, 0, 0];
  const max: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    axis[a].sort();
    min[a] = axis[a][Math.floor((m - 1) * 0.01)];
    max[a] = axis[a][Math.ceil((m - 1) * 0.99)];
  }
  const centre: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const d = new Float32Array(m);
  // (the per-axis arrays were sorted independently: distances come from the real samples)
  for (let k = 0; k < m; k++) {
    const i = Math.min(n - 1, Math.floor(k * stride));
    d[k] = Math.hypot(positions[i * 3] - centre[0], positions[i * 3 + 1] - centre[1], positions[i * 3 + 2] - centre[2]);
  }
  d.sort();
  const radius = Math.max(d[Math.min(m - 1, Math.ceil((m - 1) * 0.99))], 1e-6);
  return { min, max, centre, radius };
}

export interface CloudParts {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacity: Float32Array;
  sh1?: Float32Array | null;
  shDegreeInFile?: number;
  upHint?: UpHint;
}

/** Complete a cloud from its arrays: bounds, robust bounds and the content id. */
export function finishCloud(parts: CloudParts, source: SplatCloud['source']): SplatCloud {
  const n = parts.count;
  const base = {
    count: n,
    positions: parts.positions,
    scales: parts.scales,
    rotations: parts.rotations,
    colors: parts.colors,
    opacity: parts.opacity,
  };
  return {
    id: cloudId(base),
    source,
    ...base,
    sh1: parts.sh1 ?? null,
    shDegreeInFile: parts.shDegreeInFile ?? 0,
    bounds: boundsOf(parts.positions, n),
    core: robustBounds(parts.positions, n),
    upHint: parts.upHint ?? null,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Decimation                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** How much a splat contributes to the picture: opacity x geometric-mean size. Larger and more opaque = more important. */
export function importanceOf(cloud: SplatCloud, i: number): number {
  const s = cloud.scales;
  return cloud.opacity[i] * Math.cbrt(Math.max(s[i * 3] * s[i * 3 + 1] * s[i * 3 + 2], 1e-30));
}

const decimated = new WeakMap<SplatCloud, Map<number, SplatCloud>>();

/**
 * Keep the `max` most important splats (largest x most opaque), in their original order. Deterministic: an importance histogram (4096
 * log-spaced bins) finds the threshold bin, everything above it is kept and ties inside the threshold bin are taken by index order.
 * Pure function of (cloud, max); memoised per cloud object.
 */
export function decimateCloud(cloud: SplatCloud, max: number): SplatCloud {
  max = Math.max(1, Math.floor(max));
  if (cloud.count <= max) return cloud;
  let per = decimated.get(cloud);
  const hit = per?.get(max);
  if (hit) return hit;
  const n = cloud.count;
  const logs = new Float32Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Math.log2(Math.max(importanceOf(cloud, i), 1e-30));
    logs[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const BINS = 4096;
  const k = (BINS - 1) / Math.max(hi - lo, 1e-9);
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) hist[Math.floor((logs[i] - lo) * k)]++;
  let above = 0;
  let thr = BINS - 1;
  for (; thr >= 0; thr--) {
    if (above + hist[thr] >= max) break;
    above += hist[thr];
  }
  let ties = max - above; // splats still to take from the threshold bin, in index order
  const keep = new Uint32Array(max);
  let j = 0;
  for (let i = 0; i < n && j < max; i++) {
    const b = Math.floor((logs[i] - lo) * k);
    if (b > thr) keep[j++] = i;
    else if (b === thr && ties > 0) {
      ties--;
      keep[j++] = i;
    }
  }
  const m = j;
  const out: CloudParts = {
    count: m,
    positions: new Float32Array(m * 3),
    scales: new Float32Array(m * 3),
    rotations: new Float32Array(m * 4),
    colors: new Float32Array(m * 3),
    opacity: new Float32Array(m),
    sh1: cloud.sh1 ? new Float32Array(m * 9) : null,
    shDegreeInFile: cloud.shDegreeInFile,
    upHint: cloud.upHint,
  };
  for (let r = 0; r < m; r++) {
    const i = keep[r];
    out.positions!.set(cloud.positions.subarray(i * 3, i * 3 + 3), r * 3);
    out.scales.set(cloud.scales.subarray(i * 3, i * 3 + 3), r * 3);
    out.rotations.set(cloud.rotations.subarray(i * 4, i * 4 + 4), r * 4);
    out.colors.set(cloud.colors.subarray(i * 3, i * 3 + 3), r * 3);
    out.opacity[r] = cloud.opacity[i];
    if (cloud.sh1 && out.sh1) out.sh1.set(cloud.sh1.subarray(i * 9, i * 9 + 9), r * 9);
  }
  const result = finishCloud(out, cloud.source);
  // keep the original framing: dropping small splats must not move the fit
  result.core = cloud.core;
  if (!per) decimated.set(cloud, (per = new Map()));
  per.set(max, result);
  return result;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Orientation                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/**
 * Preset orientation matrices (row-major), file frame -> this tool's frame (x right, y up, z into the screen).
 * COLMAP / the original 3DGS trainer: x right, y DOWN, z forward -> flip y (no rotation: the tool's frame is the mirror convention).
 * Z-up (Blender, CAD): x right, y forward, z up -> swap y and z.
 */
export const ORIENT_Y_DOWN: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, 1];
export const ORIENT_Z_UP: Mat3 = [1, 0, 0, 0, 0, 1, 0, 1, 0];

/** Smallest rotation taking unit vector `a` onto unit vector `b` (Rodrigues), row-major. */
export function rotationBetween(a: V3, b: V3): Mat3 {
  const v: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c < -0.999999) {
    // opposite: half turn about any axis perpendicular to a
    const ax: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const p: V3 = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
    const l = Math.hypot(...p) || 1;
    const [x, y, z] = [p[0] / l, p[1] / l, p[2] / l];
    return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
  }
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}

export interface UpEstimate {
  /** Which preset to apply, as a matrix. */
  matrix: Mat3;
  /** How the guess was made: what the file said, the flat-scene analysis, or the Y-down default. */
  basis: 'file-hint' | 'flat-scene' | 'default-y-down';
  /** The direction (file frame) that was taken as up. */
  up: V3;
}

const upCache = new WeakMap<SplatCloud, UpEstimate>();

/**
 * A GUESS of which way is up, for files that do not say:
 *  1. a `comment up +y|-y|+z` in the .ply header wins;
 *  2. a scene that is flat (ground plane: the smallest principal axis has under 35% of the middle one's variance) takes that axis as
 *     up, signed towards the longer tail of the distribution (floors are dense, things stand on them);
 *  3. otherwise assume the original 3DGS trainer's COLMAP frame (y down), the most common case for downloaded scans.
 * Deterministic: uses the same stride sample as `robustBounds`. Wrong for upside-down scans of non-flat objects: say so in the UI.
 */
export function estimateUp(cloud: SplatCloud): UpEstimate {
  const hit = upCache.get(cloud);
  if (hit) return hit;
  let est: UpEstimate;
  if (cloud.upHint) {
    est =
      cloud.upHint === '+y'
        ? { matrix: IDENTITY3, basis: 'file-hint', up: [0, 1, 0] }
        : cloud.upHint === '-y'
          ? { matrix: ORIENT_Y_DOWN, basis: 'file-hint', up: [0, -1, 0] }
          : { matrix: ORIENT_Z_UP, basis: 'file-hint', up: [0, 0, 1] };
  } else {
    est = flatSceneUp(cloud) ?? { matrix: ORIENT_Y_DOWN, basis: 'default-y-down', up: [0, -1, 0] };
  }
  upCache.set(cloud, est);
  return est;
}

function flatSceneUp(cloud: SplatCloud): UpEstimate | null {
  const n = cloud.count;
  if (n < 50) return null;
  const m = Math.min(n, 50000);
  const stride = n / m;
  const idx = (k: number) => Math.min(n - 1, Math.floor(k * stride));
  const mean = [0, 0, 0];
  for (let k = 0; k < m; k++) for (let a = 0; a < 3; a++) mean[a] += cloud.positions[idx(k) * 3 + a];
  for (let a = 0; a < 3; a++) mean[a] /= m;
  const c = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (let k = 0; k < m; k++) {
    const i = idx(k) * 3;
    const d = [cloud.positions[i] - mean[0], cloud.positions[i + 1] - mean[1], cloud.positions[i + 2] - mean[2]];
    c[0] += d[0] * d[0]; c[1] += d[0] * d[1]; c[2] += d[0] * d[2]; c[3] += d[1] * d[1]; c[4] += d[1] * d[2]; c[5] += d[2] * d[2];
  }
  const { values, vectors } = jacobi3([c[0] / m, c[1] / m, c[2] / m, c[1] / m, c[3] / m, c[4] / m, c[2] / m, c[4] / m, c[5] / m]);
  // sort ascending
  const order = [0, 1, 2].sort((x, y) => values[x] - values[y]);
  const smallest = values[order[0]];
  const middle = values[order[1]];
  if (!(middle > 1e-12) || smallest / middle > 0.35) return null;
  const e = vectors[order[0]];
  // sign: the longer tail points up (mean above median along the axis)
  const proj = new Float32Array(m);
  let sum = 0;
  for (let k = 0; k < m; k++) {
    const i = idx(k) * 3;
    proj[k] = cloud.positions[i] * e[0] + cloud.positions[i + 1] * e[1] + cloud.positions[i + 2] * e[2];
    sum += proj[k];
  }
  const sorted = proj.slice().sort();
  const med = sorted[m >> 1];
  const up: V3 = sum / m >= med ? [e[0], e[1], e[2]] : [-e[0], -e[1], -e[2]];
  return { matrix: rotationBetween(up, [0, 1, 0]), basis: 'flat-scene', up };
}

/** Eigen-decomposition of a symmetric 3x3 (row-major) by cyclic Jacobi rotations. vectors[i] belongs to values[i]. */
export function jacobi3(a: number[]): { values: number[]; vectors: V3[] } {
  const A = a.slice();
  const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1);
      const sn = t * cs;
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p];
        const akq = A[k * 3 + q];
        A[k * 3 + p] = cs * akp - sn * akq;
        A[k * 3 + q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k];
        const aqk = A[q * 3 + k];
        A[p * 3 + k] = cs * apk - sn * aqk;
        A[q * 3 + k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p];
        const vkq = V[k * 3 + q];
        V[k * 3 + p] = cs * vkp - sn * vkq;
        V[k * 3 + q] = sn * vkp + cs * vkq;
      }
    }
  }
  return {
    values: [A[0], A[4], A[8]],
    vectors: [0, 1, 2].map((j) => [V[j], V[3 + j], V[6 + j]] as V3),
  };
}
