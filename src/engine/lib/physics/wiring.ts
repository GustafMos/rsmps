/**
 * Helpers behind the Physics panel (pure, so they are tested without a browser): which nodes a body can drive, the wires that make it
 * drive one, collider sizes copied from a node, and the Scatter helper.
 */
import { paramBundles, type Registry } from '../../define';
import { connect, setParam } from '../../graph';
import type { GraphDoc, NodeInstance } from '../../types';
import { normalizeBodies, DEFAULT_BODY } from './sim';
import { MAX_BODIES, type BodySpec } from './types';

const MOVE = 'pos@xyz';
const TURN = 'rot@xyz';

/** Nodes of this graph level that have Move XYZ (and perhaps Rotate XYZ) sockets: the 3D nodes and SDF shapes. */
export function drivableNodes(g: GraphDoc, registry: Registry, exceptId?: string): { node: NodeInstance; move: boolean; turn: boolean }[] {
  const out: { node: NodeInstance; move: boolean; turn: boolean }[] = [];
  for (const n of g.nodes) {
    if (n.id === exceptId) continue;
    const def = registry.get(n.type);
    if (!def) continue;
    const ports = paramBundles(def).map((b) => b.port);
    if (ports.includes(MOVE)) out.push({ node: n, move: true, turn: ports.includes(TURN) });
  }
  return out;
}

/** The output names of body `index` (0-based): the first eight have their own, any other goes through the Extra body outputs. */
export function bodyPorts(index: number): { pos: string; rot: string; extra: boolean } {
  return index < 8 ? { pos: `pos${index + 1}`, rot: `rot${index + 1}`, extra: false } : { pos: 'posExtra', rot: 'rotExtra', extra: true };
}

/** Wire Position -> Move XYZ and Rotation -> Rotate XYZ of `targetId` from body `index` of the Physics node `physId`, as one new graph (one undo step). */
export function driveWires(g: GraphDoc, registry: Registry, physId: string, index: number, targetId: string): GraphDoc {
  const t = drivableNodes(g, registry).find((d) => d.node.id === targetId);
  if (!t) throw new Error('That node has no Move XYZ socket.');
  const ports = bodyPorts(index);
  let next = g;
  if (ports.extra) next = setParam(next, physId, 'extraBody', index + 1);
  next = connect(next, registry, { node: physId, port: ports.pos }, { node: targetId, port: MOVE });
  if (t.turn) next = connect(next, registry, { node: physId, port: ports.rot }, { node: targetId, port: TURN });
  return next;
}

/**
 * The collider that matches what a node draws, or null where the match is not clear (then the size stays as typed).
 * SDF Shape: sphere radius, box Width / Height / Depth, capsule and cylinder Radius and Height, all times its Scale.
 */
export function sizeFromNode(node: NodeInstance): Partial<BodySpec> | null {
  if (node.type !== 'sdf-shape') return null;
  const p = node.params;
  const n = (k: string, d: number): number => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const s = Math.max(0.001, n('objectScale', 1));
  switch (p.shape ?? 'sphere') {
    case 'sphere':
      return { shape: 'sphere', size: [n('radius', 0.5) * s, 1, 1] };
    case 'box':
    case 'rbox':
      return { shape: 'box', size: [n('sizeX', 1) * s, n('sizeY', 1) * s, n('sizeZ', 1) * s] };
    case 'capsule':
      return { shape: 'capsule', size: [n('radius', 0.5) * s, n('sizeY', 1) * s, 1] };
    case 'cylinder':
      return { shape: 'cylinder', size: [n('radius', 0.5) * s, n('sizeY', 1) * s, 1] };
    default:
      return null;
  }
}

/** Small deterministic random numbers (mulberry32). */
export function seeded(seed: number): () => number {
  let a = Math.floor(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScatterOptions {
  count: number;
  seed: number;
  /** Half width of the square the bodies start over (x and z). */
  spread: number;
  /** Lowest and highest start height. */
  low: number;
  high: number;
}

/** `count` copies of `base` with random start positions and rotations (the same seed always gives the same result), added after `bodies`, up to the limit. */
export function scatterBodies(bodies: BodySpec[], base: BodySpec | null, o: ScatterOptions): BodySpec[] {
  const rnd = seeded(o.seed);
  const room = Math.max(0, MAX_BODIES - bodies.length);
  const n = Math.min(Math.max(0, Math.floor(o.count)), room);
  const out = [...bodies];
  const from = base ?? DEFAULT_BODY;
  for (let i = 0; i < n; i++) {
    const r = (a: number, b: number) => a + (b - a) * rnd();
    out.push({
      ...from,
      pos: [r(-o.spread, o.spread), r(o.low, o.high), r(-o.spread, o.spread)],
      rot: [r(0, 360), r(0, 360), r(0, 360)],
      vel: [0, 0, 0],
      spin: [0, 0, 0],
      kind: 'dynamic',
    });
  }
  return normalizeBodies(out);
}
