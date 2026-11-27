/**
 * Object-first setup of the Physics node: "Physics: Falls / Stays put" on an object, and the Physics panel's object list. A body belongs
 * to an object through its wire: the Motion output `motion<N>` of the Physics node into the object's Motion input. Pure functions on one
 * graph level (the editor runs them as one undo step each).
 */
import { MOTION_PORT, paramMotion, type Registry } from '../../define';
import { GROUP_IN } from '../../group';
import { addNode, connect, setParam, uid } from '../../graph';
import type { Edge, GraphDoc, NodeInstance } from '../../types';
import { DEFAULT_BODY, normalizeBodies } from './sim';
import type { Vec3 } from './rotation';
import { MAX_BODIES, type BodyKind, type BodySpec } from './types';

export const PHYSICS_TYPE = 'physics';
export const motionPortOf = (index: number): string => `motion${index + 1}`;
const OLD_PORT = /^(pos|rot)(\d+)$/;
const MOTION_OUT = /^motion(\d+)$/;

export type PhysicalMode = 'falls' | 'fixed';

export interface Collider {
  spec: Pick<BodySpec, 'shape' | 'size'>;
  /** Said under the control when the shape is a guess. */
  note: string | null;
}

/** Nodes that can be given physics: the ones with a Motion socket that are not groups, not the Physics node itself and not the scene's own camera (Scene Output). */
export function canBePhysical(node: NodeInstance, registry: Registry): boolean {
  if (node.type === PHYSICS_TYPE || node.type === 'sdf-render') return false;
  if ((node.params as Record<string, unknown>).kind === 'group') return false;
  const def = registry.get(node.type);
  if (!def || !paramMotion(def)) return false;
  // objects, not cameras: the SDF shapes, and the 3D family (Move / Rotate / Object scale and a camera input of their own)
  const m = paramMotion(def)!;
  return def.id === 'sdf-shape' || def.id === 'sdf-transform' || (!!m.scale && 'camera' in def.inputs);
}

const n = (p: Record<string, unknown>, k: string, d: number): number => (typeof p[k] === 'number' ? (p[k] as number) : d);
const clampSize = (v: number): number => Math.min(100, Math.max(0.01, v));
const GUESS = 'The size of your model is not known here, so a box of the default size is used. Change it below.';

/** The shape and size used for bumping, taken from what the object draws where that is known, else a box of a default size (with a note). */
export function colliderFor(node: NodeInstance): Collider {
  const p = node.params;
  const s = Math.max(0.001, n(p, 'objectScale', 1));
  const box = (w: number, h: number, d: number, note: string | null = null): Collider => ({ spec: { shape: 'box', size: [clampSize(w), clampSize(h), clampSize(d)] }, note });
  if (node.type === 'sdf-shape') {
    const r = n(p, 'radius', 0.5);
    switch (p.shape ?? 'sphere') {
      case 'sphere':
        return { spec: { shape: 'sphere', size: [clampSize(r * s), 1, 1] }, note: null };
      case 'octa':
        return { spec: { shape: 'sphere', size: [clampSize(r * s), 1, 1] }, note: 'Bumps like a ball of the same radius.' };
      case 'box':
      case 'rbox':
        return box(n(p, 'sizeX', 1) * s, n(p, 'sizeY', 1) * s, n(p, 'sizeZ', 1) * s);
      case 'capsule':
        return { spec: { shape: 'capsule', size: [clampSize(r * s), clampSize(n(p, 'sizeY', 1) * s), 1] }, note: null };
      case 'cylinder':
        return { spec: { shape: 'cylinder', size: [clampSize(r * s), clampSize(n(p, 'sizeY', 1) * s), 1] }, note: null };
      case 'cone':
        return { spec: { shape: 'cylinder', size: [clampSize(r * s), clampSize(n(p, 'sizeY', 1) * s), 1] }, note: 'Bumps like a cylinder of the same size.' };
      case 'torus': {
        const tube = n(p, 'tube', 0.15);
        const out = (r + tube) * 2 * s;
        return box(out, tube * 2 * s, out, 'Bumps like a flat box around the ring.');
      }
      case 'plane':
        return box(6 * s, 0.1, 6 * s, 'A flat plane bumps like a thin box.');
      case 'image2d':
        return box(n(p, 'sizeX', 1) * s, n(p, 'sizeX', 1) * s, n(p, 'sizeZ', 1) * s, 'Bumps like a box around the picture.');
      default:
        return box(s, s, s, 'Shape not known: a box of the default size is used.');
    }
  }
  if (node.type === 'object-3d') {
    // the 3D family's primitives fill a ball of radius about 0.95 (OBJECT_RADIUS in ui/lib/xform3d.ts), so 1.9 across
    const k = 1.9 * s;
    switch (p.shape ?? 'cube') {
      case 'cube':
        return box(k, k, k);
      case 'sphere':
        return { spec: { shape: 'sphere', size: [clampSize(0.95 * s), 1, 1] }, note: null };
      case 'cylinder':
        return { spec: { shape: 'cylinder', size: [clampSize(0.7 * s), clampSize(k), 1] }, note: null };
      case 'capsule':
        return { spec: { shape: 'capsule', size: [clampSize(0.5 * s), clampSize(0.9 * s), 1] }, note: null };
      case 'octahedron':
        return { spec: { shape: 'sphere', size: [clampSize(0.95 * s), 1, 1] }, note: 'Bumps like a ball of the same size.' };
      case 'cone':
      case 'pyramid':
        return box(1.4 * s, k, 1.4 * s, 'Bumps like a box around it.');
      case 'torus':
        return box(k, 0.6 * s, k, 'Bumps like a flat box around the ring.');
      default:
        return box(k, k, k, GUESS);
    }
  }
  if (node.type === 'model-3d') return box(1.9 * s, 1.9 * s, 1.9 * s, GUESS);
  return box(s, s, s, 'Shape not known: a box of the default size is used. Change it below.');
}

