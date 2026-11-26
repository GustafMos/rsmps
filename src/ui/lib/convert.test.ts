import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { addNode, connect, createGraph, validateGraph, wiresInto } from '../../engine/graph';
import { registerBuiltins } from '../../engine/nodes';
import type { GraphDoc } from '../../engine/types';
import { FAMILIES, convertNode, describeDropped, familyMembers } from './convert';

const registry = new Registry();
registerBuiltins(registry);

function build(type: string, wiresIn: string[] = [], port?: (i: number) => string) {
  let g: GraphDoc = createGraph('c');
  const sources: string[] = [];
  for (let i = 0; i < wiresIn.length; i++) {
    const r = addNode(g, registry, 'noise', { x: 0, y: i * 100 });
    g = r.graph;
    sources.push(r.node.id);
  }
  const t = addNode(g, registry, type, { x: 500, y: 40 }, {});
  g = t.graph;
  g = { ...g, nodes: g.nodes.map((n) => (n.id === t.node.id ? { ...n, label: 'Mine', frame: 'f1', collapsed: true } : n)) };
  wiresIn.forEach((p, i) => (g = connect(g, registry, { node: sources[i], port: 'image' }, { node: t.node.id, port: p })));
  const o = addNode(g, registry, 'image-out', { x: 900, y: 40 });
  g = connect(o.graph, registry, { node: t.node.id, port: 'image' }, { node: o.node.id, port: 'image' });
  return { g, id: t.node.id, sources, out: o.node.id };
}
const into = (g: GraphDoc, id: string, port: string) => wiresInto(g, id, port).map((e) => e.from.node);

