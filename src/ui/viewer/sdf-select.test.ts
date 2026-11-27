import { describe, expect, it, vi } from 'vitest';

// the store modules read localStorage at construction
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('../store/editor');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { createGraph } = await import('../../engine/graph');
const { defOf } = await import('../../engine/group');
const { sdfCombine, sdfMod, sdfMove, sdfShape } = await import('../../engine/lib/sdf-scene');
const { drivenParams, resetPatch, transformOf } = await import('../lib/xform3d');
const { gizmoTarget } = await import('./gizmoTarget');
const { planTap, sceneAround, sdfPictureScene, sdfViewFallback } = await import('../lib/sdf-view');
const { chainOf, composeFrames, frameOfPlace, modHint, toLocal, toWorld } = await import('./sdfHandles');
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

/** A project with one SDF Scene (`scene` id returned) holding the starter sphere `shape1`, a second shape `shape2` and an SDF Move `move1`; the editor is outside. */
function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  ed.loadGraph(createGraph('t'));
  const scene = ed.addNodeAt('sdf-scene', { x: 10, y: 20 })!;
  ed.enterGroup(scene);
  const shape2 = ed.addNodeAt('sdf-shape', { x: 100, y: 100 })!;
  const move1 = ed.addNodeAt('sdf-transform', { x: 200, y: 100 })!;
  ed.exitGroup(0);
  ed.select([]);
  return { ed, scene, shape2, move1 };
}
const target = (ed: InstanceType<typeof Editor>) => gizmoTarget(ed.state.level, ed.state.selection, ed.state.viewedNodeId, ed.state.path, registry, ed.state.graph);

describe('handles: which node they belong to', () => {
  it('SDF Shape and SDF Move count as 3D objects, and so does the SDF Scene node (its exposed Move / Rotate / Size / camera)', () => {
    const { ed, scene } = setup();
    expect(transformOf(registry.get('sdf-shape'))?.kind).toBe('object');
    expect(transformOf(registry.get('sdf-transform'))?.kind).toBe('object');
    expect(transformOf(defOf(registry, ed.state.graph.nodes.find((n) => n.id === scene)))?.kind).toBe('object');
    // Place in 3D: the shape's reset writes only its own position, rotation, size
    const t = transformOf(registry.get('sdf-shape'))!;
    expect(Object.keys(resetPatch(t, 'all')).sort()).toEqual(['objectScale', 'posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ']);
    // a wired position leaves the handles locked and the reset alone
    const driven = drivenParams(registry.get('sdf-shape')!, ['posX']);
    expect(driven.has('posX')).toBe(true);
    expect(Object.keys(resetPatch(t, 'position', driven)).sort()).toEqual(['posY', 'posZ']);
  });

  it('outside: selecting the scene targets the scene (the whole scene moves)', () => {
    const { ed, scene } = setup();
    ed.setViewed(scene);
    ed.select([scene]);
    expect(target(ed)).toBe(scene);
  });

  it('inside: selecting an inner shape targets THAT shape, a different one targets the other, the scene stays untouched', () => {
    const { ed, scene, shape2, move1 } = setup();
    ed.setViewed(scene); // the viewer shows the scene's picture
    ed.enterGroup(scene);
    ed.select(['shape1']);
    expect(target(ed)).toBe('shape1');
    ed.select([shape2]);
    expect(target(ed)).toBe(shape2);
    ed.select([move1]);
    expect(target(ed)).toBe(move1);
    // nothing selected: no handles; two selected: none
    ed.select([]);
    expect(target(ed)).toBeNull();
    ed.select(['shape1', shape2]);
    expect(target(ed)).toBeNull();
  });

  it('a shape of another scene, or a viewer showing something unrelated, gets no handles', () => {
    const { ed, scene } = setup();
    const other = ed.addNodeAt('sdf-scene', { x: 400, y: 0 })!;
    ed.enterGroup(scene);
    ed.select(['shape1']);
    ed.setViewed(other); // the viewer shows another scene
    expect(target(ed)).toBeNull();
    ed.setViewed(scene);
    expect(target(ed)).toBe('shape1');
  });
});

describe('the viewer picture while inside a scene', () => {
  it('viewing an SDF node (they have no picture) falls back to the Scene Output of the scene around it', () => {
    const { ed, scene, shape2 } = setup();
    const g = ed.state.graph;
    expect(sdfViewFallback(g, `${scene}/shape1`, registry)).toBe(`${scene}/render`);
    expect(sdfViewFallback(g, `${scene}/${shape2}`, registry)).toBe(`${scene}/render`);
    // the scene itself, its output and ordinary nodes keep what they show
    expect(sdfViewFallback(g, scene, registry)).toBeNull();
    expect(sdfViewFallback(g, `${scene}/render`, registry)).toBeNull();
    expect(sdfViewFallback(g, null, registry)).toBeNull();
    expect(sceneAround(g, `${scene}/shape1`)).toEqual([scene]);
    expect(sceneAround(g, scene)).toBeNull();
  });

  it('the picture scene: the scene itself, its Scene Output, an SDF node inside, or the single scene feeding the viewed node', () => {
    const { ed, scene } = setup();
    const g = ed.state.graph;
    for (const v of [scene, `${scene}/render`, `${scene}/shape1`]) expect(sdfPictureScene(g, v, registry), v).toEqual([scene]);
    expect(sdfPictureScene(g, null, registry)).toBeNull();
    // a blur after the scene
    const blur = ed.addNodeAt('blur', { x: 300, y: 0 })!;
    ed.editLevel((l) => ({ ...l, edges: [...l.edges, { id: 'w1', from: { node: scene, port: 'image' }, to: { node: blur, port: 'image' } }] }));
    expect(sdfPictureScene(ed.state.graph, blur, registry)).toEqual([scene]);
  });
});