/** Where the object is now, as the start pose of its body. */
export function startPoseOf(node: NodeInstance): { pos: Vec3; rot: Vec3 } {
  const p = node.params;
  return { pos: [n(p, 'posX', 0), n(p, 'posY', 0), n(p, 'posZ', 0)], rot: [n(p, 'rotX', 0), n(p, 'rotY', 0), n(p, 'rotZ', 0)] };
}

/** The Physics node of a level (the first one), or undefined. */
export function findPhysics(g: GraphDoc): NodeInstance | undefined {
  return g.nodes.find((x) => x.type === PHYSICS_TYPE);
}

export interface BodyLink {
  /** 0-based body number. */
  index: number;
  /** The object the body drives (undefined: nothing is wired to it). */
  target?: NodeInstance;
  /** 'motion' = one Motion wire; 'vectors' = the 0.54 pair of Position / Rotation wires; 'none' = nothing. */
  how: 'motion' | 'vectors' | 'none';
}

/** Per body of a Physics node: the object it drives and how it is wired. */
export function bodyLinks(g: GraphDoc, physId: string): BodyLink[] {
  const phys = g.nodes.find((x) => x.id === physId);
  const count = phys ? normalizeBodies(phys.params.bodies).length : 0;
  const outs = g.edges.filter((e) => e.from.node === physId);
  const out: BodyLink[] = [];
  for (let i = 0; i < count; i++) {
    const m = outs.find((e) => e.from.port === motionPortOf(i));
    const old = i < 8 ? outs.find((e) => e.from.port === `pos${i + 1}` || e.from.port === `rot${i + 1}`) : undefined;
    const found = m ?? old;
    out.push({ index: i, target: found ? g.nodes.find((x) => x.id === found.to.node) : undefined, how: m ? 'motion' : old ? 'vectors' : 'none' });
  }
  return out;
}

/** The Physics node and body number that move `objId`, or null. */
export function physicsOf(g: GraphDoc, objId: string): { phys: NodeInstance; index: number; how: 'motion' | 'vectors' } | null {
  for (const e of g.edges) {
    if (e.to.node !== objId) continue;
    const from = g.nodes.find((x) => x.id === e.from.node);
    if (from?.type !== PHYSICS_TYPE) continue;
    const mm = MOTION_OUT.exec(e.from.port);
    if (mm && e.to.port === MOTION_PORT) return { phys: from, index: Number(mm[1]) - 1, how: 'motion' };
    const om = OLD_PORT.exec(e.from.port);
    if (om && (e.to.port === 'pos@xyz' || e.to.port === 'rot@xyz')) return { phys: from, index: Number(om[2]) - 1, how: 'vectors' };
  }
  return null;
}