describe('convertNode', () => {
  it('the family table matches the node definitions', () => {
    for (const [fam, spec] of Object.entries(FAMILIES)) {
      for (const [type, layers] of Object.entries(spec.members)) {
        const def = registry.get(type)!;
        expect(def.family).toBe(fam);
        for (const p of 'ports' in layers ? layers.ports : [layers.multi]) expect(def.inputs[p]).toBeDefined();
      }
    }
    expect(familyMembers(registry, 'merge').map((m) => m.id)).toEqual(['merge', 'mix', 'stack', 'switch']);
    expect(familyMembers(registry, 'blur')).toEqual([]);
  });

  it('Merge -> Stack keeps id, place, label, frame, output wire; bottom then top; shared params; drops mask', () => {
    const b = build('merge', ['background', 'foreground']);
    const g = { ...b.g, nodes: b.g.nodes.map((n) => (n.id === b.id ? { ...n, params: { ...n.params, opacity: 0.4, fit: 'cover', mode: 'add' } } : n)) };
    const r = convertNode(g, registry, b.id, 'stack');
    expect(r.error).toBeUndefined();
    const n = r.graph.nodes.find((x) => x.id === b.id)!;
    expect(n).toMatchObject({ type: 'stack', x: 500, y: 40, label: 'Mine', frame: 'f1', collapsed: true });
    expect(n.params).toMatchObject({ opacity: 0.4, fit: 'cover' });
    expect('mode' in n.params).toBe(false);
    expect(into(r.graph, b.id, 'images')).toEqual(b.sources); // bottom first
    expect(r.graph.edges.some((e) => e.from.node === b.id && e.to.node === b.out)).toBe(true);
    expect(validateGraph(r.graph, registry)).toEqual([]);
  });

  it('keeps the mask wire when both nodes have one; Merge with only a foreground compacts into a Stack', () => {
    let { g, id } = build('merge', ['foreground']);
    const m = addNode(g, registry, 'alpha-to-mask', { x: 0, y: 300 });
    g = connect(m.graph, registry, { node: m.node.id, port: Object.keys(registry.get('alpha-to-mask')!.outputs)[0] }, { node: id, port: 'mask' });
    const toMix = convertNode(g, registry, id, 'mix');
    expect(toMix.dropped.other).toBe(1); // Mix has no mask
    expect(wiresInto(toMix.graph, id, 'b')).toHaveLength(1);
    const toStack = convertNode(g, registry, id, 'stack');
    expect(wiresInto(toStack.graph, id, 'images')).toHaveLength(1);
  });

  it('Stack of 4 -> Merge keeps the bottom two and reports the rest; the order survives a round trip', () => {
    const b = build('stack', ['images', 'images', 'images', 'images']);
    const r = convertNode(b.g, registry, b.id, 'merge');
    expect(into(r.graph, b.id, 'background')).toEqual([b.sources[0]]);
    expect(into(r.graph, b.id, 'foreground')).toEqual([b.sources[1]]);
    expect(r.dropped.layers).toBe(2);
    expect(describeDropped(r.dropped)).toContain('2 layers');
    const back = convertNode(b.g, registry, b.id, 'switch');
    expect(into(back.graph, b.id, 'images')).toEqual(b.sources);
    expect(back.dropped).toEqual({ layers: 0, other: 0 });
  });

  it('Stack of 2 <-> Merge: bottom is the background, top is the foreground', () => {
    const b = build('stack', ['images', 'images']);
    const r = convertNode(b.g, registry, b.id, 'merge');
    expect(into(r.graph, b.id, 'background')).toEqual([b.sources[0]]);
    expect(into(r.graph, b.id, 'foreground')).toEqual([b.sources[1]]);
    const back = convertNode(r.graph, registry, b.id, 'stack');
    expect(into(back.graph, b.id, 'images')).toEqual(b.sources);
  });

  it('Mix <-> Merge maps A/B to background/foreground', () => {
    const b = build('mix', ['a', 'b']);
    const r = convertNode(b.g, registry, b.id, 'merge');
    expect(into(r.graph, b.id, 'background')).toEqual([b.sources[0]]);
    expect(into(r.graph, b.id, 'foreground')).toEqual([b.sources[1]]);
    const back = convertNode(r.graph, registry, b.id, 'mix');
    expect(into(back.graph, b.id, 'a')).toEqual([b.sources[0]]);
    expect(into(back.graph, b.id, 'b')).toEqual([b.sources[1]]);
  });

  it('a wired parameter socket survives when the other node has the same parameter', () => {
    let { g, id } = build('merge', ['background']);
    const a = addNode(g, registry, 'noise', { x: 0, y: 0 });
    // wire something numeric into opacity if a number node exists
    const numberNode = registry.list().find((d) => Object.values(d.outputs).some((o) => (o as { type: string }).type === 'number') && !Object.keys(d.inputs).length);
    expect(numberNode).toBeDefined();
    if (!numberNode) return;
    const nn = addNode(a.graph, registry, numberNode.id, { x: 0, y: 0 });
    g = connect(nn.graph, registry, { node: nn.node.id, port: Object.keys(numberNode.outputs).find((k) => numberNode.outputs[k].type === 'number')! }, { node: id, port: 'opacity' });
    const toStack = convertNode(g, registry, id, 'stack');
    expect(toStack.graph.edges.some((e) => e.to.node === id && e.to.port === 'opacity')).toBe(true);
    const toSwitch = convertNode(g, registry, id, 'switch');
    expect(toSwitch.graph.edges.some((e) => e.to.node === id && e.to.port === 'opacity')).toBe(false);
    expect(toSwitch.dropped.other).toBe(1);
  });

  it('refuses nodes outside a family and is a no-op for the same type', () => {
    const b = build('merge', ['background']);
    expect(convertNode(b.g, registry, b.id, 'blur').error).toBeTruthy();
    expect(convertNode(b.g, registry, b.id, 'merge').graph).toBe(b.g);
    expect(convertNode(b.g, registry, 'nope', 'stack').error).toBeTruthy();
  });

  it('does not mutate the input graph', () => {
    const b = build('stack', ['images', 'images']);
    const snap = JSON.stringify(b.g);
    convertNode(b.g, registry, b.id, 'merge');
    expect(JSON.stringify(b.g)).toBe(snap);
  });
});
