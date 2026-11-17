import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { addNode, connect, createGraph, setParam } from '../graph';
import { makeGroup } from '../group';
import { RenderTally, harness, renderedNodes } from '../testing';
import type { AnyNodeDef, GraphDoc, ImageValue } from '../types';

/**
 * Repeat groups (docs/ENGINE.md, Pending rules, "Repeat groups"): chain and accumulate against hand-unrolled graphs (pixel-identical),
 * the Iteration node, per-pass caching, a wired / animated count and the count cap.
 */

const still: AnyNodeDef = {
  id: 'rp-still',
  title: 's',
  category: 'generate',
  description: 'static generator',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: {},
  render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 16, height: 16, unit: 1 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.8, uv.x * 0.6, uv.y * 0.4, 1.0); }' }) }),
};
/** A number that changes with the frame: 1, 2, 3, 1, 2, 3... */
const counter: AnyNodeDef = {
  id: 'rp-count',
  title: 'c',
  category: 'math',
  description: 'animated count',
  inputs: {},
  outputs: { value: { type: 'number' } },
  params: { fixed: { type: 'number', default: 0 } },
  render: (ctx) => ({ value: ctx.params.fixed ? Number(ctx.params.fixed) : 1 + (ctx.time.frame % 3) }),
};

type T = Awaited<ReturnType<typeof harness>>;
const base = (): GraphDoc => {
  const g = createGraph('r');
  return { ...g, project: { ...g.project, width: 16, height: 16, fps: 10, duration: 2, loop: true } };
};
function add(t: T, g: GraphDoc, type: string, params: Record<string, unknown> = {}) {
  const r = addNode(g, t.registry, type, { x: g.nodes.length * 200, y: 0 }, params);
  return { g: r.graph, id: r.node.id };
}

const HUE_STEP = 37;

/** s -> [color-adjust(brightness 0.04, hue = Iteration.index * HUE_STEP)] as a Repeat group -> out. */
function repeatGraph(t: T, mode: 'chain' | 'accumulate', count: number, extra: Record<string, unknown> = {}) {
  let g = base();
  const s = add(t, g, 'rp-still'); g = s.g;
  const ca = add(t, g, 'color-adjust', { brightness: 0.04 }); g = ca.g;
  const it = add(t, g, 'iteration'); g = it.g;
  const m = add(t, g, 'math', { op: 'multiply', b: HUE_STEP }); g = m.g;
  const out = add(t, g, 'color-adjust'); g = out.g;
  g = connect(g, t.registry, { node: s.id, port: 'image' }, { node: ca.id, port: 'image' });
  g = connect(g, t.registry, { node: it.id, port: 'index' }, { node: m.id, port: 'a' });
  g = connect(g, t.registry, { node: m.id, port: 'value' }, { node: ca.id, port: 'hue' });
  g = connect(g, t.registry, { node: ca.id, port: 'image' }, { node: out.id, port: 'image' });
  const made = makeGroup(g, t.registry, [ca.id, it.id, m.id], { kind: 'repeat' });
  const graph = setParam(setParam(made.graph, made.group.id, 'count', count), made.group.id, 'mode', mode);
  let gg = graph;
  for (const [k, v] of Object.entries(extra)) gg = setParam(gg, made.group.id, k, v);
  return { graph: gg, rid: made.group.id, out: out.id, ca: ca.id, it: it.id, m: m.id, s: s.id };
}

/** The same thing written out by hand. */
function unrolled(t: T, mode: 'chain' | 'accumulate', count: number, blend = 'normal', opacity = 1) {
  let g = base();
  const s = add(t, g, 'rp-still'); g = s.g;
  let prev = s.id;
  let acc: string | null = null;
  for (let i = 0; i < count; i++) {
    const ca = add(t, g, 'color-adjust', { brightness: 0.04, hue: i * HUE_STEP }); g = ca.g;
    g = connect(g, t.registry, { node: mode === 'chain' ? prev : s.id, port: 'image' }, { node: ca.id, port: 'image' });
    prev = ca.id;
    if (mode === 'accumulate') {
      if (!acc) acc = ca.id;
      else {
        const mg = add(t, g, 'merge', { mode: blend, opacity }); g = mg.g;
        g = connect(g, t.registry, { node: acc, port: 'image' }, { node: mg.id, port: 'background' });
        g = connect(g, t.registry, { node: ca.id, port: 'image' }, { node: mg.id, port: 'foreground' });
        acc = mg.id;
      }
    }
  }
  const out = add(t, g, 'color-adjust'); g = out.g;
  g = connect(g, t.registry, { node: mode === 'chain' ? prev : acc!, port: 'image' }, { node: out.id, port: 'image' });
  return { graph: g, out: out.id };
}