const setBodies = (g: GraphDoc, physId: string, bodies: BodySpec[]): GraphDoc => setParam(g, physId, 'bodies', bodies);

/** How far the body reaches down from its centre when it stands upright. */
function halfHeight(spec: Pick<BodySpec, 'shape' | 'size'>): number {
  if (spec.shape === 'box') return spec.size[1] / 2;
  if (spec.shape === 'sphere') return spec.size[0];
  return spec.size[1] / 2 + (spec.shape === 'capsule' ? spec.size[0] : 0);
}

/**
 * Where the real floor is expected to be when this object is set up (scene y), when its camera is a World AR Camera of this level
 * (minus its Lift); null when that is not known here. Used only to keep the start pose from being below the floor.
 */
function floorGuess(g: GraphDoc, registry: Registry, obj: NodeInstance): number | null {
  const src = cameraSourceFor(g, registry, obj);
  const from = src ? g.nodes.find((x) => x.id === src.node) : undefined;
  if (from?.type !== 'world-ar') return null;
  return -(typeof from.params.lift === 'number' ? from.params.lift : 1);
}

/** The start pose is where the object is now, but never inside the real floor: then it starts just above it, at the same place. */
function newBody(obj: NodeInstance, kind: BodyKind, floorY: number | null = null): BodySpec {
  const spec = { ...DEFAULT_BODY, ...colliderFor(obj).spec, ...startPoseOf(obj), kind };
  if (floorY !== null && kind === 'dynamic') {
    const lowest = floorY + halfHeight(spec) + 0.02;
    if (spec.pos[1] < lowest) spec.pos = [spec.pos[0], lowest, spec.pos[2]];
  }
  return spec;
}

/**
 * The camera that draws `obj`: the wire into its own Camera input, or for an SDF shape inside an SDF Scene the scene's camera
 * (the scene's Camera input inside the group). Null when there is none.
 */
export function cameraSourceFor(g: GraphDoc, registry: Registry, obj: NodeInstance): Edge['from'] | null {
  const def = registry.get(obj.type);
  if (def && 'camera' in def.inputs) return g.edges.find((e) => e.to.node === obj.id && e.to.port === 'camera')?.from ?? null;
  const proxy = g.nodes.find((x) => x.id === GROUP_IN);
  const ports = (proxy?.params as { ports?: { id: string; type: string }[] } | undefined)?.ports;
  return ports?.some((q) => q.id === 'camera' && q.type === 'camera') ? { node: GROUP_IN, port: 'camera' } : null;
}

/** Wire the camera that draws `obj` into the Physics node's Camera input too (when that is empty), so its floor is the real one. */
function wireCameraInto(g: GraphDoc, registry: Registry, physId: string, obj: NodeInstance): GraphDoc {
  if (g.edges.some((e) => e.to.node === physId && e.to.port === 'camera')) return g;
  const src = cameraSourceFor(g, registry, obj);
  if (!src) return g;
  try {
    return connect(g, registry, src, { node: physId, port: 'camera' });
  } catch {
    return g;
  }
}

/** What the Physics node still lacks for the real floor: an AR camera at this level that nothing connects to it (null when fine). */
export function arCameraTodo(g: GraphDoc, physId: string): { ar: NodeInstance } | null {
  const ar = findWorldAr(g);
  if (!ar || g.edges.some((e) => e.to.node === physId && e.to.port === 'camera')) return null;
  return { ar };
}

/** "Use the AR camera": wire the World AR Camera into the Physics node's Camera input (and so into every object it moves). */
export function wireArCamera(g: GraphDoc, registry: Registry, physId: string): GraphDoc | null {
  const todo = arCameraTodo(g, physId);
  return todo ? connect(g, registry, { node: todo.ar.id, port: 'camera' }, { node: physId, port: 'camera' }) : null;
}

/** A 3D object moved by Physics that has no camera of its own, while a World AR Camera exists here and Physics got no camera either. */
export function objectArTodo(g: GraphDoc, registry: Registry, objId: string): { phys: NodeInstance; ar: NodeInstance } | null {
  const have = physicsOf(g, objId);
  const obj = g.nodes.find((x) => x.id === objId);
  const def = obj ? registry.get(obj.type) : undefined;
  if (!have || !def || !('camera' in def.inputs)) return null;
  if (g.edges.some((e) => e.to.node === objId && e.to.port === 'camera')) return null;
  const todo = arCameraTodo(g, have.phys.id);
  return todo ? { phys: have.phys, ar: todo.ar } : null;
}

