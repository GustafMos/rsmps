/**
 * Camera set-up that makes REAL wires for you, from either side: a camera's list of objects ("Objects in AR" / "Objects of this camera")
 * and an object's "Camera" choice. A camera only affects the nodes it is wired to (directly, or through a Physics node's Motion wire),
 * so every connection made here is an ordinary Camera wire the user can see, select and cut. Pure functions on one graph level (the
 * editor runs each as one undo step).
 */
import { MOTION_PORT, type Registry } from '../define';
import { defOf } from '../group';
import { addNode, connect, disconnect, setParam } from '../graph';
import type { Edge, GraphDoc, NodeInstance } from '../types';

type Rec = Record<string, unknown>;

export const WORLD_AR_ID = 'world-ar';
/** Nodes that take a camera as a base to change (rigs, trackers), not to look through. */
const NOT_OBJECTS = new Set([WORLD_AR_ID, 'sdf-render', 'phone-camera-rig', 'marker-camera', 'splat-train']);

type InDef = { type: string; multi?: boolean };
const inputsOf = (node: NodeInstance, registry: Registry) => defOf(registry, node)?.inputs as Record<string, InDef> | undefined;

/** Does this node look through a Camera input (3D Object, SDF 3D, SDF Scene, splats, models, Physics...)? */
export function hasCameraInput(node: NodeInstance | undefined, registry: Registry): boolean {
  if (!node || NOT_OBJECTS.has(node.type)) return false;
  const cam = inputsOf(node, registry)?.camera;
  return !!cam && cam.type === 'camera' && !cam.multi;
}

/** A 3D object that can be shown in AR: has a Camera input and is not the Physics node itself. */
export const canShowInAr = (node: NodeInstance | undefined, registry: Registry): boolean => !!node && node.type !== 'physics' && hasCameraInput(node, registry);

/** The camera nodes of a level: a `camera` output of the camera type and no camera input (World AR Camera, 3D Camera, AR Camera). */
export function cameraNodes(g: GraphDoc, registry: Registry): NodeInstance[] {
  return g.nodes.filter((n) => {
    if (n.bypass) return false;
    const d = defOf(registry, n);
    return !!d && d.outputs.camera?.type === 'camera' && !('camera' in d.inputs);
  });
}

const hasParam = (node: NodeInstance, registry: Registry, key: string): boolean => !!(defOf(registry, node)?.params as Rec | undefined)?.[key];
const wireTo = (g: GraphDoc, id: string, port: string): Edge | undefined => g.edges.find((e) => e.to.node === id && e.to.port === port);

/** Where an object's camera comes from. 'direct': wired in; 'physics': the Physics node that drives it has a camera; 'none': its built-in camera. */
export interface CameraSource {
  kind: 'direct' | 'physics' | 'none';
  /** The camera node (direct, or the one wired into the Physics node); null for a wire from some other node. */
  camera: NodeInstance | null;
}

export function cameraSource(g: GraphDoc, registry: Registry, objId: string): CameraSource {
  const wire = wireTo(g, objId, 'camera');
  const cams = cameraNodes(g, registry);
  if (wire) return { kind: 'direct', camera: cams.find((c) => c.id === wire.from.node) ?? null };
  const drive = wireTo(g, objId, MOTION_PORT);
  const phys = drive && g.nodes.find((n) => n.id === drive.from.node && n.type === 'physics');
  const pw = phys && wireTo(g, phys.id, 'camera');
  const cam = pw ? cams.find((c) => c.id === pw.from.node) : null;
  return cam ? { kind: 'physics', camera: cam } : { kind: 'none', camera: null };
}

/** Make `camId` the camera of these nodes (null: back to the built-in camera): the old Camera wire is replaced, one wire each. */
export function setCameraFor(g: GraphDoc, registry: Registry, objIds: readonly string[], camId: string | null): GraphDoc {
  let next = g;
  for (const id of objIds) {
    const node = next.nodes.find((n) => n.id === id);
    if (!node || !hasCameraInput(node, registry)) continue;
    const old = wireTo(next, id, 'camera');
    if (old && old.from.node === camId) continue;
    if (old) next = disconnect(next, old.id);
    if (camId) next = connect(next, registry, { node: camId, port: 'camera' }, { node: id, port: 'camera' });
  }
  return next;
}

