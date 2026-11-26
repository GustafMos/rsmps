import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('../store/editor');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { addNode, connect, createGraph } = await import('../../engine/graph');
const { patchIsNoop, resetPatch, transformOf } = await import('./xform3d');
const { gizmoTarget } = await import('../viewer/gizmoTarget');
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

function setup(types: string[], wire = true) {
  const io = { registry, library: { list: () => [], assetInfo: () => null }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  let g: GraphDoc = createGraph('t');
  const ids: string[] = [];
  types.forEach((type, i) => {
    const r = addNode(g, registry, type, { x: i * 400, y: 0 });
    g = r.graph;
    ids.push(r.node.id);
  });
  if (wire) for (let i = 0; i + 1 < ids.length; i++) g = connect(g, registry, { node: ids[i], port: 'image' }, { node: ids[i + 1], port: 'image' });
  ed.loadGraph(g);
  return { ed, ids };
}
const paramsOf = (ed: InstanceType<typeof Editor>, id: string) => ed.state.graph.nodes.find((n) => n.id === id)!.params;

describe('which nodes place something in 3D', () => {
  it('the whole 3D family is recognised by its params; Glass and Hypercube get the reset buttons only', () => {
    const kinds: Record<string, string> = {};
    for (const def of registry.list()) {
      const t = transformOf(def);
      if (t) kinds[def.id] = t.kind;
    }
    expect(kinds).toEqual({
      'object-3d': 'object',
      'model-3d': 'object',
      'sdf-3d': 'object',
      'image-to-3d': 'object',
      'splat-3d': 'object',
      'splat-train': 'object',
      glass: 'pose',
      hypercube: 'pose',
    });
  });

  it('every key a reset writes exists on the node, with a value its field accepts', () => {
    for (const def of registry.list()) {
      const t = transformOf(def);
      if (!t) continue;
      for (const [k, v] of Object.entries(resetPatch(t, 'all'))) {
        const p = (def.params as Record<string, { type: string; min?: number; max?: number }>)[k];
        expect(p, `${def.id}.${k}`).toBeDefined();
        if (p.type === 'number') {
          expect(typeof v, `${def.id}.${k}`).toBe('number');
          expect(v as number).toBeGreaterThanOrEqual(p.min ?? -Infinity);
          expect(v as number).toBeLessThanOrEqual(p.max ?? Infinity);
        } else expect(Array.isArray(v), `${def.id}.${k}`).toBe(true);
      }
    }
  });
});

describe('reset buttons', () => {
  it('3D Object spawns tilted (25, 35, 0); Reset rotation makes it a true 0, 0, 0 in one undo step', () => {
    const { ed, ids } = setup(['object-3d']);
    const t = transformOf(registry.get('object-3d'))!;
    expect([paramsOf(ed, ids[0]).rotX, paramsOf(ed, ids[0]).rotY, paramsOf(ed, ids[0]).rotZ]).toEqual([25, 35, 0]);
    ed.setParams(ids[0], resetPatch(t, 'rotation'));
    expect([paramsOf(ed, ids[0]).rotX, paramsOf(ed, ids[0]).rotY, paramsOf(ed, ids[0]).rotZ]).toEqual([0, 0, 0]);
    expect(patchIsNoop(paramsOf(ed, ids[0]), resetPatch(t, 'rotation'))).toBe(true);
    ed.undo();
    expect([paramsOf(ed, ids[0]).rotX, paramsOf(ed, ids[0]).rotY, paramsOf(ed, ids[0]).rotZ]).toEqual([25, 35, 0]);
    expect(ed.state.canUndo).toBe(false);
  });

  it('Reset position centres the object (scene position and place in the frame); Reset all also zeroes rotation and size, and leaves the rest alone', () => {
    const { ed, ids } = setup(['object-3d']);
    const t = transformOf(registry.get('object-3d'))!;
    ed.setParams(ids[0], { posX: 3, posY: -2, posZ: 5, x: 0.2, y: 0.9, objectScale: 4, rotZ: 77, scale: 1.3, spinY: 2, shape: 'torus' });
    ed.setParams(ids[0], resetPatch(t, 'position'));
    let p = paramsOf(ed, ids[0]);
    expect([p.posX, p.posY, p.posZ, p.x, p.y]).toEqual([0, 0, 0, 0.5, 0.5]);
    expect([p.objectScale, p.rotZ]).toEqual([4, 77]);
    ed.setParams(ids[0], resetPatch(t, 'all'));
    p = paramsOf(ed, ids[0]);
    expect([p.rotX, p.rotY, p.rotZ, p.objectScale]).toEqual([0, 0, 0, 1]);
    // the camera's Frame size, the spin and everything else are not part of "where the object is"
    expect([p.scale, p.spinY, p.shape]).toEqual([1.3, 2, 'torus']);
    ed.undo();
    expect(paramsOf(ed, ids[0]).rotZ).toBe(77);
  });

  it('a setting driven by a wire is left alone', () => {
    const t = transformOf(registry.get('object-3d'))!;
    const patch = resetPatch(t, 'all', new Set(['rotY', 'posX']));
    expect('rotY' in patch).toBe(false);
    expect('posX' in patch).toBe(false);
    expect(patch.rotX).toBe(0);
    expect(patch.posY).toBe(0);
  });

  it('Glass and Hypercube: rotation to zero, position to the middle, size to its default', () => {
    for (const type of ['glass', 'hypercube']) {
      const def = registry.get(type)!;
      const t = transformOf(def)!;
      const rot = resetPatch(t, 'rotation');
      expect(Object.values(rot).every((v) => v === 0), type).toBe(true);
      expect(Object.keys(rot).length, type).toBeGreaterThanOrEqual(2);
      const all = resetPatch(t, 'all');
      const sizeKey = type === 'glass' ? 'size' : 'scale';
      expect(all[sizeKey]).toBe((def.params as Record<string, { default: unknown }>)[sizeKey].default);
    }
    expect(resetPatch(transformOf(registry.get('glass'))!, 'position')).toEqual({ position: [0.5, 0.5] });
    expect(resetPatch(transformOf(registry.get('hypercube'))!, 'position')).toEqual({ center: [0, 0] });
  });
});

describe('Editor.setParams (the handles and the reset buttons write through it)', () => {
  it('several params are one undo step, and a whole held drag is one step however many moves it had', () => {
    const { ed, ids } = setup(['object-3d']);
    ed.beginHold();
    for (let i = 1; i <= 20; i++) ed.setParams(ids[0], { posX: i * 0.1, posY: i * -0.05, posZ: 0 }, `giz:${ids[0]}:move`);
    ed.endHold();
    expect(paramsOf(ed, ids[0]).posX).toBeCloseTo(2);
    // a second, separate drag is a second step even though it has the same key
    ed.beginHold();
    ed.setParams(ids[0], { posX: 5 }, `giz:${ids[0]}:move`);
    ed.endHold();
    ed.undo();
    expect(paramsOf(ed, ids[0]).posX).toBeCloseTo(2);
    ed.undo();
    expect([paramsOf(ed, ids[0]).posX, paramsOf(ed, ids[0]).posY]).toEqual([0, 0]);
    expect(ed.state.canUndo).toBe(false);
    ed.redo();
    expect(paramsOf(ed, ids[0]).posX).toBeCloseTo(2);
  });

  it('an empty patch or an unknown node changes nothing and adds no undo step', () => {
    const { ed, ids } = setup(['object-3d']);
    ed.setParams(ids[0], {});
    ed.setParams('nope', { posX: 1 });
    expect(ed.state.canUndo).toBe(false);
  });
});

describe('which node gets the handles in the viewer', () => {
  it('the selected 3D object, when the viewer shows it or something it feeds', () => {
    const { ed, ids } = setup(['object-3d', 'blur']);
    const s = () => ed.state;
    const pick = (sel: string[], viewed: string | null) => gizmoTarget(s().level, sel, viewed, s().path, registry);
    expect(pick([ids[0]], ids[0])).toBe(ids[0]);
    expect(pick([ids[0]], ids[1])).toBe(ids[0]); // viewing the blur after it
    expect(pick([ids[1]], ids[1])).toBe(ids[0]); // the blur is selected: still the only 3D object in the picture
    expect(pick([], ids[0])).toBe(ids[0]);
    expect(pick([], null)).toBeNull();
  });

  it('not over an unrelated picture, and not when it is unclear which object is meant', () => {
    const { ed, ids } = setup(['object-3d', 'object-3d', 'blur'], false);
    const s = () => ed.state;
    const pick = (sel: string[], viewed: string | null) => gizmoTarget(s().level, sel, viewed, s().path, registry);
    // object A is selected but the viewer shows object B
    expect(pick([ids[0]], ids[1])).toBe(ids[1]);
    // the viewed blur has no 3D object upstream
    expect(pick([ids[0]], ids[2])).toBeNull();
    // two objects selected: none
    expect(pick([ids[0], ids[1]], ids[2])).toBeNull();
  });

  it('a bypassed object and nodes without a 3D transform get none', () => {
    const { ed, ids } = setup(['object-3d', 'blur']);
    ed.setNode(ids[0], { bypass: true });
    expect(gizmoTarget(ed.state.level, [ids[0]], ids[0], ed.state.path, registry)).toBeNull();
    const g = setup(['glass']);
    expect(gizmoTarget(g.ed.state.level, [g.ids[0]], g.ids[0], g.ed.state.path, registry)).toBeNull();
  });
});
