import { describe, expect, it, vi } from 'vitest';

// the store modules read localStorage at construction
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('./editor');
const { Registry, MOTION_PORT } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { createGraph, addNode, validateGraph, connect } = await import('../../engine/graph');
const { normalizeBodies } = await import('../../engine/lib/physics/sim');
const { canBePhysical, colliderFor, physicsOf, tidyWiring, bodyLinks, matchArFloor } = await import('../../engine/lib/physics/objects');
import type { Io } from '../../io/api';
import type { NodeInstance } from '../../engine/types';

const registry = new Registry();
registerBuiltins(registry);

function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  ed.loadGraph(createGraph('t'));
  return ed;
}
const physNodes = (ed: InstanceType<typeof Editor>) => ed.level.nodes.filter((n) => n.type === 'physics');
const node = (type: string, params: Record<string, unknown> = {}): NodeInstance => ({ id: 'x', type, x: 0, y: 0, params });

describe('Physics: Falls / Stays put on an object', () => {
  it('Falls on an SDF Shape inside an SDF Scene makes ONE Physics node with a matching body and ONE wire, in one undo step', () => {
    const ed = setup();
    const scene = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    ed.enterGroup(scene);
    const shape = ed.level.nodes.find((n) => n.type === 'sdf-shape')!;
    ed.setParams(shape.id, { shape: 'box', sizeX: 1, sizeY: 2, sizeZ: 3, objectScale: 2, posX: 0.5, posY: 3, posZ: -1, rotY: 30 });
    const phys = ed.setObjectPhysics(shape.id, 'falls');
    expect(phys).toBeTruthy();
    const p = physNodes(ed);
    expect(p).toHaveLength(1);
    expect(p[0].params.floor).toBe(true);
    const bodies = normalizeBodies(p[0].params.bodies);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ shape: 'box', size: [2, 4, 6], pos: [0.5, 3, -1], rot: [0, 30, 0], kind: 'dynamic' });
    const wires = ed.level.edges.filter((e) => e.from.node === p[0].id);
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({ from: { port: 'motion1' }, to: { node: shape.id, port: MOTION_PORT } });
    // the Physics node is inside the scene, not at the top level
    expect(ed.state.graph.nodes.some((n) => n.type === 'physics')).toBe(false);
    ed.undo(); // ONE undo step takes the Physics node, the body and the wire away together
    expect(physNodes(ed)).toHaveLength(0);
    expect(ed.level.edges.some((e) => e.to.port === MOTION_PORT)).toBe(false);
    expect(ed.level.nodes.find((n) => n.id === shape.id)!.params.sizeZ).toBe(3);
  });

  it('a second object reuses the same Physics node; Off removes body and wire and closes the gap', () => {
    const ed = setup();
    const scene = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    ed.enterGroup(scene);
    const a = ed.level.nodes.find((n) => n.type === 'sdf-shape')!;
    const b = ed.addNodeAt('sdf-shape', { x: 0, y: 200 })!;
    const c = ed.addNodeAt('sdf-shape', { x: 0, y: 400 })!;
    const pa = ed.setObjectPhysics(a.id, 'falls');
    const pb = ed.setObjectPhysics(b, 'fixed');
    const pc = ed.setObjectPhysics(c, 'falls');
    expect(pb).toBe(pa);
    expect(pc).toBe(pa);
    expect(physNodes(ed)).toHaveLength(1);
    expect(normalizeBodies(physNodes(ed)[0].params.bodies).map((x) => x.kind)).toEqual(['dynamic', 'fixed', 'dynamic']);
    expect(physicsOf(ed.level, c)?.index).toBe(2);
    ed.setObjectPhysics(b, 'off');
    expect(normalizeBodies(physNodes(ed)[0].params.bodies)).toHaveLength(2);
    expect(physicsOf(ed.level, b)).toBeNull();
    // the wires of the later body moved down: c is now body 2
    expect(physicsOf(ed.level, c)?.index).toBe(1);
    expect(ed.level.edges.filter((e) => e.to.port === MOTION_PORT).map((e) => e.from.port).sort()).toEqual(['motion1', 'motion2']);
    // choosing Falls again after Stays put only changes the kind
    ed.setObjectPhysics(c, 'fixed');
    expect(normalizeBodies(physNodes(ed)[0].params.bodies)[1].kind).toBe('fixed');
    expect(normalizeBodies(physNodes(ed)[0].params.bodies)).toHaveLength(2);
    expect(validateGraph(ed.level, registry)).toEqual([]);
  });

  it('"Add an object..." from the panel adds an existing node to a Physics node, and "Start here" copies the object pose', () => {
    const ed = setup();
    const o = ed.addNodeAt('object-3d', { x: 0, y: 0 })!;
    const p = ed.addNodeAt('physics', { x: -400, y: 0 })!;
    ed.setParam(p, 'bodies', []);
    ed.addObjectToPhysics(p, o);
    expect(physicsOf(ed.level, o)?.phys.id).toBe(p);
    ed.setParams(o, { posX: 1, posY: 2, posZ: 3, rotX: 10, rotY: 20, rotZ: 30 });
    ed.startPhysicsHere(o);
    expect(normalizeBodies(ed.level.nodes.find((n) => n.id === p)!.params.bodies)[0]).toMatchObject({ pos: [1, 2, 3], rot: [10, 20, 30] });
    // the handles' edit moves the start pose with the object
    ed.setObjectPose(o, { posY: 5 });
    expect(normalizeBodies(ed.level.nodes.find((n) => n.id === p)!.params.bodies)[0].pos).toEqual([1, 5, 3]);
    ed.removePhysicsBody(p, 0);
    expect(ed.level.edges.some((e) => e.to.port === MOTION_PORT)).toBe(false);
  });
});

