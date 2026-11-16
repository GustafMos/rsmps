import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph, groupOutputWires, groupOutputs } from '../graph';
import { harness } from '../testing';

describe('groupOutputWires', () => {
  it('returns exactly the wires that leave a set of nodes, so a Cache / Bake node can be inserted on each', async () => {
    const t = await harness();
    const R = t.registry;
    let g = createGraph('g');
    const add = (type: string) => {
      const r = addNode(g, R, type);
      g = r.graph;
      return r.node.id;
    };
    const src = add('solid');
    const blur = add('blur');
    const bloom = add('bloom');
    const merge = add('merge');
    const out = add('image-out');
    const out2 = add('image-out');
    g = connect(g, R, { node: src, port: 'image' }, { node: blur, port: 'image' });
    g = connect(g, R, { node: blur, port: 'image' }, { node: bloom, port: 'image' });
    g = connect(g, R, { node: bloom, port: 'image' }, { node: merge, port: 'background' });
    g = connect(g, R, { node: src, port: 'image' }, { node: merge, port: 'foreground' });
    g = connect(g, R, { node: merge, port: 'image' }, { node: out, port: 'image' });
    g = connect(g, R, { node: bloom, port: 'image' }, { node: out2, port: 'image' });

    // The group {src, blur, bloom}: bloom feeds merge and out2, src feeds merge directly.
    const wires = groupOutputWires(g, [src, blur, bloom], R);
    expect(wires.map((w) => `${w.edge.from.node}>${w.edge.to.node}.${w.edge.to.port}`).sort()).toEqual([`${bloom}>${merge}.background`, `${bloom}>${out2}.image`, `${src}>${merge}.foreground`].sort());
    expect(wires.every((w) => w.type === 'image')).toBe(true);
    // One cache node per distinct output (node, port): bloom's two consumers share one.
    const outs = groupOutputs(g, [src, blur, bloom], R);
    expect(outs.length).toBe(2);
    expect(outs.find((o) => o.node === bloom)?.consumers.length).toBe(2);
    // Nothing leaves the whole graph; wires entering the set are not output wires.
    expect(groupOutputWires(g, g.nodes.map((n) => n.id))).toEqual([]);
    expect(groupOutputWires(g, [merge], R).length).toBe(1);
  });
});
