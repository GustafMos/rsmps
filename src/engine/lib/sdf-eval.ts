/**
 * The SDF scene on the CPU: the same distance functions, combine operators, moves and modifiers as the generated shader (lib/sdf-render.ts,
 * lib/sdf-prims.ts), written out in TypeScript, so the viewer can answer "which shape is under my finger" without the GPU.
 *
 * Pure. The tree is the one a scene hands out on its `sdf` wire (its root already carries the scene's own Move / Rotate / Size).
 * Picking walks a ray through the tree the way the renderer does (sphere tracing, steps shortened for the inexact modifiers), then asks
 * every shape how far the hit point is from it in the shape's own frame, modifiers on the way included, and returns the nearest one.
 */
import { rotationZYX } from './gen-common';
import { repeatAxes, sdfStepScale } from './sdf-scene';
import type { ImageValue, SdfModNode, SdfNode, SdfShapeNode, Vec3 } from '../types';

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const fract = (x: number) => x - Math.floor(x);

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Shapes (mirror SD_FUNCS in lib/sdf-prims.ts; q = point in the shape's own frame, s = half sizes)                                */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const sdBox = (q: Vec3, h: Vec3): number => {
  const d = [Math.abs(q[0]) - h[0], Math.abs(q[1]) - h[1], Math.abs(q[2]) - h[2]];
  return Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)) + Math.min(Math.max(d[0], Math.max(d[1], d[2])), 0);
};

function sdCone(pin: Vec3, s: Vec3): number {
  const h = 2 * s[1];
  const cl = Math.hypot(s[0], h) || 1;
  const c = [s[0] / cl, h / cl];
  const p = [pin[0], pin[1] - s[1], pin[2]];
  const q = [h * (c[0] / c[1]), -h];
  const w = [Math.hypot(p[0], p[2]), p[1]];
  const k1 = clamp((w[0] * q[0] + w[1] * q[1]) / (q[0] * q[0] + q[1] * q[1]), 0, 1);
  const a = [w[0] - q[0] * k1, w[1] - q[1] * k1];
  const k2 = clamp(w[0] / q[0], 0, 1);
  const b = [w[0] - q[0] * k2, w[1] - q[1]];
  const k = Math.sign(q[1]);
  const d = Math.min(a[0] * a[0] + a[1] * a[1], b[0] * b[0] + b[1] * b[1]);
  const sg = Math.max(k * (w[0] * q[1] - w[1] * q[0]), k * (w[1] - q[1]));
  return Math.sqrt(d) * Math.sign(sg);
}

function sdOcta(pin: Vec3, s: Vec3): number {
  const p: Vec3 = [Math.abs(pin[0]), Math.abs(pin[1]), Math.abs(pin[2])];
  const m = p[0] + p[1] + p[2] - s[0];
  let q: Vec3;
  if (3 * p[0] < m) q = p;
  else if (3 * p[1] < m) q = [p[1], p[2], p[0]];
  else if (3 * p[2] < m) q = [p[2], p[0], p[1]];
  else return m * 0.57735027;
  const k = clamp(0.5 * (q[2] - q[1] + s[0]), 0, s[0]);
  return Math.hypot(q[0], q[1] - s[0] + k, q[2] - k);
}