/**
 * Give an object physics: find (or create, with a floor) the Physics node of this level, add a body shaped like the object and starting
 * where it is, and wire the body to the object with ONE Motion wire. Already physical: only the kind changes.
 */
export function makePhysical(g: GraphDoc, registry: Registry, objId: string, mode: PhysicalMode): { graph: GraphDoc; physId: string; index: number } {
  const obj = g.nodes.find((x) => x.id === objId);
  if (!obj || !canBePhysical(obj, registry)) throw new Error('Physics cannot move that node.');
  const kind: BodyKind = mode === 'fixed' ? 'fixed' : 'dynamic';
  const have = physicsOf(g, objId);
  if (have) {
    const bodies = normalizeBodies(have.phys.params.bodies);
    if (bodies[have.index]) bodies[have.index] = { ...bodies[have.index], kind };
    return { graph: setBodies(g, have.phys.id, bodies), physId: have.phys.id, index: have.index };
  }
  let next = g;
  let phys = findPhysics(next);
  if (!phys) {
    const made = addNode(next, registry, PHYSICS_TYPE, { x: obj.x - 360, y: obj.y }, { bodies: [], floor: 'auto' });
    next = made.graph;
    phys = made.node;
  }
  const bodies = normalizeBodies(phys.params.bodies);
  if (bodies.length >= MAX_BODIES) throw new Error(`Physics holds at most ${MAX_BODIES} objects.`);
  next = setBodies(next, phys.id, [...bodies, newBody(obj, kind, floorGuess(next, registry, obj))]);
  next = connect(next, registry, { node: phys.id, port: motionPortOf(bodies.length) }, { node: objId, port: MOTION_PORT });
  next = wireCameraInto(next, registry, phys.id, obj);
  return { graph: next, physId: phys.id, index: bodies.length };
}

/** Add an object to a given Physics node (the panel's "Add an object..."). */
export function addObjectTo(g: GraphDoc, registry: Registry, physId: string, objId: string, mode: PhysicalMode = 'falls'): GraphDoc {
  const obj = g.nodes.find((x) => x.id === objId);
  const phys = g.nodes.find((x) => x.id === physId);
  if (!obj || !phys || !canBePhysical(obj, registry)) throw new Error('Physics cannot move that node.');
  const current = physicsOf(g, objId);
  if (current && current.phys.id === physId) return g;
  let next = current ? removeBodyOf(g, objId) : g;
  const bodies = normalizeBodies(next.nodes.find((x) => x.id === physId)!.params.bodies);
  if (bodies.length >= MAX_BODIES) throw new Error(`Physics holds at most ${MAX_BODIES} objects.`);
  next = setBodies(next, physId, [...bodies, newBody(obj, mode === 'fixed' ? 'fixed' : 'dynamic', floorGuess(next, registry, obj))]);
  next = connect(next, registry, { node: physId, port: motionPortOf(bodies.length) }, { node: objId, port: MOTION_PORT });
  return wireCameraInto(next, registry, physId, obj);
}

/** Remove body `index` of a Physics node and close the gap: the wires of later bodies move down one place. */
export function removeBodyAt(g: GraphDoc, physId: string, index: number): GraphDoc {
  const phys = g.nodes.find((x) => x.id === physId);
  if (!phys) return g;
  const bodies = normalizeBodies(phys.params.bodies);
  if (index < 0 || index >= bodies.length) return g;
  const no = index + 1;
  const edges: Edge[] = [];
  for (const e of g.edges) {
    if (e.from.node === physId) {
      const m = MOTION_OUT.exec(e.from.port) ?? OLD_PORT.exec(e.from.port);
      if (m) {
        const prefix = e.from.port.replace(/\d+$/, '');
        const k = Number(m[m.length - 1]);
        if (k === no) continue;
        if (k > no && (prefix === 'motion' || k <= 8)) {
          edges.push({ ...e, from: { ...e.from, port: `${prefix}${k - 1}` } });
          continue;
        }
      }
    }
    if (e.to.node === physId) {
      const m = /^(drive|move|turn)(\d+)$/.exec(e.to.port);
      if (m) {
        const k = Number(m[2]);
        if (k === no) continue;
        if (k > no) {
          edges.push({ ...e, to: { ...e.to, port: `${m[1]}${k - 1}` } });
          continue;
        }
      }
    }
    edges.push(e);
  }
  return setBodies({ ...g, edges }, physId, bodies.filter((_, i) => i !== index));
}