async function same(t: T, a: GraphDoc, an: string, b: GraphDoc, bn: string, seconds = 0) {
  const ea = new Engine(t.gpu, t.registry, t.engine.host);
  const eb = new Engine(t.gpu, t.registry, t.engine.host);
  const ra = await ea.evaluate({ graph: a, node: an, seconds });
  const rb = await eb.evaluate({ graph: b, node: bn, seconds });
  expect([...ra.errors.values()]).toEqual([]);
  expect([...rb.errors.values()]).toEqual([]);
  expect(ra.value).toBeTruthy();
  expect(await t.diff(ra.value as ImageValue, rb.value as ImageValue)).toBe(0);
  ea.clear();
  eb.clear();
}

describe('repeat groups', () => {
  it('chain: f(f(f(x))) with a per-pass hue equals the hand-unrolled chain', async () => {
    const t = await harness([still]);
    for (const n of [1, 3, 5]) {
      const r = repeatGraph(t, 'chain', n);
      const u = unrolled(t, 'chain', n);
      await same(t, u.graph, u.out, r.graph, r.out);
    }
  });

  it('accumulate: each pass on the original input, blended over the result so far', async () => {
    const t = await harness([still]);
    const r = repeatGraph(t, 'accumulate', 4, { blend: 'screen', opacity: 0.6 });
    const u = unrolled(t, 'accumulate', 4, 'screen', 0.6);
    await same(t, u.graph, u.out, r.graph, r.out);
  });

  it('the Iteration node gives index, fraction and count per pass', async () => {
    const t = await harness([still]);
    const r = repeatGraph(t, 'chain', 5);
    const at = async (pass: number, port: string) => (await t.engine.evaluate({ graph: r.graph, node: `${r.rid}/~${pass}/${r.it}`, port })).value;
    expect(await at(0, 'index')).toBe(0);
    expect(await at(3, 'index')).toBe(3);
    expect(await at(2, 'fraction')).toBe(0.5);
    expect(await at(4, 'count')).toBe(5);
    // outside a Repeat: pass 0 of 1
    const lone = add(t, base(), 'iteration');
    expect((await t.engine.evaluate({ graph: lone.g, node: lone.id, port: 'count' })).value).toBe(1);
    // the inner node by its plain path is shown as the last pass
    expect((await t.engine.evaluate({ graph: r.graph, node: `${r.rid}/${r.it}`, port: 'index' })).value).toBe(4);
  });

  it('caches per pass: an edit that does not change pass 0 re-renders only the later passes; cost is N x the inside', async () => {
    const t = await harness([still]);
    const r = repeatGraph(t, 'chain', 4);
    const e = new Engine(t.gpu, t.registry, t.engine.host);
    const first = renderedNodes(await e.evaluate({ graph: r.graph, node: r.out }));
    expect(first.length).toBe(1 + 4 * 3 + 1); // source + 4 x (color-adjust, iteration, math) + out: no hidden passes
    expect(renderedNodes(await e.evaluate({ graph: r.graph, node: r.out }))).toEqual([]);
    // hue step changes: pass 0 has hue 0 * step = 0 both times, so its color-adjust is a cache hit
    const edited = setParam(r.graph, r.rid, 'nodes', (r.graph.nodes.find((n) => n.id === r.rid)!.params.nodes as { id: string; params: Record<string, unknown> }[]).map((n) => (n.id === r.m ? { ...n, params: { ...n.params, b: HUE_STEP + 5 } } : n)));
    const again = renderedNodes(await e.evaluate({ graph: edited, node: r.out }));
    expect(again).not.toContain(`${r.rid}/~0/${r.ca}`);
    expect(again).toContain(`${r.rid}/~1/${r.ca}`);
    expect(again).toContain(`${r.rid}/~3/${r.ca}`);
    expect(again).not.toContain(r.s); // the static input stays cached
    e.clear();
  });

  it('a wired, animated count unrolls per frame; above the cap it is clamped with a message', async () => {
    const t = await harness([still, counter]);
    const r = repeatGraph(t, 'chain', 1);
    const c = add(t, r.graph, 'rp-count');
    const wired = connect(c.g, t.registry, { node: c.id, port: 'value' }, { node: r.rid, port: 'count' });
    const tally = new RenderTally();
    for (const f of [0, 1, 2, 3]) {
      const n = 1 + (f % 3);
      const u = unrolled(t, 'chain', n);
      const ea = new Engine(t.gpu, t.registry, t.engine.host);
      const ra = await ea.evaluate({ graph: u.graph, node: u.out, seconds: f / 10 });
      const rb = await t.engine.evaluate({ graph: wired, node: r.out, seconds: f / 10 });
      tally.add(rb);
      expect([...rb.errors.values()]).toEqual([]);
      expect(await t.diff(ra.value as ImageValue, rb.value as ImageValue)).toBe(0);
      ea.clear();
    }
    const big = setParam(wired, c.id, 'fixed', 100);
    const rb = await t.engine.evaluate({ graph: big, node: r.out });
    expect(rb.errors.get(r.rid)).toMatch(/above the limit of 64/);
  });
});
