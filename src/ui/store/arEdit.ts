/**
 * "Move: One object" in the AR view, editor side: which objects stand on this World AR Camera, which one a tap picked, and how a finger
 * gesture becomes that node's OWN numbers (Move, Rotate, Object scale) as one undo step. The AR view (io/world-ar/loop.ts) only
 * knows the interface in io/world-ar/edit-host.ts; everything that needs nodes lives here.
 *
 * Which objects count: the nodes whose Camera input is wired from this camera, directly or through a Physics node (the same list as
 * "Objects in AR"), and the shapes of an SDF Scene on this camera. Nothing else is touched.
 */
import { cameraRows, WORLD_AR_ID } from '../../engine/lib/ar-setup';
import { raySphere } from '../../engine/lib/ar-pick';
import { defOf, groupData, levelGraph, PATH_SEP } from '../../engine/group';
import { motionPortOf, physicsOf, PHYSICS_TYPE } from '../../engine/lib/physics/objects';
import { normalizeBodies } from '../../engine/lib/physics/sim';
import { SDF_RENDER_ID } from '../../engine/lib/sdf-scene-params';
import { sdfBounds } from '../../engine/lib/sdf-scene';
import { sdfRay } from '../../engine/lib/sdf-eval';
import { isSdfSceneNode } from '../../engine/sdf-scene-group';
import type { ArChange, ArEditHost, ArSelected } from '../../io/world-ar/edit-host';
import { stampWorldAr, worldArNodeIds } from '../../io/world-ar/engine-source';
import type { MotionValue, NodeInstance, SdfValue } from '../../engine/types';
import { clampTo, roundTo, turnRoll, type Euler } from '../viewer/gizmoMath';
import { chainOf, IDENTITY_FRAME, toLocal, toWorld, type Frame } from '../viewer/sdfHandles';
import { drivenParams, OBJECT_KEYS, OBJECT_RADIUS, transformOf } from '../lib/xform3d';
import { nodeDisplayName } from '../lib/nodeTitle';
import type { AppCtx } from './context';
import type { Vec3 } from '../../engine/lib/motion-math';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

/** What is known about a picked thing between its pick and the end of the gesture. */
interface Info {
  id: string;
  /** The level the node lives on (group ids from the top) and its id there. */
  path: string[];
  nodeId: string;
  kind: 'plain' | 'physics' | 'shape';
  /** The space the node's own numbers are written in (the SDF Scene's chain above a shape; identity otherwise). */
  frame: Frame;
  /** A shape's reach in the root's space, scene units. */
  reach: number;
}

interface Snap {
  pos: Vec3;
  rot: Euler;
  scale: number;
}