describe('tap to select', () => {
  const base = { selection: [] as string[], insideScene: true };
  it('inside the scene: the tapped shape is selected; background deselects', () => {
    expect(planTap({ ...base, path: ['sc'], picked: 'sc/shape2' })).toEqual({ kind: 'select', path: ['sc'], node: 'shape2' });
    expect(planTap({ ...base, path: ['sc'], picked: null })).toEqual({ kind: 'deselect' });
  });
  it('outside: the first tap selects the scene, a tap while it is selected goes in and selects the shape', () => {
    const out = { ...base, insideScene: false, path: [] as string[] };
    expect(planTap({ ...out, picked: 'sc/shape2' })).toEqual({ kind: 'select', path: [], node: 'sc', hint: 'first' });
    expect(planTap({ ...out, selection: ['sc'], picked: 'sc/shape2' })).toEqual({ kind: 'select', path: [], node: 'sc', enter: { inner: 'shape2' } });
    expect(planTap({ ...out, picked: null })).toEqual({ kind: 'none' });
  });
  it('a shape of a nested scene selects the nested scene node; a second tap goes in', () => {
    expect(planTap({ ...base, path: ['outer'], picked: 'outer/inner/shape1' })).toEqual({ kind: 'select', path: ['outer'], node: 'inner', hint: 'first' });
    expect(planTap({ ...base, path: ['outer'], selection: ['inner'], picked: 'outer/inner/shape1' })).toEqual({ kind: 'select', path: ['outer'], node: 'inner', enter: { inner: 'shape1' } });
    // inside the nested scene itself the shape is selected directly
    expect(planTap({ ...base, path: ['outer', 'inner'], picked: 'outer/inner/shape1' })).toEqual({ kind: 'select', path: ['outer', 'inner'], node: 'shape1' });
  });
  it('a shape of a scene wired in from outside selects that scene where the two meet, instead of diving across levels', () => {
    // the open scene is `b`; the tapped shape belongs to scene `a` that sits next to it at the top level
    expect(planTap({ ...base, path: ['b'], picked: 'a/shape1' })).toEqual({ kind: 'select', path: [], node: 'a', hint: 'wired' });
    expect(planTap({ ...base, path: ['b'], picked: 'b/shape1' })).toEqual({ kind: 'select', path: ['b'], node: 'shape1' });
  });
});

describe('the chain above a node, from the evaluated tree', () => {
  const s = sdfShape('sc/s', 'sphere', { size: [0.2, 0, 0], pos: [0.3, 0, 0] });
  const inner = sdfMove('sc/mv', s, { pos: [0, 1, 0], rot: [0, 0, 90], scale: 2 });
  const root = sdfMove('sc/render', sdfCombine('sc/comb', 'union', [inner, sdfShape('sc/o', 'box', {})]), { pos: [5, 0, 0], scale: 3 });

  it('composes the scene move and the SDF Move above the shape, and inverts them exactly', () => {
    const ch = chainOf(root, 'sc/s')!;
    expect(ch.frame.s).toBeCloseTo(6, 9);
    // the shape's own position (0.3, 0, 0): the Move turns it to (0, 0.3, 0), doubles it, adds (0, 1, 0), then the scene triples and shifts it
    const w = toWorld(ch.frame, [0.3, 0, 0]);
    expect(w[0]).toBeCloseTo(5, 6);
    expect(w[1]).toBeCloseTo(3 * (1 + 0.6), 6);
    const back = toLocal(ch.frame, w);
    expect(back[0]).toBeCloseTo(0.3, 9);
    expect(back[1]).toBeCloseTo(0, 9);
    // the other shape only has the scene above it
    expect(chainOf(root, 'sc/o')!.frame.s).toBeCloseTo(3, 9);
    expect(chainOf(root, 'sc/nothing')).toBeNull();
    // composing by hand gives the same frame
    const by = composeFrames(frameOfPlace(root as never), frameOfPlace(inner));
    expect(by.s).toBeCloseTo(ch.frame.s, 9);
  });

  it('modifiers that put copies elsewhere are listed (not undone); round and shell are not', () => {
    const under = sdfMod('m1', 'mirror', sdfMod('m2', 'round', sdfMod('m3', 'twist', s, { v: [0.5] }), { v: [0.1] }), { axes: [true, false, false] });
    const r = sdfMove('r', under);
    const ch = chainOf(r, 'sc/s')!;
    expect(ch.mods).toEqual(['mirror', 'twist']);
    expect(modHint(ch.mods)).toContain('Mirror / Twist');
    expect(modHint([])).toBeNull();
  });
});
