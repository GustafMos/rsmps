/**
 * SDF scenes as data (the `sdf` socket). A scene is a TREE of shapes, combines, moves and modifiers with plain numbers (already resolved
 * for the current frame) and a stable id per tree node, so the renderer, the editor and later the viewer's picking all read one structure.
 *
 * Three views of the same tree, all pure functions of it:
 *  - STRUCTURE (`sdfStructure`): shape kinds, operators, modifier kinds, tree shape, feature flags (which repeat axes are on, whether a
 *    picture is used). It selects the generated shader, so it contains NO numbers: dragging a slider never compiles anything.
 *  - NUMBERS (`packSdf`): every number the shader needs, in a deterministic pre-order (a node, then its children in order), as vec4 slots.
 *  - IDS: `id` is the flat path of the node that produced the tree node (`scene/shape`, `outer/inner/shape`). A scene wired into another
 *    scene arrives wrapped in one `move` node whose id is the path of its render node, so `sdfPathTo(root, id)` lists the scenes a shape
 *    sits in. Picking returns a path id; the editor maps it back to a node.
 *
 * Modifiers and exactness (the tracer shortens its steps for the inexact ones, `sdfStepScale`):
 *  - exact:   mirror, round, shell, repeat (when each copy stays inside its cell), move
 *  - inexact: twist, bend, displace (the true distance is shorter than the value: steps are scaled by 0.6 / 0.6 / 0.7)
 */
import { rotationZYX } from './gen-common';
import { shapeExtent } from './sdf-prims';
import type { ImageValue, SdfCombineNode, SdfModKind, SdfModNode, SdfMoveNode, SdfNode, SdfShapeKind, SdfShapeNode, SdfValue, Vec3 } from '../types';

/** More shapes than this in one scene is refused with a plain error (the shader grows with every shape). */
export const SDF_MAX_SHAPES = 96;
/** More copies than this (shapes x repeats x mirrors) is refused: it would not render in a useful time. */
export const SDF_MAX_COPIES = 4096;

/** Meaning of `SdfModNode.v` per modifier (eight numbers). */
export const MOD_NUMBERS: Record<SdfModKind, string> = {
  mirror: 'none',
  repeat: 'v0..2 = copies along x, y, z (>= 1), v4..6 = spacing along x, y, z',
  round: 'v0 = radius',
  shell: 'v0 = thickness',
  twist: 'v0 = radians per scene unit along the axis',
  bend: 'v0 = radians per scene unit along the axis',
  displace: 'v0 = amount, v1 = noise scale, v2 = loop angle (radians)',
};

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Builders                                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export const sdfValue = (root: SdfNode | null, picture?: ImageValue | null): SdfValue => (picture ? { kind: 'sdf', root, picture } : { kind: 'sdf', root });

export function sdfShape(id: string, shape: SdfShapeKind, o: Partial<Omit<SdfShapeNode, 't' | 'id' | 'shape'>> = {}): SdfShapeNode {
  return { t: 'shape', id, shape, pos: o.pos ?? [0, 0, 0], rot: o.rot ?? [0, 0, 0], size: o.size ?? [0.5, 0.5, 0.5], scale: o.scale ?? 1, color: o.color ?? [0.8, 0.8, 0.8] };
}

export const sdfCombine = (id: string, op: SdfCombineNode['op'], children: SdfNode[], smooth = 0): SdfCombineNode => ({ t: 'combine', id, op, smooth, children });

export function sdfMove(id: string, child: SdfNode, o: { pos?: Vec3; rot?: Vec3; scale?: number; matrix?: number[] } = {}): SdfMoveNode {
  const n: SdfMoveNode = { t: 'move', id, pos: o.pos ?? [0, 0, 0], rot: o.rot ?? [0, 0, 0], scale: o.scale ?? 1, child };
  if (o.matrix) n.matrix = o.matrix;
  return n;
}

export function sdfMod(id: string, mod: SdfModKind, child: SdfNode, o: { axes?: [boolean, boolean, boolean]; axis?: 0 | 1 | 2; v?: number[] } = {}): SdfModNode {
  const v = [...(o.v ?? [])];
  while (v.length < 8) v.push(0);
  return { t: 'mod', id, mod, axes: o.axes ?? [false, false, false], axis: o.axis ?? 1, v, child };
}

