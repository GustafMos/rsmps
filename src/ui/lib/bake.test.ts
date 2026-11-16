import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { addNode, connect, createGraph } from '../../engine/graph';
import { registerBuiltins } from '../../engine/nodes';
import type { GraphDoc } from '../../engine/types';
import { applyBakeParams, bakeStatusOf, clearBakeParams, frozenNodes, insertCacheNodes } from './bake';

const registry = new Registry();
registerBuiltins(registry);

function chain() {
  let g: GraphDoc = createGraph('b');
  const add = (type: string, x = 0) => {
    const r = addNode(g, registry, type, { x, y: 0 });
    g = r.graph;
    return r.node.id;
  };
  const noise = add('noise');
  const blur = add('blur', 300);
  const adj = add('color-adjust', 600);
  const out = add('image-out', 900);
  const wire = (a: string, b: string, port = 'image') => (g = connect(g, registry, { node: a, port: 'image' }, { node: b, port }));
  wire(noise, blur);
  wire(blur, adj);
  wire(adj, out);
  return { g: () => g, noise, blur, adj, out };
}

describe('bake selection', () => {
  it('inserts one Cache / Bake node after the selection and rewires the consumer through it', () => {
    const c = chain();
    const r = insertCacheNodes(c.g(), registry, [c.noise, c.blur]);
    expect(r.cacheIds).toHaveLength(1);
    const cache = r.cacheIds[0];
    const e = r.graph.edges;
    expect(e.find((x) => x.to.node === cache)?.from).toEqual({ node: c.blur, port: 'image' });
    expect(e.find((x) => x.to.node === c.adj)?.from).toEqual({ node: cache, port: 'image' });
    expect(e.some((x) => x.from.node === c.blur && x.to.node === c.adj)).toBe(false);
    expect(r.graph.nodes.find((n) => n.id === cache)?.type).toBe('cache');
  });

  it('keeps the layer order of a multi-input consumer', () => {
    let g = createGraph('s');
    const add = (type: string) => {
      const r = addNode(g, registry, type);
      g = r.graph;
      return r.node.id;
    };
    const a = add('noise');
    const b = add('noise');
    const c = add('noise');
    const stack = add('stack');
    for (const n of [a, b, c]) g = connect(g, registry, { node: n, port: 'image' }, { node: stack, port: 'images' });
    const r = insertCacheNodes(g, registry, [b]);
    const order = r.graph.edges.filter((e) => e.to.node === stack).map((e) => e.from.node);
    expect(order[0]).toBe(a);
    expect(order[1]).toBe(r.cacheIds[0]);
    expect(order[2]).toBe(c);
  });

  it('is idempotent: an output that already feeds a Cache / Bake node gets no second one', () => {
    const c = chain();
    const once = insertCacheNodes(c.g(), registry, [c.blur]);
    const twice = insertCacheNodes(once.graph, registry, [c.blur]);
    expect(twice.cacheIds).toEqual([]);
  });

  it('bakes the loose end of a chain that nothing consumes yet', () => {
    let g = createGraph('l');
    const a = addNode(g, registry, 'noise');
    g = a.graph;
    const r = insertCacheNodes(g, registry, [a.node.id]);
    expect(r.cacheIds).toHaveLength(1);
    expect(r.graph.edges).toHaveLength(1);
  });
});

describe('frozen region and bake status', () => {
  it('freezes nodes whose every path ends in a serving cache, and not nodes that also feed something live', () => {
    const c = chain();
    const r = insertCacheNodes(c.g(), registry, [c.noise, c.blur]);
    const cache = r.cacheIds[0];
    const frozen = frozenNodes(r.graph, new Set([cache]));
    expect(frozen.has(c.noise)).toBe(true);
    expect(frozen.has(c.blur)).toBe(true);
    expect(frozen.has(c.adj)).toBe(false);
    expect(frozen.has(cache)).toBe(false);
    // blur also feeds a live branch: it is calculated anyway
    const side = addNode(r.graph, registry, 'color-adjust');
    const g2 = connect(side.graph, registry, { node: c.blur, port: 'image' }, { node: side.node.id, port: 'image' });
    const f2 = frozenNodes(g2, new Set([cache]));
    expect(f2.has(c.blur)).toBe(false);
    expect(f2.has(c.noise)).toBe(false);
  });

  it('reports none, baking, baked, stale and missing', () => {
    const c = chain();
    const r = insertCacheNodes(c.g(), registry, [c.blur]);
    const cache = r.cacheIds[0];
    const node = (g: GraphDoc) => g.nodes.find((n) => n.id === cache)!;
    let sig = 'sig1';
    const deps = { signatureOf: () => sig, assetExists: () => true };
    expect(bakeStatusOf(r.graph, node(r.graph), deps).kind).toBe('none');
    expect(bakeStatusOf(r.graph, node(r.graph), { ...deps, job: { fraction: 0.4 } })).toMatchObject({ kind: 'baking', badge: 'baking 40%' });
    const baked = applyBakeParams(r.graph, cache, { baked: 'seq1', bakedSignature: 'sig1' });
    expect(bakeStatusOf(baked, node(baked), deps).kind).toBe('baked');
    sig = 'sig2'; // something before the node changed
    expect(bakeStatusOf(baked, node(baked), deps).kind).toBe('stale');
    expect(bakeStatusOf(baked, node(baked), { ...deps, assetExists: () => false }).kind).toBe('missing');
    const cleared = clearBakeParams(baked, cache);
    expect(node(cleared).params.baked).toBe('');
    expect(bakeStatusOf(cleared, node(cleared), deps).kind).toBe('none');
  });
});
