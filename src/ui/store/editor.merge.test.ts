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
const { addNode, connect, createGraph, wiresInto } = await import('../../engine/graph');
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  let g: GraphDoc = createGraph('t');
  let x = 0;
  const ids: Record<string, string> = {};
  const add = (name: string, type: string) => {
    const r = addNode(g, registry, type, { x: (x += 400), y: (x / 400) * 300 });
    g = r.graph;
    ids[name] = r.node.id;
    return r.node.id;
  };
  const wire = (a: string, b: string, port?: string, outPort?: string) => {
    const from = { node: ids[a], port: outPort ?? Object.keys(registry.get(g.nodes.find((n) => n.id === ids[a])!.type)!.outputs)[0] };
    const to = { node: ids[b], port: port ?? Object.keys(registry.get(g.nodes.find((n) => n.id === ids[b])!.type)!.inputs)[0] };
    g = connect(g, registry, from, to);
  };
  const load = () => {
    ed.loadGraph(g);
    // loadGraph may auto-layout; keep ids and wires
  };
  return { ed, add, wire, load, ids, graph: () => ed.state.graph };
}

const out = (id: string) => ({ node: id, port: 'image' });
const mergeOf = (ed: InstanceType<typeof Editor>) => ed.state.graph.nodes.find((n) => n.type === 'merge')!;
const feeds = (g: GraphDoc, from: string, to: string, port?: string) => g.edges.filter((e) => e.from.node === from && e.to.node === to && (!port || e.to.port === port));

describe('mergeOutputs inserts the Merge into the chain', () => {
  it('base has downstream: consumers follow the Merge; held ends up on foreground, base on background', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('blur', 'blur');
    s.add('o', 'image-out');
    s.wire('b', 'blur');
    s.wire('blur', 'o');
    s.load();
    expect(s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b))).toBe(true);
    const g = s.graph();
    const m = mergeOf(s.ed);
    expect(feeds(g, s.ids.b, m.id, 'background')).toHaveLength(1);
    expect(feeds(g, s.ids.a, m.id, 'foreground')).toHaveLength(1);
    expect(feeds(g, m.id, s.ids.blur)).toHaveLength(1);
    expect(g.edges.some((e) => e.from.node === s.ids.b && e.to.node === s.ids.blur)).toBe(false);
  });

  it('only the held output has downstream: they follow the Merge', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('o', 'image-out');
    s.wire('a', 'o');
    s.load();
    expect(s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b))).toBe(true);
    const g = s.graph();
    const m = mergeOf(s.ed);
    expect(feeds(g, m.id, s.ids.o)).toHaveLength(1);
    expect(feeds(g, s.ids.a, s.ids.o)).toHaveLength(0);
  });

  it('both have downstream: every wire follows the Merge, none is lost', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('o1', 'image-out');
    s.add('o2', 'image-out');
    s.add('blur', 'blur');
    s.wire('a', 'o1');
    s.wire('b', 'o2');
    s.wire('b', 'blur');
    s.load();
    expect(s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b))).toBe(true);
    const g = s.graph();
    const m = mergeOf(s.ed);
    for (const t of ['o1', 'o2', 'blur']) expect(feeds(g, m.id, s.ids[t])).toHaveLength(1);
    expect(g.edges.filter((e) => e.to.node === s.ids.o1 || e.to.node === s.ids.o2 || e.to.node === s.ids.blur).every((e) => e.from.node === m.id)).toBe(true);
  });

  it('both outputs into one consumer socket collapse to a single Merge wire', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('st', 'stack');
    s.wire('a', 'st');
    s.wire('b', 'st');
    s.load();
    s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b));
    const g = s.graph();
    const m = mergeOf(s.ed);
    expect(wiresInto(g, s.ids.st, 'images').map((e) => e.from.node)).toEqual([m.id]);
  });

  it('neither has downstream: only the two input wires are made', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.load();
    expect(s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b))).toBe(true);
    const g = s.graph();
    expect(g.edges).toHaveLength(2);
    expect(g.nodes).toHaveLength(3);
  });

  it('keeps the wire position on a multi (layer) input', () => {
    const s = setup();
    s.add('l0', 'noise');
    s.add('a', 'noise');
    s.add('l2', 'noise');
    s.add('b', 'noise');
    s.add('st', 'stack');
    s.wire('l0', 'st');
    s.wire('a', 'st');
    s.wire('l2', 'st');
    s.load();
    s.ed.mergeOutputs(out(s.ids.b), out(s.ids.a));
    const g = s.graph();
    const m = mergeOf(s.ed);
    expect(wiresInto(g, s.ids.st, 'images').map((e) => e.from.node)).toEqual([s.ids.l0, m.id, s.ids.l2]);
  });

  it('held feeding the base upstream does not create a loop (that wire stays)', () => {
    const s = setup();
    s.add('a', 'noise'); // held
    s.add('blur', 'blur');
    s.add('o', 'image-out');
    s.wire('a', 'blur'); // held feeds base's upstream... blur is the base
    s.wire('blur', 'o');
    s.load();
    expect(s.ed.mergeOutputs(out(s.ids.a), out(s.ids.blur))).toBe(true);
    const g = s.graph();
    const m = mergeOf(s.ed);
    expect(feeds(g, s.ids.a, s.ids.blur)).toHaveLength(1); // would loop if moved
    expect(feeds(g, m.id, s.ids.o)).toHaveLength(1);
    expect(feeds(g, m.id, s.ids.blur)).toHaveLength(0);
  });

  it('is one undo step', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('o', 'image-out');
    s.wire('b', 'o');
    s.load();
    const before = s.graph();
    s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b));
    expect(s.graph()).not.toBe(before);
    s.ed.undo();
    expect(s.graph()).toBe(before);
    expect(s.ed.state.canUndo).toBe(false);
  });

  it('the viewed node follows to the Merge when it was one of the pair', () => {
    for (const viewed of ['a', 'b']) {
      const s = setup();
      s.add('a', 'noise');
      s.add('b', 'noise');
      s.load();
      (s.ed as unknown as { patch(p: object): void }).patch({ viewedNodeId: s.ids[viewed] });
      s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b));
      expect(s.ed.state.viewedNodeId).toBe(mergeOf(s.ed).id);
    }
  });

  it('audio pair makes a Mixer and its consumers follow it', () => {
    const s = setup();
    s.add('a', 'oscillator');
    s.add('b', 'oscillator');
    s.add('o', 'audio-out');
    s.wire('b', 'o');
    s.load();
    const au = (id: string) => ({ node: id, port: 'audio' });
    expect(s.ed.mergeOutputs(au(s.ids.a), au(s.ids.b))).toBe(true);
    const g = s.graph();
    const mx = g.nodes.find((n) => n.type === 'mixer')!;
    expect(wiresInto(g, mx.id, 'audio').map((e) => e.from.node)).toEqual([s.ids.b, s.ids.a]);
    expect(feeds(g, mx.id, s.ids.o)).toHaveLength(1);
    expect(feeds(g, s.ids.b, s.ids.o)).toHaveLength(0);
  });
});
