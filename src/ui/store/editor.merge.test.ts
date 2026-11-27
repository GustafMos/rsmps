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
/** The Stack Layers node a join created (any stack that was not in the test's own node set). */
const joinOf = (s: { ed: InstanceType<typeof Editor>; ids: Record<string, string> }) => s.ed.state.graph.nodes.find((n) => n.type === 'stack' && !Object.values(s.ids).includes(n.id))!;
const feeds = (g: GraphDoc, from: string, to: string, port?: string) => g.edges.filter((e) => e.from.node === from && e.to.node === to && (!port || e.to.port === port));

describe('mergeOutputs inserts a Stack Layers node into the chain', () => {
  it('base has downstream: consumers follow the Merge; base is the first wire (bottom), held the second (top)', () => {
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
    const m = joinOf(s);
    expect(wiresInto(g, m.id, 'images').map((e) => e.from.node)).toEqual([s.ids.b, s.ids.a]);
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
    const m = joinOf(s);
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
    const m = joinOf(s);
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
    const m = joinOf(s);
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
    const m = joinOf(s);
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
    const m = joinOf(s);
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
      expect(s.ed.state.viewedNodeId).toBe(joinOf(s).id);
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

  it('pictures make a Stack Layers node, not a Merge', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.load();
    s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b));
    expect(s.graph().nodes.some((n) => n.type === 'merge')).toBe(false);
    expect(wiresInto(s.graph(), joinOf(s).id, 'images').map((e) => e.from.node)).toEqual([s.ids.b, s.ids.a]);
    expect(s.ed.state.selection).toEqual([joinOf(s).id]);
  });

  it('dropping onto a Stack output makes a NEW Stack with the old one as its base (nesting)', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('c', 'noise');
    s.add('o', 'image-out');
    s.wire('b', 'o');
    s.load();
    s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b));
    const st = joinOf(s);
    expect(s.ed.mergeOutputs(out(s.ids.c), out(st.id))).toBe(true);
    const g = s.graph();
    const stacks = g.nodes.filter((n) => n.type === 'stack');
    expect(stacks).toHaveLength(2);
    const st2 = stacks.find((n) => n.id !== st.id)!;
    expect(wiresInto(g, st.id, 'images').map((e) => e.from.node)).toEqual([s.ids.b, s.ids.a]);
    expect(wiresInto(g, st2.id, 'images').map((e) => e.from.node)).toEqual([st.id, s.ids.c]);
    expect(feeds(g, st2.id, s.ids.o)).toHaveLength(1);
    expect(s.ed.state.selection).toEqual([st2.id]);
    s.ed.undo();
    expect(s.graph().nodes.filter((n) => n.type === 'stack')).toHaveLength(1);
  });

  it('dropping onto a Mixer output makes a new Mixer', () => {
    const s = setup();
    s.add('a', 'oscillator');
    s.add('b', 'oscillator');
    s.add('c', 'oscillator');
    s.load();
    const au = (id: string) => ({ node: id, port: 'audio' });
    s.ed.mergeOutputs(au(s.ids.a), au(s.ids.b));
    const mx = s.graph().nodes.find((n) => n.type === 'mixer')!;
    expect(s.ed.mergeOutputs(au(s.ids.c), au(mx.id))).toBe(true);
    expect(s.graph().nodes.filter((n) => n.type === 'mixer')).toHaveLength(2);
    expect(wiresInto(s.graph(), mx.id, 'audio')).toHaveLength(2);
  });

  it('dropping onto a node body adds to a Stack (top layer), a Mixer, and another multi-input node; one undo; selected', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('c', 'noise');
    s.add('sw', 'switch');
    s.add('o', 'image-out');
    s.wire('b', 'o');
    s.load();
    s.ed.mergeOutputs(out(s.ids.a), out(s.ids.b));
    const st = joinOf(s);
    expect(s.ed.addToNode(out(s.ids.c), st.id)).toBe(true);
    expect(wiresInto(s.graph(), st.id, 'images').map((e) => e.from.node)).toEqual([s.ids.b, s.ids.a, s.ids.c]);
    expect(s.ed.state.selection).toEqual([st.id]);
    s.ed.undo();
    expect(wiresInto(s.graph(), st.id, 'images')).toHaveLength(2);
    expect(s.ed.addToNode(out(s.ids.c), s.ids.sw)).toBe(true);
    expect(wiresInto(s.graph(), s.ids.sw, 'images').map((e) => e.from.node)).toEqual([s.ids.c]);
    const au = (id: string) => ({ node: id, port: 'audio' });
    const s2 = setup();
    s2.add('a', 'oscillator');
    s2.add('b', 'oscillator');
    s2.add('c', 'oscillator');
    s2.load();
    s2.ed.mergeOutputs(au(s2.ids.a), au(s2.ids.b));
    const mx = s2.graph().nodes.find((n) => n.type === 'mixer')!;
    expect(s2.ed.addToNode(au(s2.ids.c), mx.id)).toBe(true);
    expect(wiresInto(s2.graph(), mx.id, 'audio')).toHaveLength(3);
  });

  it('a body drop on a node without a multi input does nothing here (the normal socket picker handles it)', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('bl', 'blur');
    s.load();
    expect(s.ed.multiTarget(out(s.ids.a), s.ids.bl)).toBeNull();
    expect(s.ed.addToNode(out(s.ids.a), s.ids.bl)).toBe(false);
    expect(s.graph().edges).toHaveLength(0);
  });

  it('adding to a Stack with a loop-making held output is refused with a toast', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('st', 'stack');
    s.add('b', 'blur');
    s.wire('a', 'st');
    s.wire('st', 'b');
    s.load();
    expect(s.ed.addToNode(out(s.ids.b), s.ids.st)).toBe(false);
    expect(wiresInto(s.graph(), s.ids.st, 'images')).toHaveLength(1);
    expect(s.ed.state.toasts.length).toBeGreaterThan(0);
  });

  it('an old project with a Merge is untouched by joining other outputs', () => {
    const s = setup();
    s.add('a', 'noise');
    s.add('b', 'noise');
    s.add('m', 'merge');
    s.add('c', 'noise');
    s.wire('a', 'm', 'background');
    s.wire('b', 'm', 'foreground');
    s.load();
    const before = s.graph().edges.filter((e) => e.to.node === s.ids.m);
    s.ed.mergeOutputs(out(s.ids.c), out(s.ids.m));
    expect(s.graph().edges.filter((e) => e.to.node === s.ids.m)).toEqual(before);
    expect(s.graph().nodes.filter((n) => n.type === 'merge')).toHaveLength(1);
  });
});
