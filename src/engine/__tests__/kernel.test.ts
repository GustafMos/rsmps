import { describe, expect, it } from 'vitest';
import { defineNode } from '../define';
import { addNode, connect, connectError, createGraph, removeNodes } from '../graph';
import { harness } from '../testing';

describe('engine kernel', () => {
  it('registers built-in nodes by file name', async () => {
    const t = await harness();
    for (const id of ['media-in', 'color-adjust', 'blur', 'noise', 'merge', 'image-out']) expect(t.registry.get(id)).toBeTruthy();
  });

  it('runs a filter on the GPU and keeps size', async () => {
    const t = await harness();
    const src = t.solid(16, 8, [100, 100, 100, 255]);
    const out = await t.run('color-adjust', { brightness: 0.2 }, { image: src });
    const px = await t.pixels(out.image as never);
    expect([px.width, px.height]).toEqual([16, 8]);
    expect(px.at(3, 3)[0]).toBeGreaterThan(140);
    expect(px.at(3, 3)[3]).toBe(255);
  });

  it('converts px params by image unit (resolution independence)', async () => {
    const t = await harness();
    // Same picture at 1x and 2x resolution, with units 1 and 2: the blur must cover the same fraction.
    const small = t.fromFn(32, 32, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]), 1);
    const big = t.fromFn(64, 64, (x) => (x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]), 2);
    const a = await t.pixels((await t.run('blur', { radius: 4 }, { image: small })).image as never);
    const b = await t.pixels((await t.run('blur', { radius: 4 }, { image: big })).image as never);
    expect(Math.abs(a.at(13, 16)[0] - b.at(27, 32)[0])).toBeLessThan(12);
    expect(a.at(13, 16)[0]).toBeGreaterThan(5); // blur actually reached
  });

  it('applies the kernel effect mask and mix for maskable nodes', async () => {
    const t = await harness();
    const src = t.solid(8, 8, [100, 100, 100, 255]);
    const mask = t.maskFn(8, 8, (x) => (x < 4 ? 1 : 0));
    const px = await t.pixels((await t.run('color-adjust', { brightness: 0.4 }, { image: src, mask })).image as never);
    expect(px.at(1, 4)[0]).toBeGreaterThan(180);
    expect(px.at(6, 4)[0]).toBe(100);
    const half = await t.pixels((await t.run('color-adjust', { brightness: 0.4, mix: 0.5 }, { image: src })).image as never);
    expect(half.at(6, 4)[0]).toBeGreaterThan(130);
    expect(half.at(6, 4)[0]).toBeLessThan(170);
  });

  it('lets a wired number drive a param', async () => {
    const t = await harness();
    const src = t.solid(4, 4, [100, 100, 100, 255]);
    const px = await t.pixels((await t.run('color-adjust', {}, { image: src, brightness: 0.4 })).image as never);
    expect(px.at(1, 1)[0]).toBeGreaterThan(180);
  });

  it('caches static nodes and re-renders only time-dependent ones', async () => {
    let staticRuns = 0;
    let timedRuns = 0;
    const t = await harness([
      defineNode({ id: 'count-static', title: 's', category: 'math', description: 'd', inputs: {}, outputs: { v: { type: 'number' } }, params: {}, render: () => ({ v: ++staticRuns }) }),
      defineNode({ id: 'count-timed', title: 't', category: 'math', description: 'd', inputs: {}, outputs: { v: { type: 'number' } }, params: {}, render: (ctx) => ({ v: ctx.time.frame + 0 * ++timedRuns }) }),
    ]);
    let g = createGraph();
    const a = addNode(g, t.registry, 'count-static');
    const b = addNode(a.graph, t.registry, 'count-timed');
    g = b.graph;
    for (const s of [0, 0.5, 1, 1]) {
      await t.engine.evaluate({ graph: g, node: a.node.id, seconds: s });
      await t.engine.evaluate({ graph: g, node: b.node.id, seconds: s });
    }
    expect(staticRuns).toBe(1);
    expect(timedRuns).toBe(3);
  });

  it('only evaluates nodes upstream of the request', async () => {
    let runs = 0;
    const t = await harness([
      defineNode({ id: 'spy', title: 's', category: 'math', description: 'd', inputs: {}, outputs: { v: { type: 'number' } }, params: {}, render: () => ({ v: ++runs }) }),
    ]);
    let g = createGraph();
    const noise = addNode(g, t.registry, 'noise');
    g = addNode(noise.graph, t.registry, 'spy').graph;
    await t.evalGraph(g, noise.node.id);
    expect(runs).toBe(0);
  });

  it('animated generators loop seamlessly and actually move', async () => {
    const t = await harness();
    const r = await t.loopCheck('noise', { evolution: 2, scale: 20 });
    expect(r.seam).toBe(0);
    expect(r.motion).toBeGreaterThan(1);
  });

  it('merges a foreground over a background of another size', async () => {
    const t = await harness();
    const bg = t.solid(32, 16, [0, 0, 255, 255]);
    const fg = t.solid(8, 8, [255, 0, 0, 255]);
    const px = await t.pixels((await t.run('merge', { fit: 'contain' }, { background: bg, foreground: fg })).image as never);
    expect(px.at(16, 8)).toEqual([255, 0, 0, 255]);
    expect(px.at(2, 8)).toEqual([0, 0, 255, 255]);
  });

  it('graph helpers reject bad wires and heal on delete', async () => {
    const t = await harness();
    let g = createGraph();
    const n = addNode(g, t.registry, 'noise');
    const b = addNode(n.graph, t.registry, 'blur');
    const o = addNode(b.graph, t.registry, 'image-out');
    g = o.graph;
    g = connect(g, t.registry, { node: n.node.id, port: 'image' }, { node: b.node.id, port: 'image' });
    g = connect(g, t.registry, { node: b.node.id, port: 'image' }, { node: o.node.id, port: 'image' });
    expect(connectError(g, t.registry, { node: b.node.id, port: 'image' }, { node: n.node.id, port: 'size' })).toMatch(/loop/);
    expect(connectError(g, t.registry, { node: n.node.id, port: 'image' }, { node: b.node.id, port: 'radius' })).toMatch(/Cannot connect/);
    g = removeNodes(g, t.registry, [b.node.id]);
    expect(g.edges).toHaveLength(1);
    expect(await t.evalGraph(g, o.node.id)).toBeTruthy();
  });

  it('reports node errors instead of throwing', async () => {
    const t = await harness([
      defineNode({
        id: 'boom',
        title: 'b',
        category: 'math',
        description: 'd',
        inputs: {},
        outputs: { v: { type: 'number' } },
        params: {},
        render: () => {
          throw new Error('kaput');
        },
      }),
    ]);
    const a = addNode(createGraph(), t.registry, 'boom');
    const r = await t.engine.evaluate({ graph: a.graph, node: a.node.id });
    expect(r.value).toBeNull();
    expect(r.errors.get(a.node.id)).toBe('kaput');
  });
});
