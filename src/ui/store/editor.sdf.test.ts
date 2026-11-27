import { describe, expect, it, vi } from 'vitest';

// the store modules read localStorage at construction
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('./editor');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { createGraph } = await import('../../engine/graph');
const { groupData, GROUP_TYPE } = await import('../../engine/group');
const { SDF_HINT, isSdfOnlyDef } = await import('../../engine/sdf-scene-group');
import type { Io } from '../../io/api';

/** The placement rule: SDF nodes can only be added inside an SDF Scene. */
const registry = new Registry();
registerBuiltins(registry);

function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  ed.loadGraph(createGraph('t'));
  return ed;
}
const lastToast = (ed: InstanceType<typeof Editor>) => ed.state.toasts[ed.state.toasts.length - 1]?.text;

describe('editor: SDF placement rule', () => {
  it('SDF nodes cannot be added outside an SDF Scene (a plain hint is shown), the SDF Scene itself can', () => {
    const ed = setup();
    for (const type of ['sdf-shape', 'sdf-combine', 'sdf-transform', 'sdf-modify', 'sdf-render']) {
      expect(ed.addNodeAt(type, { x: 0, y: 0 }), type).toBeNull();
      expect(lastToast(ed)).toBe(SDF_HINT);
    }
    expect(ed.state.graph.nodes).toEqual([]);
    expect(ed.inSdfScene()).toBe(false);
    // the menu lists only the SDF Scene of the category
    const sdfDefs = registry.list().filter((d) => d.category === 'sdf' && !d.hidden);
    expect(sdfDefs.filter((d) => !isSdfOnlyDef(d)).map((d) => d.id)).toEqual(['sdf-scene']);
    expect(sdfDefs.filter((d) => isSdfOnlyDef(d)).map((d) => d.id).sort()).toEqual(['sdf-combine', 'sdf-modify', 'sdf-shape', 'sdf-transform']);
  });

  it('a new SDF Scene is pre-filled with one sphere wired to the scene output, and opens nothing', () => {
    const ed = setup();
    const id = ed.addNodeAt('sdf-scene', { x: 10, y: 20 })!;
    expect(id).toBeTruthy();
    expect(ed.state.path).toEqual([]);
    const node = ed.state.graph.nodes.find((n) => n.id === id)!;
    expect(node.type).toBe(GROUP_TYPE);
    const d = groupData(node);
    expect(d.sdfScene).toBe(true);
    expect(d.nodes.map((n) => n.type).sort()).toEqual(['sdf-render', 'sdf-shape']);
    expect(d.nodes.find((n) => n.type === 'sdf-shape')!.params.shape).toBe('sphere');
    expect(d.edges.some((e) => e.from.node === 'shape1' && e.to.node === 'render' && e.to.port === 'scene')).toBe(true);
    expect(d.outputs.map((p) => `${p.id}:${p.type}`)).toEqual(['image:image', 'depth:image', 'sdf:sdf']);
    expect(d.inputs.map((p) => p.type)).toEqual(['camera', 'material', 'image']);
  });

  it('SDF nodes can be added inside the scene (double-click to enter), and not after going back out', () => {
    const ed = setup();
    const gid = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    ed.enterGroup(gid);
    expect(ed.inSdfScene()).toBe(true);
    const shape2 = ed.addNodeAt('sdf-shape', { x: 0, y: 200 });
    const comb = ed.addNodeAt('sdf-combine', { x: 200, y: 200 });
    expect(shape2).toBeTruthy();
    expect(comb).toBeTruthy();
    const inside = groupData(ed.state.graph.nodes.find((n) => n.id === gid)!);
    expect(inside.nodes.filter((n) => n.type === 'sdf-shape')).toHaveLength(2);
    expect(inside.nodes.some((n) => n.type === 'sdf-combine')).toBe(true);
    // a plain group inside the scene is still inside it
    ed.select([shape2!]);
    expect(ed.groupNodes()).toBeTruthy();
    expect(ed.addNodeAt('sdf-modify', { x: 0, y: 400 })).toBeTruthy(); // still the scene's level
    // and inside the plain group, still inside the scene
    const plain = ed.state.level.nodes.find((n) => n.type === GROUP_TYPE)!;
    ed.enterGroup(plain.id);
    expect(ed.inSdfScene()).toBe(true);
    expect(ed.addNodeAt('sdf-shape', { x: 0, y: 0 })).toBeTruthy();
    ed.exitGroup(1);
    ed.exitGroup(0);
    expect(ed.inSdfScene()).toBe(false);
    expect(ed.addNodeAt('sdf-shape', { x: 0, y: 0 })).toBeNull();
  });

  it('paste and duplicate of SDF nodes outside a scene are refused with a toast; inside they work', () => {
    const ed = setup();
    const gid = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    ed.enterGroup(gid);
    ed.select(['shape1']);
    ed.copy();
    ed.duplicate();
    expect(groupData(ed.state.graph.nodes.find((n) => n.id === gid)!).nodes.filter((n) => n.type === 'sdf-shape')).toHaveLength(2);
    ed.exitGroup(0);
    ed.paste();
    expect(lastToast(ed)).toBe(SDF_HINT);
    expect(ed.state.graph.nodes.map((n) => n.id)).toEqual([gid]);
    // dragging the whole scene out is not a thing, but a scene group itself may be copied anywhere
    ed.select([gid]);
    ed.duplicate();
    expect(ed.state.graph.nodes.filter((n) => n.type === GROUP_TYPE)).toHaveLength(2);
  });

  it('an SDF Scene cannot be ungrouped at the top level (its shapes would be left outside)', () => {
    const ed = setup();
    const gid = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    ed.select([gid]);
    expect(ed.ungroupNodes()).toEqual([]);
    expect(ed.state.graph.nodes.map((n) => n.id)).toEqual([gid]);
    expect(lastToast(ed)).toMatch(/cannot be ungrouped/);
  });
});