/** Take the object's body out of its Physics node, wire included ("Physics: Off"). The object keeps the place it has in its own settings. */
export function removeBodyOf(g: GraphDoc, objId: string): GraphDoc {
  const have = physicsOf(g, objId);
  return have ? removeBodyAt(g, have.phys.id, have.index) : g;
}

/** Change settings of one body. */
export function updateBody(g: GraphDoc, physId: string, index: number, patch: Partial<BodySpec>): GraphDoc {
  const phys = g.nodes.find((x) => x.id === physId);
  if (!phys) return g;
  const bodies = normalizeBodies(phys.params.bodies);
  if (!bodies[index]) return g;
  bodies[index] = { ...bodies[index], ...patch };
  return setBodies(g, physId, normalizeBodies(bodies));
}

/** "Start here": the object's current Move / Rotate become the start pose of its body. */
export function startHere(g: GraphDoc, objId: string): GraphDoc {
  const have = physicsOf(g, objId);
  const obj = g.nodes.find((x) => x.id === objId);
  if (!have || !obj) return g;
  return updateBody(g, have.phys.id, have.index, startPoseOf(obj));
}

/** The nodes of this level that could be added to physics now (not yet moved by one), for "Add an object...". */
export function addableObjects(g: GraphDoc, registry: Registry): NodeInstance[] {
  return g.nodes.filter((x) => canBePhysical(x, registry) && !physicsOf(g, x.id));
}

/**
 * "Tidy wiring": a body wired the 0.54 way (Position into Move XYZ and Rotation into Rotate XYZ of the same node) becomes one Motion wire.
 * A body wired only one of the two ways is left alone, because a Motion wire would take over the other half as well.
 */
export function tidyWiring(g: GraphDoc, registry: Registry, physId: string): { graph: GraphDoc; converted: number } {
  let next = g;
  let converted = 0;
  for (const link of bodyLinks(g, physId)) {
    if (link.how !== 'vectors' || !link.target || link.index >= 8) continue;
    const posE = next.edges.filter((e) => e.from.node === physId && e.from.port === `pos${link.index + 1}`);
    const rotE = next.edges.filter((e) => e.from.node === physId && e.from.port === `rot${link.index + 1}`);
    for (const pe of posE) {
      const re = rotE.find((r) => r.to.node === pe.to.node);
      const target = next.nodes.find((x) => x.id === pe.to.node);
      const def = target ? registry.get(target.type) : undefined;
      if (!re || !def || !paramMotion(def) || pe.to.port !== 'pos@xyz' || re.to.port !== 'rot@xyz') continue;
      if (next.edges.some((e) => e.to.node === pe.to.node && e.to.port === MOTION_PORT)) continue;
      const rest = next.edges.filter((e) => e.id !== pe.id && e.id !== re.id);
      next = { ...next, edges: [...rest, { id: uid('e'), from: { node: physId, port: motionPortOf(link.index) }, to: { node: pe.to.node, port: MOTION_PORT } }] };
      converted++;
    }
  }
  return { graph: next, converted };
}

/** How many bodies of this Physics node are still wired the old way (Tidy wiring would convert them). */
export function tidyableCount(g: GraphDoc, registry: Registry, physId: string): number {
  return tidyWiring(g, registry, physId).converted;
}

/** The World AR Camera of this level, if there is one. */
export function findWorldAr(g: GraphDoc): NodeInstance | undefined {
  return g.nodes.find((x) => x.type === 'world-ar');
}

/** "Match AR floor" (for Floor: Custom height): Floor height = minus the World AR Camera's Lift (where the real surface is in its object frame). Null when there is none. */
export function matchArFloor(g: GraphDoc, physId: string): GraphDoc | null {
  const ar = findWorldAr(g);
  if (!ar) return null;
  const lift = typeof ar.params.lift === 'number' ? ar.params.lift : 1;
  return setParam(setParam(g, physId, 'floor', 'custom'), physId, 'floorHeight', -lift);
}
