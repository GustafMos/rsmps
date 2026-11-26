/**
 * The maths of a cube with more than three dimensions, kept free of any drawing so it can be tested on its own.
 *
 * A cube in n dimensions has a corner for every way of choosing -1 or +1 on each axis (2^n corners) and an edge between
 * every two corners that differ on exactly one axis. To look at it, it is turned (a turn in n dimensions happens inside a
 * plane spanned by two axes, not around an axis) and then flattened one dimension at a time, each time the way a camera
 * flattens three dimensions into two: things that are near along the dimension being removed are drawn larger.
 */

export type Vec = number[];

/** The corners: every combination of -1 and +1. Bit k of the corner's index says which side of axis k it is on. */
export function hypercubeVertices(n: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < 1 << n; i++) {
    const v: number[] = [];
    for (let k = 0; k < n; k++) v.push(i & (1 << k) ? 1 : -1);
    out.push(v);
  }
  return out;
}

/** The edges as [corner, corner, axis they run along]. There are n * 2^(n-1) of them. */
export function hypercubeEdges(n: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < 1 << n; i++)
    for (let k = 0; k < n; k++) if (!(i & (1 << k))) out.push([i, i | (1 << k), k]);
  return out;
}

/** The flat square faces as [four corners going around, axis, axis]. There are n(n-1)/2 * 2^(n-2) of them. */
export function hypercubeFaces(n: number): [number[], number, number][] {
  const out: [number[], number, number][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let i = 0; i < 1 << n; i++) {
        if (i & (1 << a) || i & (1 << b)) continue;
        out.push([[i, i | (1 << a), i | (1 << a) | (1 << b), i | (1 << b)], a, b]);
      }
  return out;
}

/** The planes a turn can happen in: every pair of axes, n(n-1)/2 of them, in a fixed order. */
export function rotationPlanes(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) out.push([i, j]);
  return out;
}

/**
 * Turn a point: one rotation per plane, applied in the order of `rotationPlanes`. `angles` are in radians.
 * Each step only mixes two coordinates, so lengths never change.
 */
export function rotateND(v: Vec, planes: [number, number][], angles: number[]): Vec {
  const p = v.slice();
  for (let k = 0; k < planes.length; k++) {
    const a = angles[k];
    if (!a) continue;
    const [i, j] = planes[k];
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = p[i];
    const y = p[j];
    p[i] = x * c - y * s;
    p[j] = x * s + y * c;
  }
  return p;
}

/**
 * How far away the eye sits when a dimension is flattened, as a multiple of the largest distance any point can have from
 * the centre. `depth` 0 = infinitely far (no perspective), 1 = just outside the shape (extreme perspective).
 */
export function eyeFactor(depth: number): number {
  const d = Math.min(1, Math.max(0, depth));
  return d <= 0.0001 ? Infinity : 1 + (1 - d) / d + 0.15;
}

export interface Projected {
  x: number;
  y: number;
  /** How much the flattening enlarged this point in total: above 1 = near the eye in the removed dimensions. */
  scale: number;
  /** Nearness in the last (ordinary, third) dimension only, -1 far .. 1 near. */
  z: number;
}

/**
 * Flatten a point from n dimensions down to 2. Each step divides the remaining coordinates by (eye distance - last
 * coordinate) and multiplies by the eye distance, so a point in the middle keeps its size. `radius` is the largest length
 * a point can have (sqrt(n) for the corners of the cube): the eye is placed relative to it, and since flattening can
 * lengthen a point, the bound is carried along from one step to the next. `cameraDepth` is the strength of the last step
 * (3 dimensions to 2) when it should differ from the others.
 */
export function projectND(v: Vec, depth: number, radius = Math.sqrt(v.length), cameraDepth = depth): Projected {
  let p = v;
  let r = radius;
  let scale = 1;
  let z = 0;
  while (p.length > 2) {
    const w = p[p.length - 1];
    // the last step is the ordinary camera, which may be gentler than the steps through the higher dimensions
    const q = eyeFactor(p.length === 3 ? cameraDepth : depth);
    if (p.length === 3) z = r > 0 ? w / r : 0;
    const f = Number.isFinite(q) ? (q * r) / (q * r - w) : 1;
    p = p.slice(0, -1).map((c) => c * f);
    scale *= f;
    // the longest a flattened point can be: reached where w = r / q
    if (Number.isFinite(q)) r = (r * q) / Math.sqrt(q * q - 1);
  }
  return { x: p[0], y: p[1], scale, z };
}

/** Largest distance from the centre a flattened point can reach, for a shape of the given radius in n dimensions. */
export function projectedBound(n: number, depth: number, radius = Math.sqrt(n), cameraDepth = depth): number {
  let r = radius;
  for (let k = n; k > 2; k--) {
    const q = eyeFactor(k === 3 ? cameraDepth : depth);
    if (Number.isFinite(q)) r = (r * q) / Math.sqrt(q * q - 1);
  }
  return r;
}