describe('which nodes physics can move', () => {
  it('objects yes; cameras, the scene output and the Physics node itself no', () => {
    for (const t of ['object-3d', 'model-3d', 'sdf-shape', 'sdf-transform']) expect(canBePhysical(node(t), registry), t).toBe(true);
    for (const t of ['sdf-render', 'physics', 'camera', 'blur', 'phone-motion']) expect(canBePhysical(node(t), registry), t).toBe(false);
  });
});

describe('collider mapping', () => {
  it('maps each SDF Shape kind', () => {
    const c = (params: Record<string, unknown>) => colliderFor(node('sdf-shape', params));
    expect(c({ shape: 'sphere', radius: 0.4, objectScale: 2 }).spec).toEqual({ shape: 'sphere', size: [0.8, 1, 1] });
    expect(c({ shape: 'box', sizeX: 1, sizeY: 2, sizeZ: 3 }).spec).toEqual({ shape: 'box', size: [1, 2, 3] });
    expect(c({ shape: 'rbox', sizeX: 1, sizeY: 1, sizeZ: 1 }).spec.shape).toBe('box');
    expect(c({ shape: 'capsule', radius: 0.3, sizeY: 0.8 }).spec).toEqual({ shape: 'capsule', size: [0.3, 0.8, 1] });
    expect(c({ shape: 'cylinder', radius: 0.45, sizeY: 0.7 }).spec).toEqual({ shape: 'cylinder', size: [0.45, 0.7, 1] });
    expect(c({ shape: 'cone', radius: 0.5, sizeY: 1 }).spec.shape).toBe('cylinder');
    expect(c({ shape: 'torus', radius: 0.5, tube: 0.1 }).spec.shape).toBe('box');
    expect(c({ shape: 'plane' }).spec.shape).toBe('box');
    expect(c({ shape: 'octa', radius: 0.5 }).spec.shape).toBe('sphere');
    expect(c({ shape: 'image2d', sizeX: 2, sizeZ: 0.2 }).spec).toEqual({ shape: 'box', size: [2, 2, 0.2] });
    expect(c({ shape: 'torus', radius: 0.5 }).note).toBeTruthy();
  });

  it('maps each 3D Object primitive; a custom model is a box with a note', () => {
    const c = (params: Record<string, unknown>) => colliderFor(node('object-3d', params));
    expect(c({ shape: 'cube' }).spec).toEqual({ shape: 'box', size: [1.9, 1.9, 1.9] });
    expect(c({ shape: 'sphere' }).spec.shape).toBe('sphere');
    expect(c({ shape: 'cylinder' }).spec.shape).toBe('cylinder');
    expect(c({ shape: 'capsule' }).spec.shape).toBe('capsule');
    for (const s of ['cone', 'pyramid', 'torus']) expect(c({ shape: s }).spec.shape, s).toBe('box');
    expect(c({ shape: 'octahedron' }).spec.shape).toBe('sphere');
    const custom = c({ shape: 'custom' });
    expect(custom.spec.shape).toBe('box');
    expect(custom.note).toMatch(/model/);
    expect(c({ shape: 'cube', objectScale: 0.5 }).spec.size[0]).toBeCloseTo(0.95);
  });
});

