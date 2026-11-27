/**
 * The "Falling shapes" template: an SDF Scene (a group) holding five shapes and a floor slab, driven by a Physics node that lives inside the
 * same scene. Built by hand because a template is plain data (no registry at hand): the group has the same shape `newSdfScene` makes
 * (src/engine/sdf-scene-group.ts), with the Physics node, five shapes, a Combine and the Scene Output inside.
 */
import { GROUP_IN, GROUP_OUT, GROUP_TYPE, snapshotParamDef, type GroupExposed, type GroupPort } from '../engine/group';
import { SDF_RENDER_ID, SDF_RENDER_TYPE, SDF_SCENE_EXTRA_INPUTS, SDF_SCENE_PARAMS } from '../engine/lib/sdf-scene-params';
import type { Edge, NodeInstance, ParamDef } from '../engine/types';

const BODIES = [
  { shape: 'sphere', size: [0.5, 1, 1], pos: [-1.1, 1.4, 0.1], bounce: 0.6 },
  { shape: 'box', size: [0.9, 0.9, 0.9], pos: [0.1, 2.2, 0], rot: [15, 25, 10], bounce: 0.3 },
  { shape: 'capsule', size: [0.3, 0.8, 1], pos: [1.2, 3.0, 0.2], rot: [0, 0, 70], bounce: 0.4 },
  { shape: 'cylinder', size: [0.45, 0.7, 1], pos: [-0.4, 3.8, -0.1], rot: [20, 0, 15], bounce: 0.3 },
  { shape: 'sphere', size: [0.38, 1, 1], pos: [0.5, 4.5, 0.1], bounce: 0.75 },
];
const SHAPE_PARAMS: Record<string, unknown>[] = [
  { shape: 'sphere', radius: 0.5, color: [0.95, 0.45, 0.3, 1] },
  { shape: 'box', sizeX: 0.9, sizeY: 0.9, sizeZ: 0.9, color: [0.35, 0.65, 0.95, 1] },
  { shape: 'capsule', radius: 0.3, sizeY: 0.8, color: [0.5, 0.85, 0.5, 1] },
  { shape: 'cylinder', radius: 0.45, sizeY: 0.7, color: [0.95, 0.8, 0.3, 1] },
  { shape: 'sphere', radius: 0.38, color: [0.8, 0.5, 0.9, 1] },
];

/** The scene node (id `scene`) of the template. */
export function fallingShapesScene(at: { x: number; y: number }): NodeInstance {
  const nodes: NodeInstance[] = [
    { id: 'phys', type: 'physics', x: 40, y: 20, params: { bodies: BODIES, floor: true, floorHeight: -1, floorBounce: 0.3, walls: true, roomWidth: 8, roomDepth: 8, drag: 0.5 }, label: 'Physics: bodies 1 to 5' },
    ...SHAPE_PARAMS.map((params, i) => ({ id: `shape${i + 1}`, type: 'sdf-shape', x: 360, y: 20 + i * 150, params })),
    { id: 'floor', type: 'sdf-shape', x: 360, y: 20 + 5 * 150, params: { shape: 'box', sizeX: 9, sizeY: 0.4, sizeZ: 9, posY: -1.2, color: [0.55, 0.57, 0.62, 1] }, label: 'Floor' },
    { id: 'comb', type: 'sdf-combine', x: 680, y: 40, params: {} },
    { id: SDF_RENDER_ID, type: SDF_RENDER_TYPE, x: 960, y: 40, params: {} },
  ];
  const inputs: GroupPort[] = Object.entries(SDF_SCENE_EXTRA_INPUTS).map(([pid, d]) => ({ id: pid, name: d.label ?? pid, type: d.type }));
  const outputs: GroupPort[] = [
    { id: 'image', name: 'Image', type: 'image' },
    { id: 'depth', name: 'Depth', type: 'image' },
    { id: 'sdf', name: 'Scene', type: 'sdf' },
  ];
  let n = 0;
  const wire = (from: Edge['from'], to: Edge['to']): Edge => ({ id: `e${++n}`, from, to });
  const edges: Edge[] = [];
  for (let i = 0; i < 5; i++) {
    edges.push(wire({ node: 'phys', port: `pos${i + 1}` }, { node: `shape${i + 1}`, port: 'pos@xyz' }));
    edges.push(wire({ node: 'phys', port: `rot${i + 1}` }, { node: `shape${i + 1}`, port: 'rot@xyz' }));
    edges.push(wire({ node: `shape${i + 1}`, port: 'sdf' }, { node: 'comb', port: 'items' }));
  }
  edges.push(wire({ node: 'floor', port: 'sdf' }, { node: 'comb', port: 'items' }));
  edges.push(wire({ node: 'comb', port: 'sdf' }, { node: SDF_RENDER_ID, port: 'scene' }));
  for (const p of inputs) edges.push(wire({ node: GROUP_IN, port: p.id }, { node: SDF_RENDER_ID, port: p.id }));
  for (const p of outputs) edges.push(wire({ node: SDF_RENDER_ID, port: p.id }, { node: GROUP_OUT, port: p.id }));
  const exposed: GroupExposed[] = Object.entries(SDF_SCENE_PARAMS).map(([key, def]) => ({ id: key, label: (def as ParamDef).label ?? key, node: SDF_RENDER_ID, param: key, def: snapshotParamDef(def as ParamDef) }));
  return { id: 'scene', type: GROUP_TYPE, x: at.x, y: at.y, params: { kind: 'group', title: 'Falling shapes', color: 'sdf', sdfScene: true, nodes, edges, inputs, outputs, exposed, rotX: -30, scale: 0.19, posY: -1.3, fov: 18 } };
}
