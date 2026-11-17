/**
 * Per-frame cost of an animated graph whose bulk is static: 500 nodes, 20 of them animated. The static part is served from the cache
 * and must not be walked again (structural fast path, per node). Also checks that nothing static is stale after edits / asset changes.
 */
import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../graph';
import { animatedSource } from '../lib/util-testsource';
import { harness } from '../testing';
import type { GraphDoc, ImageValue } from '../types';

async function build(statics = 460, animated = 20) {
  const t = await harness([animatedSource('walk-anim', (s) => (s * 3) % 1)]);
  let g: GraphDoc = createGraph('walk');
  g = { ...g, project: { ...g.project, width: 16, height: 16, fps: 10, duration: 5, loop: true } };
  const src = t.source(t.solid(16, 16, [200, 100, 50, 255]));
  const first = addNode(g, t.registry, src);
  g = first.graph;
  let prev = first.node.id;
  const ids: string[] = [prev];
  for (let i = 0; i < statics; i++) {
    const n = addNode(g, t.registry, 'invert', { x: i, y: 0 }, { amount: 1 });
    g = connect(n.graph, t.registry, { node: prev, port: prev === first.node.id ? 'out' : 'image' }, { node: n.node.id, port: 'image' });
    prev = n.node.id;
    ids.push(prev);
  }
  const spine = prev;
  for (let i = 0; i < animated; i++) {
    const a = addNode(g, t.registry, 'walk-anim');
    const m = addNode(a.graph, t.registry, 'merge', { x: 0, y: 0 }, { opacity: 0.5 });
    g = connect(m.graph, t.registry, { node: prev, port: 'image' }, { node: m.node.id, port: 'background' });
    g = connect(g, t.registry, { node: a.node.id, port: 'image' }, { node: m.node.id, port: 'foreground' });
    prev = m.node.id;
  }
  return { t, g, out: prev, spine, ids };
}

const bytes = (t: Awaited<ReturnType<typeof harness>>, v: unknown) => t.gpu.read(v as ImageValue, false);