/**
 * Combine the values that arrive on a multi input into one list of roots (empty scenes dropped) and the picture they share (the first one
 * wins: a scene holds at most one picture).
 */
export function sdfJoin(values: readonly (SdfValue | null | undefined)[]): { roots: SdfNode[]; picture: ImageValue | null } {
  const roots: SdfNode[] = [];
  let picture: ImageValue | null = null;
  for (const v of values) {
    if (!v || !v.root) continue;
    roots.push(v.root);
    if (!picture && v.picture) picture = v.picture;
  }
  return { roots, picture };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Walking                                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export const sdfChildren = (n: SdfNode): readonly SdfNode[] => (n.t === 'combine' ? n.children : n.t === 'shape' ? [] : [n.child]);

/** Pre-order (a node, then its children in order): the order of `packSdf`. */
export function sdfWalk(root: SdfNode | null, fn: (n: SdfNode, depth: number) => void, depth = 0): void {
  if (!root) return;
  fn(root, depth);
  for (const c of sdfChildren(root)) sdfWalk(c, fn, depth + 1);
}

export const sdfNodeCount = (root: SdfNode | null): number => {
  let n = 0;
  sdfWalk(root, () => n++);
  return n;
};

/** The tree node with this id (first in pre-order), or null. */
export function sdfFind(root: SdfNode | null, id: string): SdfNode | null {
  let found: SdfNode | null = null;
  sdfWalk(root, (n) => {
    if (!found && n.id === id) found = n;
  });
  return found;
}

/** The ids from the root down to the first tree node with this id (`[]` when absent): a shape inside nested scenes lists every scene wrapper. */
export function sdfPathTo(root: SdfNode | null, id: string): string[] {
  if (!root) return [];
  if (root.id === id) return [root.id];
  for (const c of sdfChildren(root)) {
    const sub = sdfPathTo(c, id);
    if (sub.length) return [root.id, ...sub];
  }
  return [];
}

export const sdfUsesPicture = (root: SdfNode | null): boolean => {
  let used = false;
  sdfWalk(root, (n) => {
    if (n.t === 'shape' && n.shape === 'image2d') used = true;
  });
  return used;
};

/** Shapes in the tree, and the copies they make once repeats and mirrors are counted. */
export function sdfCount(root: SdfNode | null): { shapes: number; copies: number } {
  let shapes = 0;
  let copies = 0;
  const go = (n: SdfNode, mult: number): void => {
    if (n.t === 'shape') {
      shapes++;
      copies += mult;
      return;
    }
    let m = mult;
    if (n.t === 'mod' && n.mod === 'mirror') m *= 2 ** n.axes.filter(Boolean).length;
    if (n.t === 'mod' && n.mod === 'repeat') for (let a = 0; a < 3; a++) m *= repeatCount(n.v[a]);
    for (const c of sdfChildren(n)) go(c, m);
  };
  if (root) go(root, 1);
  return { shapes, copies };
}

/** Throws the plain error shown on the node when a scene is too big. */
export function checkSdfSize(root: SdfNode | null): void {
  const { shapes, copies } = sdfCount(root);
  if (shapes > SDF_MAX_SHAPES) throw new Error(`This scene has ${shapes} shapes; at most ${SDF_MAX_SHAPES} fit in one scene. Split it into several scenes and combine them.`);
  if (copies > SDF_MAX_COPIES) throw new Error(`Repeat and Mirror make ${copies} copies of the shapes; at most ${SDF_MAX_COPIES} are allowed. Lower a Repeat count.`);
}

const repeatCount = (v: number | undefined): number => Math.max(1, Math.min(64, Math.round(v ?? 1)));

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Structure                                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Flag bits of a repeat: which axes have more than one copy. */
export const repeatAxes = (n: SdfModNode): [boolean, boolean, boolean] => [repeatCount(n.v[0]) > 1, repeatCount(n.v[1]) > 1, repeatCount(n.v[2]) > 1];

function nodeSig(n: SdfNode): string {
  switch (n.t) {
    case 'shape':
      return `s:${n.shape}`;
    case 'combine':
      return `c:${n.op[0]}${n.children.length}(${n.children.map(nodeSig).join(',')})`;
    case 'move':
      return `m(${nodeSig(n.child)})`;
    case 'mod': {
      const flag =
        n.mod === 'mirror' ? n.axes.map(Number).join('') : n.mod === 'repeat' ? repeatAxes(n).map(Number).join('') : n.mod === 'twist' || n.mod === 'bend' ? String(n.axis) : '';
      return `x:${n.mod}${flag}(${nodeSig(n.child)})`;
    }
  }
}

/** The canonical structure signature: equal for scenes that need the same shader, whatever their numbers. */
export const sdfStructure = (root: SdfNode | null): string => (root ? nodeSig(root) : 'empty');

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Numbers                                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** vec4 slots a node takes in the packing. */
export const SDF_SLOTS = { shape: 6, combine: 1, move: 4, mod: 2 } as const;
export const slotsOf = (n: SdfNode): number => SDF_SLOTS[n.t];

export function sdfSlotCount(root: SdfNode | null): number {
  let n = 0;
  sdfWalk(root, (x) => (n += slotsOf(x)));
  return n;
}

/** Rows of the transposed rotation (`local = (t0 . q, t1 . q, t2 . q)`), the form every shader here uses. */
const rowsOf = (R: readonly number[]): [Vec3, Vec3, Vec3] => [
  [R[0], R[3], R[6]],
  [R[1], R[4], R[7]],
  [R[2], R[5], R[8]],
];

/**
 * Every number of the scene in pre-order, four floats per slot:
 *  shape   6 slots: [pos, scale] [size, 0] [colour, 0] [t0, 0] [t1, 0] [t2, 0]
 *  combine 1 slot : [smooth, 0, 0, 0]
 *  move    4 slots: [pos, scale] [t0, 0] [t1, 0] [t2, 0]
 *  mod     2 slots: v0..3, v4..7
 */
export function packSdf(root: SdfNode | null): Float32Array {
  const out = new Float32Array(sdfSlotCount(root) * 4);
  let o = 0;
  const put = (a: number, b: number, c: number, d: number) => {
    out[o++] = a;
    out[o++] = b;
    out[o++] = c;
    out[o++] = d;
  };
  sdfWalk(root, (n) => {
    switch (n.t) {
      case 'shape': {
        const [t0, t1, t2] = rowsOf(rotationZYX(n.rot[0], n.rot[1], n.rot[2]));
        put(n.pos[0], n.pos[1], n.pos[2], Math.max(1e-4, n.scale));
        put(n.size[0], n.size[1], n.size[2], 0);
        put(n.color[0], n.color[1], n.color[2], 0);
        put(t0[0], t0[1], t0[2], 0);
        put(t1[0], t1[1], t1[2], 0);
        put(t2[0], t2[1], t2[2], 0);
        break;
      }
      case 'combine':
        put(Math.max(1e-4, n.smooth), 0, 0, 0);
        break;
      case 'move': {
        const [t0, t1, t2] = rowsOf(n.matrix && n.matrix.length === 9 ? n.matrix : rotationZYX(n.rot[0], n.rot[1], n.rot[2]));
        put(n.pos[0], n.pos[1], n.pos[2], Math.max(1e-4, n.scale));
        put(t0[0], t0[1], t0[2], 0);
        put(t1[0], t1[1], t1[2], 0);
        put(t2[0], t2[1], t2[2], 0);
        break;
      }
      case 'mod': {
        const v = n.v;
        if (n.mod === 'repeat') {
          put(repeatCount(v[0]), repeatCount(v[1]), repeatCount(v[2]), 0);
          put(Math.max(0.001, v[4] ?? 1), Math.max(0.001, v[5] ?? 1), Math.max(0.001, v[6] ?? 1), 0);
        } else {
          put(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
          put(v[4] ?? 0, v[5] ?? 0, v[6] ?? 0, v[7] ?? 0);
        }
        break;
      }
    }
  });
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Bounds and step safety                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export interface SdfBounds {
  center: Vec3;
  /** Infinity when the scene is unbounded (a plane, or nothing to bound). */
  radius: number;
}

const applyRows = (R: readonly number[], v: Vec3): Vec3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

/** Smallest sphere (not exactly minimal, but safe) holding two spheres. */
function enclose(a: SdfBounds, b: SdfBounds): SdfBounds {
  if (!Number.isFinite(a.radius) || !Number.isFinite(b.radius)) return { center: a.center, radius: Infinity };
  const d: Vec3 = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  if (dist + b.radius <= a.radius) return a;
  if (dist + a.radius <= b.radius) return b;
  const r = (dist + a.radius + b.radius) / 2;
  const k = (r - a.radius) / dist;
  return { center: [a.center[0] + d[0] * k, a.center[1] + d[1] * k, a.center[2] + d[2] * k], radius: r };
}

/** A sphere around the whole tree in the root's own frame (safe, a little loose). Unbounded scenes report Infinity. */
export function sdfBounds(root: SdfNode | null): SdfBounds {
  if (!root) return { center: [0, 0, 0], radius: 0 };
  switch (root.t) {
    case 'shape':
      return { center: root.pos, radius: shapeExtent(root.shape, root.size) * root.scale };
    case 'combine': {
      const kids = root.children.map(sdfBounds);
      if (!kids.length) return { center: [0, 0, 0], radius: 0 };
      const grow = root.smooth * 0.5;
      // intersect: inside every child, so the smallest child sphere bounds it; subtract: inside the first
      let b: SdfBounds;
      if (root.op === 'intersect') b = kids.reduce((m, k) => (k.radius < m.radius ? k : m));
      else if (root.op === 'subtract') b = kids[0];
      else b = kids.reduce((m, k) => enclose(m, k));
      return { center: b.center, radius: b.radius + grow };
    }
    case 'move': {
      const b = sdfBounds(root.child);
      const R = root.matrix && root.matrix.length === 9 ? root.matrix : rotationZYX(root.rot[0], root.rot[1], root.rot[2]);
      const c = applyRows(R, b.center);
      return { center: [root.pos[0] + c[0] * root.scale, root.pos[1] + c[1] * root.scale, root.pos[2] + c[2] * root.scale], radius: b.radius * root.scale };
    }
    case 'mod': {
      const b = sdfBounds(root.child);
      const r = b.radius;
      const c = b.center;
      switch (root.mod) {
        case 'round':
          return { center: c, radius: r + Math.max(0, root.v[0]) };
        case 'shell':
          return { center: c, radius: r + Math.max(0, root.v[0]) };
        case 'displace':
          return { center: c, radius: r + Math.abs(root.v[0]) };
        case 'mirror':
        case 'twist':
        case 'bend': {
          // mirrored copies and rotations about the origin: a sphere about the origin that reaches the farthest point
          const rr = r + Math.hypot(c[0], c[1], c[2]);
          return { center: [0, 0, 0], radius: rr };
        }
        case 'repeat': {
          const n = [repeatCount(root.v[0]), repeatCount(root.v[1]), repeatCount(root.v[2])];
          const sp = [Math.max(0.001, root.v[4] ?? 1), Math.max(0.001, root.v[5] ?? 1), Math.max(0.001, root.v[6] ?? 1)];
          const reach = Math.hypot(((n[0] - 1) / 2) * sp[0], ((n[1] - 1) / 2) * sp[1], ((n[2] - 1) / 2) * sp[2]);
          return { center: c, radius: r + reach };
        }
      }
    }
  }
}

/** True when every distance in the tree is exact (or a lower bound with no correction needed). */
export function sdfExact(root: SdfNode | null): boolean {
  let exact = true;
  sdfWalk(root, (n) => {
    if (n.t === 'mod' && (n.mod === 'twist' || n.mod === 'bend' || n.mod === 'displace')) exact = false;
  });
  return exact;
}

/** Factor the tracer applies to every step: 1 for exact scenes, smaller where a modifier makes the distance too long. */
export function sdfStepScale(root: SdfNode | null): number {
  let s = 1;
  sdfWalk(root, (n) => {
    if (n.t === 'mod') {
      if (n.mod === 'twist' || n.mod === 'bend') s = Math.min(s, 0.6);
      else if (n.mod === 'displace') s = Math.min(s, 0.7);
      else if (n.mod === 'repeat') s = Math.min(s, 0.85);
    }
    if (n.t === 'shape' && n.shape === 'image2d') s = Math.min(s, 0.9);
  });
  return s;
}
