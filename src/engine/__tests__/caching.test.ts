import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { addNode, connect, createGraph, setParam } from '../graph';
import { stableStringify } from '../lib/stable-json';
import { RenderTally, harness, renderedNodes } from '../testing';
import type { AnyNodeDef, GraphDoc, Region } from '../types';

/**
 * Caching audit (docs/ENGINE.md "Cache / Bake" and the keying rules): which nodes render when. `EvalResult.timings` lists exactly
 * the nodes that rendered, so every scenario is an assertion on that list.
 */

const staticSrc: AnyNodeDef = {
  id: 'cx-static',
  title: 's',
  category: 'generate',
  description: 'static generator',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: { v: { type: 'number', default: 0.5 } },
  render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 16, height: 16, unit: 1 }, uniforms: { v: Number(ctx.params.v) }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, 0.2, 0.3, 1.0); }' }) }),
};
const staticMask: AnyNodeDef = {
  id: 'cx-mask',
  title: 'm',
  category: 'generate',
  description: 'static mask',
  inputs: {},
  outputs: { mask: { type: 'mask' } },
  params: {},
  render: (ctx) => ({ mask: ctx.gpu.passMask({ size: { width: 16, height: 16, unit: 1 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(uv.x, uv.x, uv.x, 1.0); }' }) }),
};
const animSrc: AnyNodeDef = {
  id: 'cx-anim',
  title: 'a',
  category: 'generate',
  description: 'time-varying generator',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: {},
  render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 16, height: 16, unit: 1 }, uniforms: { f: ctx.time.frame }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.f / 255.0, 0.1, 0.1, 1.0); }' }) }),
};

type T = Awaited<ReturnType<typeof harness>>;
function wire(t: T, g: GraphDoc, from: string, to: string, port = 'image', fromPort = 'image'): GraphDoc {
  return connect(g, t.registry, { node: from, port: fromPort }, { node: to, port });
}
function add(t: T, g: GraphDoc, type: string, params: Record<string, unknown> = {}) {
  const r = addNode(g, t.registry, type, { x: 0, y: 0 }, params);
  return { g: r.graph, id: r.node.id };
}
function base(): GraphDoc {
  const g = createGraph('c');
  return { ...g, project: { ...g.project, width: 16, height: 16, fps: 10, duration: 4, loop: true } };
}

describe('caching audit', () => {
  it('(a) a param change re-renders the node and its downstream only', async () => {
    const t = await harness([staticSrc]);
    let g = base();
    const s = add(t, g, 'cx-static'); g = s.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const b = add(t, g, 'color-adjust'); g = b.g;
    const c = add(t, g, 'color-adjust'); g = c.g;
    const s2 = add(t, g, 'cx-static'); g = s2.g;
    const d = add(t, g, 'color-adjust'); g = d.g;
    g = wire(t, g, s.id, a.id); g = wire(t, g, a.id, b.id); g = wire(t, g, b.id, c.id); g = wire(t, g, s2.id, d.id);
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    expect(renderedNodes(await engine.evaluate({ graph: g, node: c.id }))).toEqual([a.id, b.id, c.id, s.id].sort());
    expect(renderedNodes(await engine.evaluate({ graph: g, node: c.id }))).toEqual([]);
    const edited = setParam(g, b.id, 'brightness', 0.2);
    expect(renderedNodes(await engine.evaluate({ graph: edited, node: c.id }))).toEqual([b.id, c.id].sort());
    // an unrelated branch was never touched, and is still a hit
    expect(renderedNodes(await engine.evaluate({ graph: edited, node: d.id }))).toEqual([d.id, s2.id].sort());
    expect(renderedNodes(await engine.evaluate({ graph: setParam(edited, b.id, 'brightness', 0.3), node: d.id }))).toEqual([]);
    engine.clear();
  });

  it('(b) a static subgraph renders once across playback, also through a mask and multi-wire layers, under a time-varying node', async () => {
    const t = await harness([staticSrc, staticMask, animSrc]);
    let g = base();
    const s = add(t, g, 'cx-static'); g = s.g;
    const blur = add(t, g, 'blur', { radius: 2 }); g = blur.g;
    const m = add(t, g, 'cx-mask'); g = m.g;
    const an = add(t, g, 'cx-anim'); g = an.g;
    const adj = add(t, g, 'color-adjust', { brightness: 0.1 }); g = adj.g;
    const stack = add(t, g, 'stack'); g = stack.g;
    g = wire(t, g, s.id, blur.id);
    g = wire(t, g, an.id, adj.id);
    g = wire(t, g, m.id, adj.id, 'mask', 'mask'); // the static mask feeds a maskable node whose image is time-varying
    g = wire(t, g, blur.id, stack.id, 'images'); // multi-wire: static layer under ...
    g = wire(t, g, adj.id, stack.id, 'images'); // ... a time-varying one
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    const tally = new RenderTally();
    for (let f = 0; f < 24; f++) tally.add(await engine.evaluate({ graph: g, node: stack.id, seconds: f / 10 }));
    for (const id of [s.id, blur.id, m.id]) expect(tally.get(id), id).toBe(1);
    for (const id of [an.id, adj.id, stack.id]) expect(tally.get(id), id).toBe(24);
    engine.clear();
  });

  it('(d) viewing another node reuses everything upstream of it', async () => {
    const t = await harness([staticSrc, animSrc]);
    let g = base();
    const an = add(t, g, 'cx-anim'); g = an.g;
    const x = add(t, g, 'color-adjust'); g = x.g;
    const y = add(t, g, 'color-adjust', { brightness: 0.2 }); g = y.g;
    const z = add(t, g, 'color-adjust', { brightness: -0.2 }); g = z.g;
    g = wire(t, g, an.id, x.id); g = wire(t, g, x.id, y.id); g = wire(t, g, y.id, z.id);
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    await engine.evaluate({ graph: g, node: z.id, seconds: 0.3 });
    // click the preview of an upstream node: nothing renders, it was computed on the way to z
    expect(renderedNodes(await engine.evaluate({ graph: g, node: y.id, seconds: 0.3 }))).toEqual([]);
    expect(renderedNodes(await engine.evaluate({ graph: g, node: x.id, seconds: 0.3 }))).toEqual([]);
    // a side branch hanging off x only renders itself
    const side = add(t, g, 'color-adjust', { contrast: 1.2 });
    const g2 = wire(t, side.g, x.id, side.id);
    expect(renderedNodes(await engine.evaluate({ graph: g2, node: side.id, seconds: 0.3 }))).toEqual([side.id]);
    engine.clear();
  });

  it('(g) keys are independent of object key order, and use the integer frame, not float seconds', async () => {
    expect(stableStringify({ a: 1, b: { y: [1, { q: 2, p: 3 }], x: 'k' } })).toBe(stableStringify({ b: { x: 'k', y: [1, { p: 3, q: 2 }] }, a: 1 }));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1])); // array order is meaningful (layers, palettes)

    const t = await harness([animSrc]);
    let g = base();
    const an = add(t, g, 'cx-anim'); g = an.g;
    const adj = add(t, g, 'color-adjust', { brightness: 0.1 }); g = adj.g;
    g = wire(t, g, an.id, adj.id);
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    await engine.evaluate({ graph: g, node: adj.id, seconds: 0.3 });
    // 0.1 * 3 is 0.30000000000000004: the same frame must still be a hit
    expect(renderedNodes(await engine.evaluate({ graph: g, node: adj.id, seconds: 0.1 * 3 }))).toEqual([]);
    expect(renderedNodes(await engine.evaluate({ graph: g, node: adj.id, seconds: 0.3004 }))).toEqual([]);
    // deep-equal params built in another key order: still a hit (a curve param is an object)
    const reordered: GraphDoc = { ...g, nodes: g.nodes.map((n) => (n.id === adj.id ? { ...n, params: Object.fromEntries(Object.entries(n.params).reverse()) } : n)) };
    expect(renderedNodes(await engine.evaluate({ graph: reordered, node: adj.id, seconds: 0.3 }))).toEqual([]);
    expect(engine.signatureOf(reordered, adj.id, 'image')).toBe(engine.signatureOf(g, adj.id, 'image'));
    engine.clear();
  });

  it('(f) per-frame CPU analysis is not repeated: a node that looks 20 frames back finds earlier detections in the cache', async () => {
    const counts = { detect: 0, track: 0 };
    const detect: AnyNodeDef = {
      id: 'cx-detect',
      title: 'd',
      category: 'track',
      description: 'cpu analysis with a texture output too',
      cpu: true,
      inputs: { image: { type: 'image', required: true } },
      outputs: { regions: { type: 'regions' }, mask: { type: 'mask' } },
      params: { label: { type: 'string', default: 'x' } },
      render(ctx) {
        counts.detect++;
        const f = ctx.time.frame;
        const items: Region[] = [{ id: f, label: String(ctx.params.label), score: 1, box: [0, 0, 0.5, 0.5] }];
        return { regions: { kind: 'regions', items }, mask: ctx.gpu.passMask({ size: ctx.in.image, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }' }) };
      },
    };
    const track: AnyNodeDef = {
      id: 'cx-track',
      title: 't',
      category: 'track',
      description: 'looks back over 20 frames, like Track',
      cpu: true,
      inputs: { regions: { type: 'regions', required: true } },
      outputs: { regions: { type: 'regions' } },
      params: {},
      async render(ctx) {
        counts.track++;
        let n = 0;
        for (let k = 1; k <= 20; k++) {
          const v = await ctx.pull('regions', { seconds: Math.max(0, ctx.time.frame - k) / ctx.time.fps });
          n += v?.items.length ?? 0;
        }
        return { regions: { kind: 'regions', items: [{ id: n, label: 'sum', score: 1, box: [0, 0, 1, 1] }] } };
      },
    };
    const t = await harness([staticSrc, animSrc, detect, track]);
    let g = base();
    g = { ...g, project: { ...g.project, duration: 20 } };
    const an = add(t, g, 'cx-anim'); g = an.g;
    const d = add(t, g, 'cx-detect'); g = d.g;
    const tr = add(t, g, 'cx-track'); g = tr.g;
    g = wire(t, g, an.id, d.id);
    g = wire(t, g, d.id, tr.id, 'regions', 'regions');
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    const pass = async () => {
      for (let f = 0; f < 60; f++) {
        const r = await engine.evaluate({ graph: g, node: tr.id, seconds: f / 10 });
        expect(r.errors.size).toBe(0);
      }
    };
    await pass();
    // each frame detected once (plus the window before frame 0, which clamps to frame 0): not 20 detections per frame
    expect(counts.detect).toBeLessThanOrEqual(61);
    const trackRuns = counts.track;
    expect(trackRuns).toBe(60);
    const before = counts.detect;
    await pass(); // replay: Track itself is time-keyed and re-runs, but no frame is detected again
    expect(counts.detect).toBe(before);
    // an edit of the detector invalidates its stored results
    const edited = setParam(g, d.id, 'label', 'y');
    await engine.evaluate({ graph: edited, node: tr.id, seconds: 2 });
    expect(counts.detect).toBeGreaterThan(before);
    engine.clear();
  });

  it('(h) under budget pressure cheap or time-keyed entries go first, expensive static ones stay, and the working set is never dropped', async () => {
    const slowStatic: AnyNodeDef = {
      ...staticSrc,
      id: 'cx-slow',
      async render(ctx) {
        await new Promise((r) => setTimeout(r, 25)); // an expensive generator
        return staticSrc.render!(ctx as never) as never;
      },
    };
    const t = await harness([slowStatic, animSrc]);
    let g = base();
    const slow = add(t, g, 'cx-slow'); g = slow.g;
    const an = add(t, g, 'cx-anim'); g = an.g;
    const fx1 = add(t, g, 'color-adjust', { brightness: 0.1 }); g = fx1.g;
    const fx2 = add(t, g, 'color-adjust', { brightness: 0.1 }); g = fx2.g;
    const fx = add(t, g, 'color-adjust', { brightness: 0.1 }); g = fx.g;
    g = wire(t, g, an.id, fx1.id); g = wire(t, g, fx1.id, fx2.id); g = wire(t, g, fx2.id, fx.id);
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    const frameBytes = 16 * 16 * 4;
    engine.cacheBudget = frameBytes * 8; // the 4-node working set, the generator and the older frames do not fit: every evaluation has to choose
    await engine.evaluate({ graph: g, node: slow.id });
    for (let f = 0; f < 30; f++) {
      await engine.evaluate({ graph: g, node: fx.id, seconds: f / 10 });
      expect(engine.cachedBytes).toBeLessThanOrEqual(frameBytes * 10); // pressure is relieved between evaluations (the working set of the last one is kept)
    }
    // the expensive static entry survived all that churn
    expect(renderedNodes(await engine.evaluate({ graph: g, node: slow.id }))).toEqual([]);
    // the picture just shown is its own working set: asking for it again is a hit even though the budget is tiny
    await engine.evaluate({ graph: g, node: fx.id, seconds: 2.9 });
    expect(renderedNodes(await engine.evaluate({ graph: g, node: fx.id, seconds: 2.9 }))).toEqual([]);
    engine.clear();
  });
});