describe('structural fast path per node', () => {
  it('measures a cache-hit-heavy frame (500 nodes, 20 animated) and serves the static spine without walking it', async () => {
    const { t, g, out } = await build();
    expect(g.nodes.length).toBe(500 + 1);
    await t.evalGraph(g, out, { seconds: 0 });
    await t.evalGraph(g, out, { seconds: 0.1 });
    const hits0 = t.engine.staticNodeHits;
    const times: number[] = [];
    for (let f = 2; f < 42; f++) {
      const t0 = performance.now();
      await t.evalGraph(g, out, { seconds: f / 10 });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`WALK ms/frame median ${times[20].toFixed(2)} p90 ${times[36].toFixed(2)} min ${times[0].toFixed(2)}; static hits ${t.engine.staticNodeHits - hits0}`);
    // the spine is taken from the fast path once per frame (its last node): the 460 nodes before it are not visited
    expect(t.engine.staticNodeHits - hits0).toBeGreaterThanOrEqual(40);
  });

  it('gives the same pixels as an engine that has never seen the document (animated frames, items, edits)', async () => {
    const { t, g, out, spine } = await build(30, 3);
    const frames = [0, 1, 2, 3, 7, 2, 9];
    const warm: Uint8ClampedArray[] = [];
    for (const f of frames) warm.push(new Uint8ClampedArray(await bytes(t, await t.evalGraph(g, out, { seconds: f / 10 }))));
    for (let k = 0; k < frames.length; k++) {
      const cold = await build(30, 3);
      const px = await bytes(cold.t, await cold.t.evalGraph(cold.g, cold.out, { seconds: frames[k] / 10 }));
      expect(Buffer.from(px).equals(Buffer.from(warm[k])), `frame ${frames[k]}`).toBe(true);
    }
    // an edit makes a new document object: the changed node (and what is after it) is recomputed, not served from the old memo
    const edited: GraphDoc = { ...g, nodes: g.nodes.map((n) => (n.id === spine ? { ...n, params: { ...n.params, amount: 0 } } : n)) };
    const a = new Uint8ClampedArray(await bytes(t, await t.evalGraph(g, out, { seconds: 0.3 })));
    const b = new Uint8ClampedArray(await bytes(t, await t.evalGraph(edited, out, { seconds: 0.3 })));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    const again = new Uint8ClampedArray(await bytes(t, await t.evalGraph(g, out, { seconds: 0.3 })));
    expect(Buffer.from(again).equals(Buffer.from(a))).toBe(true);
    // clearing the engine (assets changed) drops the memo with the cache
    t.engine.clear();
    const hits = t.engine.staticNodeHits;
    await t.evalGraph(g, out, { seconds: 0.4 });
    expect(t.engine.staticNodeHits).toBe(hits);
  });

  it('a static node that reads the batch item is keyed by the item', async () => {
    const t = await harness([animatedSource('walk-anim', (s) => (s * 3) % 1)]);
    const { defineNode } = await import('../define');
    const COLORS: [number, number, number, number][] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
    t.registry.register(
      defineNode({
        id: 'walk-item',
        title: 'item colour',
        category: 'input',
        description: 'test',
        inputs: {},
        outputs: { image: { type: 'image' } },
        params: {},
        render: (ctx) => ({ image: ctx.gpu.upload(new Uint8ClampedArray(Array.from({ length: 16 }, () => COLORS[ctx.item.index]).flat()), 4, 4, 1, true) }),
      }),
    );
    let g: GraphDoc = createGraph('walk-item');
    g = { ...g, project: { ...g.project, width: 4, height: 4, fps: 10, duration: 5, loop: true } };
    const src = addNode(g, t.registry, 'walk-item');
    const inv = addNode(src.graph, t.registry, 'invert');
    const a = addNode(inv.graph, t.registry, 'walk-anim');
    const m = addNode(a.graph, t.registry, 'merge', { x: 0, y: 0 }, { opacity: 0 });
    g = connect(m.graph, t.registry, { node: src.node.id, port: 'image' }, { node: inv.node.id, port: 'image' });
    g = connect(g, t.registry, { node: inv.node.id, port: 'image' }, { node: m.node.id, port: 'background' });
    g = connect(g, t.registry, { node: a.node.id, port: 'image' }, { node: m.node.id, port: 'foreground' });
    for (let f = 0; f < 9; f++) {
      const item = f % 3;
      const v = (await t.engine.evaluate({ graph: g, node: m.node.id, seconds: f / 10, item, itemCount: 3 })).value as ImageValue;
      const px = (await t.pixels(v)).at(1, 1);
      expect(px.slice(0, 3), `frame ${f} item ${item}`).toEqual(COLORS[item].slice(0, 3).map((c) => 255 - c));
    }
  });

  it('errors are still reported on every frame (nothing is memoised from an evaluation that had one)', async () => {
    const { defineNode } = await import('../define');
    const t = await harness([animatedSource('walk-anim', (s) => (s * 3) % 1)]);
    t.registry.register(
      defineNode({ id: 'walk-bad', title: 'bad', category: 'input', description: 'test', inputs: {}, outputs: { image: { type: 'image' } }, params: {}, render: () => { throw new Error('boom'); } }),
    );
    let g: GraphDoc = createGraph('walk-bad');
    const bad = addNode(g, t.registry, 'walk-bad');
    const inv = addNode(bad.graph, t.registry, 'invert');
    const a = addNode(inv.graph, t.registry, 'walk-anim');
    const m = addNode(a.graph, t.registry, 'merge');
    g = connect(m.graph, t.registry, { node: bad.node.id, port: 'image' }, { node: inv.node.id, port: 'image' });
    g = connect(g, t.registry, { node: inv.node.id, port: 'image' }, { node: m.node.id, port: 'background' });
    g = connect(g, t.registry, { node: a.node.id, port: 'image' }, { node: m.node.id, port: 'foreground' });
    for (let f = 0; f < 4; f++) {
      const r = await t.engine.evaluate({ graph: g, node: m.node.id, seconds: f / 10 });
      expect(r.errors.get(bad.node.id), `frame ${f}`).toBe('boom');
    }
  });
});