/** Distance to a shape of this kind, `q` in its own frame (before the shape's own scale). The extruded picture is a box of the picture's outline. */
export function shapeDistance(shape: SdfShapeNode, q: Vec3, picture?: ImageValue | null): number {
  const s = shape.size;
  switch (shape.shape) {
    case 'sphere':
      return len(q) - s[0];
    case 'box':
      return sdBox(q, s);
    case 'rbox': {
      const r = 0.25 * Math.min(s[0], s[1], s[2]);
      return sdBox(q, [s[0] - r, s[1] - r, s[2] - r]) - r;
    }
    case 'torus':
      return Math.hypot(Math.hypot(q[0], q[2]) - s[0], q[1]) - s[1];
    case 'capsule':
      return Math.hypot(q[0], q[1] - clamp(q[1], -s[1], s[1]), q[2]) - s[0];
    case 'cylinder': {
      const d = [Math.hypot(q[0], q[2]) - s[0], Math.abs(q[1]) - s[1]];
      return Math.min(Math.max(d[0], d[1]), 0) + Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0));
    }
    case 'cone':
      return sdCone(q, s);
    case 'plane':
      return q[1];
    case 'octa':
      return sdOcta(q, s);
    case 'image2d': {
      // the picture's own field is not on the CPU: its outline box stands in (good enough to say which shape was touched)
      const long = picture ? Math.max(picture.width, picture.height) : 1;
      const px = picture ? picture.width / long : 1;
      const py = picture ? picture.height / long : 1;
      return sdBox(q, [px * s[0], py * s[0], s[1]]);
    }
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Frames and modifiers                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** `local = R^T (p - pos) / scale` for a row-major rotation `R` (the shader's toLocal / move frame). */
function toLocal(p: Vec3, pos: Vec3, R: readonly number[], scale: number): Vec3 {
  const d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
  return [
    (R[0] * d[0] + R[3] * d[1] + R[6] * d[2]) / scale,
    (R[1] * d[0] + R[4] * d[1] + R[7] * d[2]) / scale,
    (R[2] * d[0] + R[5] * d[1] + R[8] * d[2]) / scale,
  ];
}

const rotOf = (n: { rot: Vec3; matrix?: number[] }): readonly number[] => (n.matrix && n.matrix.length === 9 ? n.matrix : rotationZYX(n.rot[0], n.rot[1], n.rot[2]));

function noise3(x: Vec3): number {
  const hash = (p: Vec3): number => {
    let q: Vec3 = [fract(p[0] * 0.3183099 + 0.1), fract(p[1] * 0.3183099 + 0.2), fract(p[2] * 0.3183099 + 0.3)];
    q = [q[0] * 17, q[1] * 17, q[2] * 17];
    return fract(q[0] * q[1] * q[2] * (q[0] + q[1] + q[2]));
  };
  const i: Vec3 = [Math.floor(x[0]), Math.floor(x[1]), Math.floor(x[2])];
  const f = [x[0] - i[0], x[1] - i[1], x[2] - i[2]];
  const w = f.map((t) => t * t * (3 - 2 * t));
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const h = (dx: number, dy: number, dz: number) => hash([i[0] + dx, i[1] + dy, i[2] + dz]);
  const a = mix(mix(h(0, 0, 0), h(1, 0, 0), w[0]), mix(h(0, 1, 0), h(1, 1, 0), w[0]), w[1]);
  const b = mix(mix(h(0, 0, 1), h(1, 0, 1), w[0]), mix(h(0, 1, 1), h(1, 1, 1), w[0]), w[1]);
  return mix(a, b, w[2]) * 2 - 1;
}

/** The point a modifier hands to its child (mirror folds, repeat wraps, twist and bend turn), or the same point when it only changes the distance. */
export function modPoint(n: SdfModNode, p: Vec3): Vec3 {
  switch (n.mod) {
    case 'mirror':
      return [n.axes[0] ? Math.abs(p[0]) : p[0], n.axes[1] ? Math.abs(p[1]) : p[1], n.axes[2] ? Math.abs(p[2]) : p[2]];
    case 'repeat': {
      const m: Vec3 = [p[0], p[1], p[2]];
      const on = repeatAxes(n);
      for (let a = 0; a < 3; a++) {
        if (!on[a]) continue;
        const cnt = Math.max(1, Math.min(64, Math.round(n.v[a] ?? 1)));
        const sp = Math.max(0.001, n.v[4 + a] ?? 1);
        m[a] = m[a] - sp * (clamp(Math.floor(m[a] / sp + (cnt - 1) * 0.5 + 0.5), 0, cnt - 1) - (cnt - 1) * 0.5);
      }
      return m;
    }
    case 'twist':
    case 'bend': {
      const a = n.axis;
      const b = (n.axis + 1) % 3;
      const c = (n.axis + 2) % 3;
      const ang = (n.v[0] ?? 0) * p[a];
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const m: Vec3 = [p[0], p[1], p[2]];
      if (n.mod === 'twist') {
        m[b] = cs * p[b] - sn * p[c];
        m[c] = sn * p[b] + cs * p[c];
      } else {
        m[a] = cs * p[a] - sn * p[b];
        m[b] = sn * p[a] + cs * p[b];
      }
      return m;
    }
    default:
      return p;
  }
}

/** What a modifier does to the child's distance (round, shell and displace; the others only change the point). */
function modDistance(n: SdfModNode, d: number, p: Vec3): number {
  switch (n.mod) {
    case 'round':
      return d - (n.v[0] ?? 0);
    case 'shell':
      return Math.abs(d) - (n.v[0] ?? 0);
    case 'displace': {
      const sc = n.v[1] ?? 0;
      const ang = n.v[2] ?? 0;
      return d + (n.v[0] ?? 0) * noise3([p[0] * sc + Math.cos(ang) * 1.7, p[1] * sc + Math.sin(ang) * 1.7, p[2] * sc]);
    }
    default:
      return d;
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Distance of the whole tree                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const K_MIN = 1e-4;

/** `a` and `b` joined by the operator with the shader's smooth blend (the colour is not needed here: only which side the surface belongs to). */
function join(op: 'union' | 'subtract' | 'intersect', a: number, b: number, k: number): { d: number; second: boolean } {
  if (op === 'union') {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return { d: Math.min(a, b) - h * h * k * 0.25, second: b < a };
  }
  if (op === 'subtract') {
    const nb = -b;
    const h = Math.max(k - Math.abs(a - nb), 0) / k;
    return { d: Math.max(a, nb) + h * h * k * 0.25, second: nb > a };
  }
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return { d: Math.max(a, b) + h * h * k * 0.25, second: b > a };
}

interface Hit {
  d: number;
  /** Id of the shape the surface at this point belongs to (the one the operators leave standing). */
  id: string;
}

function evalNode(n: SdfNode, p: Vec3, picture: ImageValue | null | undefined): Hit {
  switch (n.t) {
    case 'shape': {
      const s = Math.max(1e-4, n.scale);
      const q = toLocal(p, n.pos, rotationZYX(n.rot[0], n.rot[1], n.rot[2]), s);
      return { d: shapeDistance(n, q, picture) * s, id: n.id };
    }
    case 'combine': {
      if (!n.children.length) return { d: 1000, id: '' };
      const k = Math.max(n.smooth, K_MIN);
      let acc = evalNode(n.children[0], p, picture);
      for (let i = 1; i < n.children.length; i++) {
        const b = evalNode(n.children[i], p, picture);
        const j = join(n.op, acc.d, b.d, k);
        acc = { d: j.d, id: j.second ? b.id : acc.id };
      }
      return acc;
    }
    case 'move': {
      const s = Math.max(1e-4, n.scale);
      const r = evalNode(n.child, toLocal(p, n.pos, rotOf(n), s), picture);
      return { d: r.d * s, id: r.id };
    }
    case 'mod': {
      const m = modPoint(n, p);
      const r = evalNode(n.child, m, picture);
      return { d: modDistance(n, r.d, p), id: r.id };
    }
  }
}

/** Signed distance of the tree at a point of the scene (what the renderer's `map` returns). 1000 for an empty scene. */
export function sdfDistance(root: SdfNode | null, p: Vec3, picture?: ImageValue | null): number {
  return root ? evalNode(root, p, picture).d : 1000;
}

/**
 * How far each shape is from `p`, in scene units, every one measured in its own frame with the moves and modifiers above it applied
 * (so a shape under a Mirror or Repeat is measured against the nearest copy). Keys are shape ids.
 */
export function sdfLeafDistances(root: SdfNode | null, p: Vec3, picture?: ImageValue | null): Map<string, number> {
  const out = new Map<string, number>();
  const go = (n: SdfNode, q: Vec3, mult: number): void => {
    switch (n.t) {
      case 'shape': {
        const s = Math.max(1e-4, n.scale);
        const d = Math.abs(shapeDistance(n, toLocal(q, n.pos, rotationZYX(n.rot[0], n.rot[1], n.rot[2]), s), picture) * s * mult);
        const was = out.get(n.id);
        if (was === undefined || d < was) out.set(n.id, d);
        break;
      }
      case 'combine':
        for (const c of n.children) go(c, q, mult);
        break;
      case 'move': {
        const s = Math.max(1e-4, n.scale);
        go(n.child, toLocal(q, n.pos, rotOf(n), s), mult * s);
        break;
      }
      case 'mod':
        go(n.child, modPoint(n, q), mult);
        break;
    }
  };
  if (root) go(root, p, 1);
  return out;
}

export interface SdfRayHit {
  /** Distance along the ray (the renderer's depth output). */
  t: number;
  point: Vec3;
  /** Id of the shape nearest to the hit point. */
  id: string;
}

/**
 * Sphere-trace a ray (unit direction) through the tree. Same step rule as the renderer (0.9 x the inexact-modifier factor), a hit at
 * a distance below a tenth of a percent of the way along the ray (at least 0.0005), 160 steps, nothing beyond `far`.
 */
export function sdfRay(root: SdfNode | null, ro: Vec3, rd: Vec3, o: { picture?: ImageValue | null; far?: number } = {}): SdfRayHit | null {
  if (!root) return null;
  const far = o.far ?? 80;
  const k = 0.9 * sdfStepScale(root);
  let t = 0;
  for (let i = 0; i < 160 && t < far; i++) {
    const p: Vec3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const d = evalNode(root, p, o.picture).d;
    if (d < Math.max(0.0005, 0.001 * t)) return { t, point: p, id: nearestShape(root, p, o.picture) };
    t += Math.max(d * k, 1e-5);
  }
  return null;
}

/** The shape whose surface is nearest to `p` (smallest absolute distance in its own frame), or '' for an empty scene. */
export function nearestShape(root: SdfNode | null, p: Vec3, picture?: ImageValue | null): string {
  let best = '';
  let bd = Infinity;
  for (const [id, d] of sdfLeafDistances(root, p, picture)) {
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return best;
}
