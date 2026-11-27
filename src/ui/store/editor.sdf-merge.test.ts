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
const { SDF_HINT } = await import('../../engine/sdf-scene-group');
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  ed.loadGraph(createGraph('t'));
  return ed;
}
const sdf = (id: string) => ({ node: id, port: 'sdf' });
/** An editor inside a fresh SDF Scene with a second shape added: shape1 is wired to the Scene Output, shape2 is loose. */
function inScene() {
  const ed = setup();
  const gid = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
  ed.enterGroup(gid);
  const shape2 = ed.addNodeAt('sdf-shape', { x: 0, y: 200 })!;
  return { ed, gid, shape2 };
}
const combines = (ed: InstanceType<typeof Editor>) => ed.state.level.nodes.filter((n) => n.type === 'sdf-combine');

describe('mergeOutputs: SDF shapes make an SDF Combine', () => {
  it('base first, held second, Union; the Scene Output now reads the Combine; selected', () => {
    const { ed, shape2 } = inScene();
    expect(ed.mergeOutputs(sdf(shape2), sdf('shape1'))).toBe(true);
    const [c] = combines(ed);
    expect(c.params.operation ?? 'union').toBe('union');
    const into = ed.state.level.edges.filter((e) => e.to.node === c.id);
    expect(into.map((e) => [e.from.node, e.to.port])).toEqual([['shape1', 'items'], [shape2, 'items']]);
    expect(ed.state.level.edges.filter((e) => e.to.node === 'render' && e.to.port === 'scene').map((e) => e.from.node)).toEqual([c.id]);
    expect(ed.state.selection).toEqual([c.id]);
  });

  it('dropping onto an existing Combine adds an input; dropping onto a shape makes a new Combine', () => {
    const { ed, shape2 } = inScene();
    ed.mergeOutputs(sdf(shape2), sdf('shape1'));
    const c = combines(ed)[0];
    const shape3 = ed.addNodeAt('sdf-shape', { x: 0, y: 400 })!;
    expect(ed.mergeOutputs(sdf(shape3), sdf(c.id))).toBe(true);
    expect(combines(ed)).toHaveLength(1);
    expect(ed.state.level.edges.filter((e) => e.to.node === c.id)).toHaveLength(3);
    expect(ed.state.level.edges.some((e) => e.from.node === shape3 && e.to.node === c.id)).toBe(true);
    const shape4 = ed.addNodeAt('sdf-shape', { x: 0, y: 500 })!;
    expect(ed.mergeOutputs(sdf(shape4), sdf(shape3))).toBe(true);
    expect(combines(ed)).toHaveLength(2);
  });

  it('a loop is refused with a toast', () => {
    const { ed, shape2 } = inScene();
    ed.mergeOutputs(sdf(shape2), sdf('shape1'));
    const c = combines(ed)[0];
    const mv = ed.addNodeAt('sdf-transform', { x: 0, y: 300 })!;
    ed.connect(sdf(c.id), { node: mv, port: 'sdf' });
    const before = ed.state.level.edges.length;
    expect(ed.mergeOutputs(sdf(mv), sdf(c.id))).toBe(false);
    expect(ed.state.level.edges.length).toBe(before);
    expect(ed.state.toasts.length).toBeGreaterThan(0);
  });

  it('is one undo step', () => {
    const { ed, shape2 } = inScene();
    const before = ed.state.level.edges.length;
    ed.mergeOutputs(sdf(shape2), sdf('shape1'));
    ed.undo();
    expect(combines(ed)).toHaveLength(0);
    expect(ed.state.level.edges.length).toBe(before);
  });

  it('outside a scene it is refused with the SDF Scene hint', () => {
    const ed = setup();
    const a = ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    const b = ed.addNodeAt('sdf-scene', { x: 0, y: 300 })!;
    const n = ed.state.graph.nodes.length;
    expect(ed.mergeOutputs(sdf(a), sdf(b))).toBe(false);
    expect(ed.state.graph.nodes).toHaveLength(n);
    expect(ed.state.toasts[ed.state.toasts.length - 1]?.text).toBe(SDF_HINT);
  });

  it('pictures still make a Stack; mixed types are not joined', () => {
    const ed = setup();
    const a = ed.addNodeAt('noise', { x: 0, y: 0 })!;
    const b = ed.addNodeAt('noise', { x: 0, y: 200 })!;
    expect(ed.mergeOutputs({ node: a, port: 'image' }, { node: b, port: 'image' })).toBe(true);
    expect(ed.state.graph.nodes.some((n) => n.type === 'stack')).toBe(true);
    const gid = ed.addNodeAt('sdf-scene', { x: 0, y: 500 })!;
    expect(ed.mergeOutputs(sdf(gid), { node: a, port: 'image' })).toBe(false);
  });
});