const DEG_TO_RAD = Math.PI / 180;
/** From the middle of a 3D object to its lowest point, scene units (the family's primitives fill a ball of about this radius). */
const objectSize = (scale: number): number => OBJECT_RADIUS * scale;
const num = (p: Record<string, unknown>, k: string, d = 0): number => (typeof p[k] === 'number' ? (p[k] as number) : d);
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function createArEditHost(app: Ctx, camId: string): ArEditHost {
  const { io, ed } = app;
  const infos = new Map<string, Info>();
  let snap: Snap | null = null;
  let held = false;

  const levelOf = (path: readonly string[]) => levelGraph(ed.state.graph, path);
  const nodeOf = (i: Info): NodeInstance | null => levelOf(i.path).nodes.find((n) => n.id === i.nodeId) ?? null;
  const nameOf = (n: NodeInstance) => nodeDisplayName(n, defOf(ed.registry, n));

  /** The objects of this camera at the level that is open. */
  const onCamera = (): NodeInstance[] => {
    const level = ed.level;
    const ids = new Set(cameraRows(level, ed.registry, camId, () => '').filter((r) => r.state === 'yes' || r.state === 'physics').map((r) => r.id));
    return level.nodes.filter((n) => ids.has(n.id) && n.type !== PHYSICS_TYPE && n.type !== WORLD_AR_ID);
  };
  const isPlain = (n: NodeInstance): boolean => !isSdfSceneNode(n) && transformOf(defOf(ed.registry, n))?.kind === 'object';
  const shapesOf = (scene: NodeInstance): NodeInstance[] => groupData(scene).nodes.filter((n) => n.type === 'sdf-shape');

  const bodyOf = (n: NodeInstance, level = ed.level) => {
    const have = physicsOf(level, n.id);
    return have ? { have, body: normalizeBodies(have.phys.params.bodies)[have.index] ?? null } : null;
  };

  /** The base numbers a gesture changes: a falling object's body start pose, otherwise the node's own Move / Rotate. */
  const baseOf = (i: Info): Snap | null => {
    const n = nodeOf(i);
    if (!n) return null;
    const p = n.params;
    const phys = i.kind === 'physics' ? bodyOf(n, levelOf(i.path)) : null;
    const pos: Vec3 = phys?.body ? [...phys.body.pos] as Vec3 : [num(p, 'posX'), num(p, 'posY'), num(p, 'posZ')];
    const rot: Euler = phys?.body ? [...phys.body.rot] as Euler : [num(p, 'rotX'), num(p, 'rotY'), num(p, 'rotZ')];
    return { pos, rot, scale: Math.max(0.001, num(p, OBJECT_KEYS.scale, 1)) };
  };

  const describe = (i: Info): ArSelected | null => {
    const n = nodeOf(i);
    const base = baseOf(i);
    if (!n || !base) return null;
    const def = defOf(ed.registry, n);
    const wired = new Set(levelOf(i.path).edges.filter((e) => e.to.node === n.id).map((e) => e.to.port));
    const driven = def ? drivenParams(def, wired) : new Set<string>();
    // a Physics node moves its object by design: the gestures edit the body's start pose instead
    const free = i.kind === 'physics';
    const locked = { move: !free && OBJECT_KEYS.pos.some((k) => driven.has(k)), turn: !free && OBJECT_KEYS.rot.some((k) => driven.has(k)), size: driven.has(OBJECT_KEYS.scale) };
    const centre = i.kind === 'shape' ? toWorld(i.frame, base.pos) : base.pos;
    const shape = i.kind === 'shape';
    // a generous ball around it: picking and the ring do not need to be exact
    return { id: i.id, name: nameOf(n), centre, radius: shape ? Math.max(0.05, i.reach) : objectSize(base.scale) * 1.35, half: shape ? Math.max(0.05, i.reach * 0.7) : objectSize(base.scale), physics: i.kind === 'physics', locked };
  };

  const rangeOf = (n: NodeInstance, k: string): [number, number] => {
    const p = (defOf(ed.registry, n)?.params as Record<string, { min?: number; max?: number }> | undefined)?.[k];
    return [p?.min ?? -Infinity, p?.max ?? Infinity];
  };

  const write = (i: Info, n: NodeInstance, patch: Record<string, unknown>) => {
    const key = `ar-one:${i.id}`;
    if (i.kind === 'physics') ed.setObjectPose(n.id, patch, key);
    else if (same(i.path, ed.state.path)) ed.setParams(n.id, patch, key);
    else ed.setParamsAt(i.path, n.id, patch, key);
  };

  /** The live pose of a falling object, from the same run the picture shows (null = not known: its start pose is used). */
  const livePose = async (stamped: ReturnType<typeof stampWorldAr>, n: NodeInstance, seconds: number): Promise<Vec3 | null> => {
    const have = physicsOf(ed.level, n.id);
    if (!have) return null;
    try {
      const v = (await io.evaluate(stamped, ed.fullId(have.phys.id), { port: motionPortOf(have.index), seconds, item: ed.state.item, proxy: 0.1 })) as MotionValue | null;
      return v && v.kind === 'motion' && Array.isArray(v.pos) ? [v.pos[0], v.pos[1], v.pos[2]] : null;
    } catch {
      return null;
    }
  };

  return {
    available() {
      const list = onCamera();
      if (!list.length) return false;
      return list.length > 1 || list.some((n) => !!physicsOf(ed.level, n.id) || (isSdfSceneNode(n) && shapesOf(n).length > 1));
    },

    fit() {
      const cam = ed.level.nodes.find((n) => n.id === camId);
      return { unit: Math.max(1e-6, num(cam?.params ?? {}, 'size', 0.5) / 2), lift: num(cam?.params ?? {}, 'lift', 1) };
    },

    async pick(ray, moment, seconds) {
      const g = ed.state.graph;
      const list = onCamera();
      const stamped = list.some((n) => physicsOf(ed.level, n.id)) ? stampWorldAr(g, worldArNodeIds(g), moment) : g;
      let best: { t: number; info: Info } | null = null;
      const offer = (t: number | null, info: Info) => {
        if (t !== null && (!best || t < best.t)) best = { t, info };
      };
      for (const n of list) {
        if (isSdfSceneNode(n)) continue;
        if (!isPlain(n)) continue;
        const phys = bodyOf(n);
        const info: Info = { id: n.id, path: [...ed.state.path], nodeId: n.id, kind: phys ? 'physics' : 'plain', frame: IDENTITY_FRAME, reach: 0 };
        const base = baseOf(info);
        if (!base) continue;
        // a falling object is picked where it is NOW (the same run the picture shows), not where it starts
        const at = phys ? ((await livePose(stamped, n, seconds)) ?? base.pos) : base.pos;
        offer(raySphere(ray.origin, ray.dir, at, objectSize(base.scale) * 1.35), info);
      }
      for (const n of list.filter(isSdfSceneNode)) {
        const scene = [...ed.state.path, n.id];
        let v: SdfValue | null = null;
        try {
          v = (await io.evaluate(g, [...scene, SDF_RENDER_ID].join(PATH_SEP), { port: 'sdf', seconds, item: ed.state.item, proxy: 0.1 })) as SdfValue | null;
        } catch {
          v = null;
        }
        if (!v || v.kind !== 'sdf' || !v.root) continue;
        const hit = sdfRay(v.root, ray.origin, ray.dir, { picture: v.picture });
        if (!hit?.id) continue;
        const chain = chainOf(v.root, hit.id);
        const parts = hit.id.split(PATH_SEP);
        if (!chain || parts.length < 2) continue;
        const reach = sdfBounds(chain.node).radius * chain.frame.s;
        offer(hit.t, { id: hit.id, path: parts.slice(0, -1), nodeId: parts[parts.length - 1], kind: 'shape', frame: chain.frame, reach: Number.isFinite(reach) ? reach : 1 });
      }
      const chosen = best as { t: number; info: Info } | null;
      if (!chosen) return null;
      infos.set(chosen.info.id, chosen.info);
      return describe(chosen.info);
    },

    selected(id) {
      const i = infos.get(id);
      return i ? describe(i) : null;
    },

    begin(id) {
      const i = infos.get(id);
      if (!i || held) return;
      snap = baseOf(i);
      held = true;
      ed.beginHold();
    },

    apply(id, change: ArChange) {
      const i = infos.get(id);
      const n = i && nodeOf(i);
      if (!i || !n) return;
      if (!snap) snap = baseOf(i);
      const s = snap;
      if (!s) return;
      const patch: Record<string, unknown> = {};
      const phys = i.kind === 'physics';
      const cur = baseOf(i)!;
      let pos = cur.pos;
      let rot = cur.rot;
      if (change.move) pos = i.kind === 'shape' ? toLocal(i.frame, change.move) : change.move;
      if (change.turn !== undefined) {
        // the room's up axis in the scene is +y, and the scene is the room with z turned round: a twist of +deg is a turn of -deg here
        rot = turnRoll({ fwd: [0, 1, 0] }, s.rot, -change.turn * DEG_TO_RAD, s.rot, i.kind === 'shape' ? i.frame.R : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      }
      if (change.move || phys) OBJECT_KEYS.pos.forEach((k, j) => (patch[k] = roundTo(clampTo(pos[j], ...rangeOf(n, k)), 3)));
      if (change.turn !== undefined || phys) OBJECT_KEYS.rot.forEach((k, j) => (patch[k] = roundTo(clampTo(rot[j], ...rangeOf(n, k)), 1)));
      write(i, n, patch);
      if (change.scale !== undefined && change.scale > 0) {
        const k = OBJECT_KEYS.scale;
        const v = roundTo(clampTo(s.scale * change.scale, ...rangeOf(n, k)), 3);
        // the size of a falling object is not part of its start pose: an ordinary write
        if (same(i.path, ed.state.path)) ed.setParams(n.id, { [k]: v }, `ar-one:${i.id}`);
        else ed.setParamsAt(i.path, n.id, { [k]: v }, `ar-one:${i.id}`);
      }
    },

    end(id) {
      void id;
      snap = null;
      if (held) {
        held = false;
        ed.endHold();
      }
    },
  };
}
