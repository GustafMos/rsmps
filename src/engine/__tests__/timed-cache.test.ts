import { expect, it } from 'vitest';
import { Engine } from '../engine';
import { addNode, connect, createGraph } from '../graph';
import { harness } from '../testing';
import type { AnyNodeDef, ImageValue } from '../types';

const cachedBytes = (e: Engine) => (e as unknown as { cacheBytes: number }).cacheBytes;

it('memory stays flat over 200 frames of an animated chain with the default budget', async () => {
  const t = await harness();
  let g = createGraph();
  g.project = { ...g.project, width: 128, height: 128, fps: 25, duration: 10, loop: true };
  const noise = addNode(g, t.registry, 'noise', { x: 0, y: 0 }, { evolution: 3, scale: 30 });
  const blur = addNode(noise.graph, t.registry, 'blur', { x: 0, y: 0 }, { radius: 6 });
  const adj = addNode(blur.graph, t.registry, 'color-adjust', { x: 0, y: 0 }, { contrast: 1.3 });
  g = adj.graph;
  g = connect(g, t.registry, { node: noise.node.id, port: 'image' }, { node: blur.node.id, port: 'image' });
  g = connect(g, t.registry, { node: blur.node.id, port: 'image' }, { node: adj.node.id, port: 'image' });
  const engine = new Engine(t.gpu, t.registry, t.engine.host); // default budget: far above this graph's needs
  const bytes: number[] = [];
  const alloc: number[] = [];
  for (let f = 0; f < 200; f++) {
    await engine.evaluate({ graph: g, node: adj.node.id, seconds: f / 25 });
    bytes.push(cachedBytes(engine));
    alloc.push(t.gpu.stats().allocatedBytes);
  }
  const frameBytes = 128 * 128 * 4;
  // 3 nodes x 2 kept frames (plus masks/temporaries of the nodes' own results), flat from the first few frames on.
  expect(Math.max(...bytes)).toBeLessThanOrEqual(frameBytes * 12);
  expect(bytes[199]).toBe(bytes[20]);
  expect(alloc[199]).toBe(alloc[30]);
  engine.clear();
});

it('a node that pulls 8 earlier frames does not make its input re-render more than once per frame', async () => {
  const counts = { source: 0, echo: 0 };
  const source: AnyNodeDef = {
    id: 'test-src',
    title: 'src',
    category: 'input',
    description: 'counts renders',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      counts.source++;
      const f = ctx.time.frame;
      return { image: ctx.gpu.pass({ size: ctx.canvas, uniforms: { f }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.f / 255.0, 0.0, 0.0, 1.0); }' }) };
    },
  };
  const echo: AnyNodeDef = {
    id: 'test-echo',
    title: 'echo',
    category: 'time',
    description: 'pulls 8 earlier frames',
    inputs: { image: { type: 'image', required: true } },
    outputs: { image: { type: 'image' } },
    params: {},
    async render(ctx) {
      counts.echo++;
      for (let k = 1; k <= 8; k++) await ctx.pull('image', { seconds: ctx.time.seconds - k / ctx.time.fps });
      return { image: ctx.in.image };
    },
  };
  const t = await harness([source, echo]);
  let g = createGraph();
  g.project = { ...g.project, width: 32, height: 32, fps: 25, duration: 20, loop: true };
  const s = addNode(g, t.registry, 'test-src');
  const e = addNode(s.graph, t.registry, 'test-echo');
  g = connect(e.graph, t.registry, { node: s.node.id, port: 'image' }, { node: e.node.id, port: 'image' });
  const engine = new Engine(t.gpu, t.registry, t.engine.host);
  const perFrame: number[] = [];
  for (let f = 20; f < 80; f++) {
    const before = counts.source;
    const r = await engine.evaluate({ graph: g, node: e.node.id, seconds: f / 25 });
    expect((await t.gpu.read(r.value as ImageValue, false))[0]).toBe(f);
    perFrame.push(counts.source - before);
  }
  // First frames warm the span up; after that every frame renders its source exactly once (the 8 pulled frames are cache hits).
  expect(perFrame.slice(12).every((n) => n === 1)).toBe(true);
  expect(Math.max(...perFrame)).toBeLessThanOrEqual(9);
  engine.clear();
});