/** Named sets of turns: how many whole turns each plane makes per loop. */
export const HYPERCUBE_MOTIONS: Record<string, { label: string; cycles: (i: number, j: number, n: number) => number }> = {
  tumble: {
    label: 'Slow tumble',
    // one ordinary turn, plus one turn in a plane that shares no axis with it for each higher dimension
    cycles: (i, j) => (j - i === 2 ? 1 : 0),
  },
  insideOut: {
    label: 'Inside out',
    // only the planes that reach into the higher dimensions: the inner cube swells and swaps places with the outer one
    cycles: (i, j) => (j >= 3 && i === j - 3 ? 1 : 0),
  },
  through: {
    label: 'Through itself',
    cycles: (i, j) => (j >= 3 ? (i === 0 ? 1 : i === j - 1 ? -1 : i === 1 ? 2 : 0) : i === 0 && j === 2 ? 1 : 0),
  },
  chaos: {
    label: 'Chaos',
    // every plane at its own speed and direction, chosen once and for all from the plane's two axes
    cycles: (i, j) => [1, -2, 2, -1, 3, -3][(i * 7 + j * 3 + i * j) % 6],
  },
  custom: { label: 'Custom', cycles: () => 0 },
};

export interface HypercubeMotion {
  motion: string;
  /** Whole-number multiplier on every turn. */
  speed: number;
  /** Custom: whole turns per loop. */
  turn: number;
  tumble: number;
  fold4: number;
  fold5: number;
  fold6: number;
}

/** Whole turns per loop for every plane of an n-cube, in the order of `rotationPlanes`. */
export function planeCycles(n: number, m: HypercubeMotion): number[] {
  const planes = rotationPlanes(n);
  const speed = Math.round(m.speed);
  let cycles: number[];
  if (m.motion === 'custom') {
    cycles = planes.map(([i, j]) =>
      i === 0 && j === 2 ? m.turn : i === 1 && j === 2 ? m.tumble : i === 0 && j === 3 ? m.fold4 : i === 1 && j === 4 ? m.fold5 : i === 2 && j === 5 ? m.fold6 : 0,
    );
  } else {
    const look = HYPERCUBE_MOTIONS[m.motion] ?? HYPERCUBE_MOTIONS.tumble;
    cycles = planes.map(([i, j]) => look.cycles(i, j, n));
    // a plain cube has no higher planes: a look made only of those would stand still
    if (cycles.every((c) => c === 0)) cycles = planes.map(([i, j]) => (i === 0 && j === 2 ? 1 : 0));
  }
  return cycles.map((c) => Math.round(c) * speed);
}

export interface HypercubePose {
  n: number;
  /** 0..1 over the loop. */
  phase: number;
  cycles: number[];
  /** Fixed angles in radians: leaning (plane y-z), turning (plane x-z), and one angle for every plane that reaches above the third dimension. */
  tilt: number;
  turn: number;
  fold: number;
  depth: number;
  /** Strength of the last, ordinary camera step. Defaults to `depth`. */
  cameraDepth?: number;
}

/** The angle of every plane at a moment of the loop. The moving part is taken modulo one turn so phase 1 lands exactly on phase 0. */
export function poseAngles(pose: HypercubePose): number[] {
  const planes = rotationPlanes(pose.n);
  return planes.map(([i, j], k) => {
    const t = pose.cycles[k] * pose.phase;
    const still = j >= 3 ? pose.fold : i === 0 && j === 2 ? pose.turn : i === 1 && j === 2 ? pose.tilt : 0;
    return still + (t - Math.floor(t)) * Math.PI * 2;
  });
}

/** All corners turned and flattened for a moment of the loop. */
export function hypercubePoints(pose: HypercubePose): Projected[] {
  const planes = rotationPlanes(pose.n);
  const angles = poseAngles(pose);
  return hypercubeVertices(pose.n).map((v) => projectND(rotateND(v, planes, angles), pose.depth, Math.sqrt(pose.n), pose.cameraDepth ?? pose.depth));
}

/**
 * The largest distance from the centre any corner reaches during the whole loop, so the shape can be sized to stay inside
 * the picture at its largest moment. Sampled; the small margin covers what falls between samples.
 */
export function loopExtent(pose: Omit<HypercubePose, 'phase'>, samples = 96): number {
  const moving = pose.cycles.some((c) => c !== 0);
  let max = 0;
  const count = moving ? samples : 1;
  for (let s = 0; s < count; s++) {
    for (const p of hypercubePoints({ ...pose, phase: s / count })) max = Math.max(max, Math.hypot(p.x, p.y));
  }
  return max * (moving ? 1.02 : 1);
}

/**
 * The 3x3 matrix (row by row) that takes a point of the picture to its place (0..1, 0..1) on a four-cornered shape whose
 * corners are given in the order top-left, top-right, bottom-right, bottom-left. This is what lets a flat picture be
 * drawn on a face that is seen in perspective. Returns null for a face seen exactly edge-on.
 */
export function quadToUnit(c: [number, number][]): number[] | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = c;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  // unit square -> quad
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const cc = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  // its inverse (the adjugate is enough: the scale cancels in the division)
  const m = [e - f * h, cc * h - b, b * f - cc * e, f * g - d, a - cc * g, cc * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  const det = a * m[0] + b * m[3] + cc * m[6];
  if (Math.abs(det) < 1e-14) return null;
  // sign chosen so the third row is positive inside the quad
  const s = det < 0 ? -1 : 1;
  const norm = s / Math.max(1e-12, Math.max(...m.map(Math.abs)));
  return m.map((v) => v * norm);
}