describe('old 0.54 wiring, Tidy wiring and Match AR floor', () => {
  const oldGraph = () => {
    let g = createGraph('t');
    const p = addNode(g, registry, 'physics', { x: 0, y: 0 }, { bodies: [{ shape: 'sphere', size: [0.5, 1, 1], pos: [0, 2, 0] }, { shape: 'box', size: [1, 1, 1], pos: [1, 3, 0] }] });
    g = p.graph;
    const a = addNode(g, registry, 'sdf-shape', { x: 300, y: 0 });
    g = a.graph;
    const b = addNode(g, registry, 'object-3d', { x: 300, y: 200 });
    g = b.graph;
    for (const [i, t] of [[1, a.node.id], [2, b.node.id]] as const) {
      g = connect(g, registry, { node: p.node.id, port: `pos${i}` }, { node: t, port: 'pos@xyz' });
      g = connect(g, registry, { node: p.node.id, port: `rot${i}` }, { node: t, port: 'rot@xyz' });
    }
    return { g, phys: p.node.id, a: a.node.id, b: b.node.id };
  };

  it('old wires are recognised, the graph is valid, and Tidy wiring turns each pair into one Motion wire', () => {
    const { g, phys, a, b } = oldGraph();
    expect(validateGraph(g, registry)).toEqual([]);
    expect(bodyLinks(g, phys).map((l) => [l.target?.id, l.how])).toEqual([[a, 'vectors'], [b, 'vectors']]);
    expect(physicsOf(g, a)).toMatchObject({ index: 0, how: 'vectors' });
    const r = tidyWiring(g, registry, phys);
    expect(r.converted).toBe(2);
    expect(r.graph.edges).toHaveLength(2);
    expect(r.graph.edges.map((e) => `${e.from.port}>${e.to.port}`).sort()).toEqual([`motion1>${MOTION_PORT}`, `motion2>${MOTION_PORT}`]);
    expect(validateGraph(r.graph, registry)).toEqual([]);
    expect(tidyWiring(r.graph, registry, phys).converted).toBe(0);
  });

  it('a body wired only one of the two ways is not converted', () => {
    const { g, phys } = oldGraph();
    const half = { ...g, edges: g.edges.filter((e) => e.from.port !== 'rot1') };
    expect(tidyWiring(half, registry, phys).converted).toBe(1);
  });

  it('Match AR floor sets the floor to minus the World AR Camera Lift, and does nothing without one', () => {
    let g = createGraph('t');
    const p = addNode(g, registry, 'physics');
    g = p.graph;
    expect(matchArFloor(g, p.node.id)).toBeNull();
    const ar = addNode(g, registry, 'world-ar', { x: 0, y: 300 }, { lift: 0.4 });
    g = ar.graph;
    const m = matchArFloor(g, p.node.id)!;
    const n = m.nodes.find((x) => x.id === p.node.id)!;
    expect(n.params.floorHeight).toBeCloseTo(-0.4);
    expect(n.params.floor).toBe(true);
  });

  it('the editor action converts and is one undo step', () => {
    const ed = setup();
    const { g, phys } = oldGraph();
    ed.loadGraph(g);
    expect(ed.tidyPhysicsWiring(phys)).toBe(2);
    expect(ed.level.edges.every((e) => e.to.port === MOTION_PORT)).toBe(true);
    ed.undo();
    expect(ed.level.edges).toHaveLength(4);
  });
});

describe('the Physics node surface', () => {
  const def = registry.get('physics')!;
  const shown = (params: Record<string, unknown>, ports: Record<string, { visibleIf?: (p: Record<string, unknown>) => boolean }>) => Object.entries(ports).filter(([, d]) => !d.visibleIf || d.visibleIf(params)).map(([k]) => k);

  it('lists one Motion output per body and nothing else at rest', () => {
    const two = { bodies: [{ shape: 'sphere' }, { shape: 'box' }] };
    expect(shown(two, def.outputs as never)).toEqual(['motion1', 'motion2']);
    expect(shown({ bodies: [] }, def.outputs as never)).toEqual([]);
    expect(shown({ ...two, advOut: true }, def.outputs as never)).toEqual(expect.arrayContaining(['motion1', 'motion2', 'image', 'moving', 'hits', 'pos1', 'rot8', 'posExtra']));
    // no inputs at rest, a Motion input only for a body moved by wires, the old sockets under Advanced inputs
    expect(shown(two, def.inputs as never)).toEqual([]);
    expect(shown({ bodies: [{ shape: 'box' }, { shape: 'box', kind: 'kinematic' }] }, def.inputs as never)).toEqual(['drive2']);
    expect(shown({ ...two, advIn: true }, def.inputs as never)).toEqual(expect.arrayContaining(['gravityVec', 'push', 'pushNow', 'camera', 'move1', 'turn4']));
  });

  it('the preview is what you see when the node is viewed, and the row says what each body is', () => {
    expect(def.previewOutput).toBe('image');
    expect(def.portLabel?.('out', 'motion2', { bodies: [{ shape: 'sphere' }, { shape: 'box' }] })).toBe('Body 2 · box');
    expect(def.summary?.({ bodies: [{}, {}, {}], floor: true } as never)).toBe('3 objects · floor on');
  });
});

describe('the layout shows hidden sockets while they are wired', () => {
  it('a wired old output or an unused Motion input appears; unwired ones do not', async () => {
    const { layoutNode } = await import('../lib/layout');
    const n: NodeInstance = { id: 'p', type: 'physics', x: 0, y: 0, params: { bodies: [{ shape: 'sphere' }, { shape: 'box' }] } };
    const rowsOf = (view?: { wiredIo?: string[] }) => {
      const l = layoutNode({ ...n }, def(), undefined, false, {}, { expanded: false, wired: [], ...view });
      return l.rows.flatMap((r) => (r.kind === 'io' && r.output ? [r.output.port] : []));
    };
    expect(rowsOf()).toEqual(['motion1', 'motion2']);
    expect(rowsOf({ wiredIo: ['out:pos1'] })).toEqual(['motion1', 'motion2', 'pos1']);
  });
});
const def = () => registry.get('physics')!;
