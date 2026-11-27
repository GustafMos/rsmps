/**
 * SDF Scene = a group node with the marker `sdfScene: true` (group.ts `GroupData.sdfScene`) whose inside holds SDF nodes around one Scene
 * Output node (`sdf-render`, id `render`). The group is flattened like any group, so a scene costs nothing extra, wired params, drivers
 * and the clock reach the inner nodes, and a scene wired into another scene is just a group output of type `sdf`.
 *
 * What this file adds: building a fresh scene (pre-filled with one Sphere), and the PLACEMENT RULE: SDF nodes (shape, combine, move,
 * modify, scene output) can only live inside an SDF Scene. The editor asks `sdfPlacementProblem` before adding, pasting or ungrouping;
 * the engine itself tolerates a stray one (it only produces an `sdf` value that nothing draws).
 */
import { defaultParams } from './engine';
import { GROUP_IN, GROUP_OUT, GROUP_TYPE, groupAtPath, groupData, snapshotParamDef, type GroupExposed, type GroupPort } from './group';
import { SDF_RENDER_ID, SDF_RENDER_TYPE, SDF_SCENE_EXTRA_INPUTS, SDF_SCENE_PARAMS } from './lib/sdf-scene-params';
import type { AnyNodeDef, Edge, GraphDoc, NodeInstance, ParamDef } from './types';
import type { Registry } from './define';

export const SDF_SCENE_TYPE = 'sdf-scene';
export const SDF_SHAPE_TYPE = 'sdf-shape';
/** What a person is told when an SDF node is refused outside a scene. */
export const SDF_HINT = 'Add an SDF Scene first, then open it (double-click) to add SDF shapes inside.';

export const isSdfSceneNode = (n: { type: string; params?: Record<string, unknown> } | null | undefined): boolean => !!n && n.type === GROUP_TYPE && n.params?.sdfScene === true;

/** A node type that may only be added inside an SDF Scene: category `sdf`, except the SDF Scene itself. */
export const isSdfOnlyDef = (def: Pick<AnyNodeDef, 'id' | 'category'> | undefined | null): boolean => !!def && def.category === 'sdf' && def.id !== SDF_SCENE_TYPE;

/** True when the level at `path` (group ids from the top) is inside an SDF Scene (any group on the way is one). */
export function inSdfScene(root: GraphDoc, path: readonly string[]): boolean {
  for (let i = 1; i <= path.length; i++) {
    const g = groupAtPath(root, path.slice(0, i));
    if (!g) return false;
    if (isSdfSceneNode(g)) return true;
  }
  return false;
}

/**
 * Why the nodes of these types cannot go to the level at `path`, or null. `types` are the registry ids of nodes being added or pasted.
 * Nested groups are looked into: a plain group holding SDF nodes counts as holding them.
 */
export function sdfPlacementProblem(root: GraphDoc, path: readonly string[], nodes: readonly Pick<NodeInstance, 'type' | 'params'>[], registry: Pick<Registry, 'get'>): string | null {
  if (inSdfScene(root, path)) return null;
  const stray = (list: readonly Pick<NodeInstance, 'type' | 'params'>[]): boolean =>
    list.some((n) => (n.type === GROUP_TYPE ? !isSdfSceneNode(n) && stray(groupData(n).nodes) : isSdfOnlyDef(registry.get(n.type))));
  return stray(nodes) ? SDF_HINT : null;
}

/** A fresh SDF Scene group node: a Scene Output, one Sphere wired to it, the render settings exposed, camera / material / size inputs, image / depth / scene outputs. */
export function newSdfScene(registry: Pick<Registry, 'get'>, id: string, at: { x: number; y: number }): NodeInstance {
  const renderDef = registry.get(SDF_RENDER_TYPE);
  const shapeDef = registry.get(SDF_SHAPE_TYPE);
  if (!renderDef || !shapeDef) throw new Error('The SDF nodes are not available.');
  const nodes: NodeInstance[] = [
    { id: 'shape1', type: SDF_SHAPE_TYPE, x: 40, y: 60, params: defaultParams(shapeDef) },
    { id: SDF_RENDER_ID, type: SDF_RENDER_TYPE, x: 420, y: 40, params: defaultParams(renderDef) },
  ];
  const inputs: GroupPort[] = Object.entries(SDF_SCENE_EXTRA_INPUTS).map(([pid, d]) => ({ id: pid, name: d.label ?? pid, type: d.type }));
  const outputs: GroupPort[] = [
    { id: 'image', name: 'Image', type: 'image' },
    { id: 'depth', name: 'Depth', type: 'image' },
    { id: 'sdf', name: 'Scene', type: 'sdf' },
  ];
  const wire = (n: number, from: Edge['from'], to: Edge['to']): Edge => ({ id: `e${n}`, from, to });
  const edges: Edge[] = [
    wire(1, { node: 'shape1', port: 'sdf' }, { node: SDF_RENDER_ID, port: 'scene' }),
    ...inputs.map((p, i) => wire(2 + i, { node: GROUP_IN, port: p.id }, { node: SDF_RENDER_ID, port: p.id })),
    ...outputs.map((p, i) => wire(10 + i, { node: SDF_RENDER_ID, port: p.id }, { node: GROUP_OUT, port: p.id })),
  ];
  const exposed: GroupExposed[] = Object.entries(SDF_SCENE_PARAMS).map(([key, def]) => ({ id: key, label: (def as ParamDef).label ?? key, node: SDF_RENDER_ID, param: key, def: snapshotParamDef(def as ParamDef) }));
  return {
    id,
    type: GROUP_TYPE,
    x: Math.round(at.x),
    y: Math.round(at.y),
    params: { kind: 'group', title: 'SDF Scene', color: 'sdf', sdfScene: true, nodes, edges, inputs, outputs, exposed },
  };
}
