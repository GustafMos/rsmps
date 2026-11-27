/**
 * Frames for the handles of a shape inside an SDF Scene. Pure.
 *
 * A node of the scene (SDF Shape, SDF Move) places things in the space of what is above it: Move / Rotate / Size of the scene itself, of every
 * SDF Move around it, of nested scenes. The evaluated tree carries those numbers for the current frame, so the chain above a node is read
 * from it (`chainOf`), composed into ONE frame (position, rotation, uniform size: `world = pos + size * R * local`), and the handles use it
 * both ways: a point of the node's own space to the world (to draw the handle where the shape is rendered) and a world point back to the
 * node's space (to turn a finger drag into the node's own numbers, even under a rotated or scaled parent).
 *
 * Modifiers above the node (Mirror, Repeat, Twist, Bend) are NOT undone: they are listed in `mods`, and the handles belong to the
 * original, un-mirrored, first copy of the shape.
 */
import { rotationZYX } from '../../engine/lib/gen-common';
import { sdfBounds, sdfChildren } from '../../engine/lib/sdf-scene';
import type { SdfModKind, SdfMoveNode, SdfNode } from '../../engine/types';
import { mul3, type M3, type V3 } from './gizmoMath';

export interface Frame {
  pos: V3;
  /** Row-major 3 x 3 rotation, local to world. */
  R: M3;
  /** Uniform size. */
  s: number;
}

export const IDENTITY_FRAME: Frame = { pos: [0, 0, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], s: 1 };

const rowApply = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const colApply = (m: M3, v: V3): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
export const transpose3 = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** The frame a Move node (or a shape) gives its inside. */
export function frameOfPlace(n: { pos: readonly number[]; rot: readonly number[]; scale: number; matrix?: number[] }): Frame {
  return {
    pos: [n.pos[0], n.pos[1], n.pos[2]],
    R: n.matrix && n.matrix.length === 9 ? [...n.matrix] : rotationZYX(n.rot[0], n.rot[1], n.rot[2]),
    s: Math.max(1e-4, n.scale),
  };
}

/** `outer` around `inner`: the frame of `inner` seen from outside `outer`. */
export function composeFrames(outer: Frame, inner: Frame): Frame {
  const p = rowApply(outer.R, inner.pos);
  return { pos: [outer.pos[0] + outer.s * p[0], outer.pos[1] + outer.s * p[1], outer.pos[2] + outer.s * p[2]], R: mul3(outer.R, inner.R), s: outer.s * inner.s };
}

/** A point of the inside of `f` in the world. */
export function toWorld(f: Frame, p: V3): V3 {
  const q = rowApply(f.R, p);
  return [f.pos[0] + f.s * q[0], f.pos[1] + f.s * q[1], f.pos[2] + f.s * q[2]];
}

/** A world point in the inside of `f` (the inverse of `toWorld`). */
export function toLocal(f: Frame, w: V3): V3 {
  return colApply(f.R, [(w[0] - f.pos[0]) / f.s, (w[1] - f.pos[1]) / f.s, (w[2] - f.pos[2]) / f.s]);
}

/** Modifiers that change WHERE a shape appears (a copy elsewhere, a bent space): the handles cannot follow them. */
const SPACE_MODS: readonly SdfModKind[] = ['mirror', 'repeat', 'twist', 'bend'];

export interface NodeChain {
  /** Everything above the node, composed: the node's own Move / Rotate / Size are written in this space. */
  frame: Frame;
  /** The modifiers above it that the handles cannot follow, outermost first. */
  mods: SdfModKind[];
  /** The tree node itself (the evaluated numbers of this frame). */
  node: SdfNode;
}

/** The chain from the root down to the tree node with this id, or null when it is not in the tree (not wired to the scene output). */
export function chainOf(root: SdfNode | null, id: string): NodeChain | null {
  const trail: SdfNode[] = [];
  const find = (n: SdfNode): boolean => {
    trail.push(n);
    if (n.id === id) return true;
    for (const c of sdfChildren(n)) if (find(c)) return true;
    trail.pop();
    return false;
  };
  if (!root || !find(root)) return null;
  const node = trail[trail.length - 1];
  let frame = IDENTITY_FRAME;
  const mods: SdfModKind[] = [];
  for (const a of trail.slice(0, -1)) {
    if (a.t === 'move') frame = composeFrames(frame, frameOfPlace(a as SdfMoveNode));
    else if (a.t === 'mod' && SPACE_MODS.includes(a.mod)) mods.push(a.mod);
  }
  return { frame, mods, node };
}

/** What the node covers, in the node's PARENT space: a sphere (centre, radius) around its shape, or around everything inside an SDF Move. */
export function reachOf(n: SdfNode): { center: V3; radius: number } {
  return sdfBounds(n);
}

export const MOD_WORDS: Record<string, string> = { mirror: 'Mirror', repeat: 'Repeat', twist: 'Twist', bend: 'Bend' };

/** The one-line hint shown while a modifier sits above the selected shape, or null. */
export function modHint(mods: readonly SdfModKind[]): string | null {
  if (!mods.length) return null;
  const names = [...new Set(mods.map((m) => MOD_WORDS[m] ?? m))].join(' / ');
  return `${names} sits above this shape: the handles belong to the original, first copy.`;
}