export interface CameraRow {
  id: string;
  /** 'yes': wired to this camera; 'physics': through a Physics node wired to it; 'other': another camera (named in `other`); 'no'. */
  state: 'yes' | 'physics' | 'other' | 'no';
  other: string | null;
  /** null: the node has no "Light from camera". */
  lightOn: boolean | null;
  shadowOn: boolean | null;
}

/** The list of a camera: every node at this level that has a Camera input, and how it relates to this camera. */
export function cameraRows(g: GraphDoc, registry: Registry, camId: string, nameOf: (n: NodeInstance) => string): CameraRow[] {
  return g.nodes
    .filter((n) => hasCameraInput(n, registry))
    .map((n) => {
      const src = cameraSource(g, registry, n.id);
      let state: CameraRow['state'] = 'no';
      let other: string | null = null;
      if (src.camera?.id === camId) state = src.kind === 'physics' ? 'physics' : 'yes';
      else if (src.kind !== 'none') {
        state = 'other';
        const wire = wireTo(g, n.id, 'camera');
        const from = src.camera ?? (wire ? g.nodes.find((x) => x.id === wire.from.node) : null);
        other = from ? nameOf(from) : 'another node';
      }
      return {
        id: n.id,
        state,
        other,
        lightOn: hasParam(n, registry, 'lightFromCamera') ? n.params.lightFromCamera !== false : null,
        shadowOn: hasParam(n, registry, 'groundShadow') ? n.params.groundShadow === true : null,
      };
    });
}

/** "All" / "None" of a camera's list. All takes the nodes that have no camera wire; None frees the nodes wired directly to this camera. Nodes on another camera or through Physics stay. */
export function setAllFor(g: GraphDoc, registry: Registry, camId: string, on: boolean): GraphDoc {
  const ids = g.nodes
    .filter((n) => hasCameraInput(n, registry))
    .filter((n) => {
      const src = cameraSource(g, registry, n.id);
      if (src.kind === 'physics') return false;
      return on ? src.kind === 'none' : src.camera?.id === camId;
    })
    .map((n) => n.id);
  return setCameraFor(g, registry, ids, on ? camId : null);
}

/** The first World AR Camera of the level. */
export function arNodeOf(g: GraphDoc): NodeInstance | null {
  return g.nodes.find((n) => n.type === WORLD_AR_ID && !n.bypass) ?? null;
}

/**
 * "Show in AR" for one or several objects, in one go: a World AR Camera if the level has none (`camId` names the one to use instead),
 * the objects wired to it (real wires, replacing their old Camera wire), their Ground shadow on. Returns the camera's id.
 */
export function showInAr(g: GraphDoc, registry: Registry, objIds: readonly string[], camId?: string | null): { graph: GraphDoc; arId: string } {
  const objs = objIds.map((id) => g.nodes.find((n) => n.id === id)).filter((n): n is NodeInstance => !!n && canShowInAr(n, registry));
  if (!objs.length) throw new Error('Select a 3D object to show in AR.');
  let next = g;
  let ar = (camId ? next.nodes.find((n) => n.id === camId && n.type === WORLD_AR_ID) : null) ?? arNodeOf(next);
  if (!ar) {
    const made = addNode(next, registry, WORLD_AR_ID, { x: Math.min(...objs.map((o) => o.x)) - 300, y: objs[0].y });
    next = made.graph;
    ar = made.node;
  }
  next = setCameraFor(next, registry, objs.map((o) => o.id), ar.id);
  for (const o of objs) if (hasParam(o, registry, 'groundShadow') && o.params.groundShadow !== true) next = setParam(next, o.id, 'groundShadow', true);
  return { graph: next, arId: ar.id };
}

/** The camera light that reaches a node through its camera: 'on' = the camera's light overrides the node's own, 'off' = the node opted out, null = none. */
export function roomLightFor(g: GraphDoc, registry: Registry, nodeId: string): 'on' | 'off' | null {
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!node || !hasParam(node, registry, 'lightFromCamera')) return null;
  const { camera } = cameraSource(g, registry, nodeId);
  if (!camera) return null;
  const carries = camera.type === WORLD_AR_ID ? camera.params.matchLight !== false : camera.params.lightOn === true;
  if (!carries) return null;
  return node.params.lightFromCamera === false ? 'off' : 'on';
}
