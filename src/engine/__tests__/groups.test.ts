import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { addNode, connect, createGraph, setParam } from '../graph';
import {
  exposeParam,
  flattenGraph,
  groupData,
  GROUP_IN,
  GROUP_MAX_DEPTH,
  GROUP_OUT,
  GROUP_TYPE,
  levelGraph,
  makeGroup,
  ungroupNode,
  unexposeParam,
  updateGroupAt,
  validateGroupNode,
  withLevel,
  withoutProcessResults,
} from '../group';
import { RenderTally, harness, renderedNodes } from '../testing';
import type { AnyNodeDef, Edge, GraphDoc, ImageValue, NodeInstance } from '../types';

/**
 * Group nodes (docs/ENGINE.md, Pending rules, "Group nodes"): pure group / ungroup / flatten, and the engine evaluating a grouped
 * document exactly like the flat one: same pixels, same number of node renders, no extra passes.
 */

const anim: AnyNodeDef = {
  id: 'gx-anim',
  title: 'a',
  category: 'generate',
  description: 'time-varying generator',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: { g: { type: 'number', default: 1 } },
  render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 16, height: 16, unit: 1 }, uniforms: { f: ctx.time.frame, g: Number(ctx.params.g) }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.f / 40.0 * u.g, uv.x, uv.y, 1.0); }' }) }),
};
const still: AnyNodeDef = {
  id: 'gx-still',
  title: 's',
  category: 'generate',
  description: 'static generator',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: { v: { type: 'number', default: 0.5 } },
  render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 16, height: 16, unit: 1 }, uniforms: { v: Number(ctx.params.v) }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, 1.0 - uv.x, 0.3, 1.0); }' }) }),
};
const maskSrc: AnyNodeDef = {
  id: 'gx-mask',
  title: 'm',
  category: 'generate',
  description: 'static mask',
  inputs: {},
  outputs: { mask: { type: 'mask' } },
  params: {},
  render: (ctx) => ({ mask: ctx.gpu.passMask({ size: { width: 16, height: 16, unit: 1 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(uv.y, uv.y, uv.y, 1.0); }' }) }),
};
const failing: AnyNodeDef = {
  id: 'gx-fail',
  title: 'f',
  category: 'filter',
  description: 'always throws',
  inputs: { image: { type: 'image', required: true } },
  outputs: { image: { type: 'image' } },
  params: {},
  render: () => {
    throw new Error('broken on purpose');
  },
};

type T = Awaited<ReturnType<typeof harness>>;
const base = (): GraphDoc => {
  const g = createGraph('g');
  return { ...g, project: { ...g.project, width: 16, height: 16, fps: 10, duration: 2, loop: true } };
};
function add(t: T, g: GraphDoc, type: string, params: Record<string, unknown> = {}) {
  const r = addNode(g, t.registry, type, { x: g.nodes.length * 200, y: 0 }, params);
  return { g: r.graph, id: r.node.id };
}
const wire = (t: T, g: GraphDoc, from: string, to: string, port = 'image', fromPort = 'image') => connect(g, t.registry, { node: from, port: fromPort }, { node: to, port });

/** Same document evaluated by two fresh engines: grouped vs flat. Pixels and the NUMBER of renders must match. */
async function compare(t: T, flat: GraphDoc, flatNode: string, grouped: GraphDoc, groupedNode: string, frames: number[] = [0], port?: string) {
  const ea = new Engine(t.gpu, t.registry, t.engine.host);
  const eb = new Engine(t.gpu, t.registry, t.engine.host);
  const ta = new RenderTally();
  const tb = new RenderTally();
  // count GPU passes too: a group boundary must not add one
  const gpu = t.gpu as unknown as { pass: (o: unknown) => unknown; passMask: (o: unknown) => unknown };
  const pass0 = gpu.pass;
  const mask0 = gpu.passMask;
  let passes = 0;
  gpu.pass = (o) => (passes++, pass0.call(t.gpu, o));
  gpu.passMask = (o) => (passes++, mask0.call(t.gpu, o));
  const passesA: number[] = [];
  const passesB: number[] = [];
  try {
  for (const f of [...frames, ...frames]) {
    passes = 0;
    const a = await ea.evaluate({ graph: flat, node: flatNode, seconds: f / 10, port });
    passesA.push(passes);
    passes = 0;
    const b = await eb.evaluate({ graph: grouped, node: groupedNode, seconds: f / 10, port });
    passesB.push(passes);
    expect([...a.errors.values()], 'flat errors').toEqual([]);
    expect([...b.errors.values()], 'grouped errors').toEqual([]);
    ta.add(a);
    tb.add(b);
    expect(a.value, 'flat value').toBeTruthy();
    expect(await t.diff(a.value as ImageValue, b.value as ImageValue)).toBe(0);
  }
  } finally {
    gpu.pass = pass0;
    gpu.passMask = mask0;
  }
  expect(passesB).toEqual(passesA);
  const sum = (x: RenderTally) => [...x.counts.values()].reduce((s, v) => s + v, 0);
  expect(sum(tb)).toBe(sum(ta));
  ea.clear();
  eb.clear();
  return { renders: sum(ta) };
}

function sortedEdges(g: GraphDoc): string[] {
  return g.edges.map((e) => `${e.id}|${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();
}
/** Wire order per target socket (the meaningful order of multi inputs). */
function perTarget(g: GraphDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of g.edges) (out[`${e.to.node}.${e.to.port}`] ??= []).push(`${e.from.node}.${e.from.port}`);
  return out;
}

describe('groups: pure', () => {
  it('group then ungroup gives the original graph (ids, params, wires, wire order)', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const s2 = add(t, g, 'gx-still', { v: 0.9 }); g = s2.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const b = add(t, g, 'color-adjust', { brightness: 0.1 }); g = b.g;
    const st = add(t, g, 'stack'); g = st.g;
    const c = add(t, g, 'color-adjust'); g = c.g;
    g = wire(t, g, s.id, a.id);
    g = wire(t, g, a.id, b.id);
    g = wire(t, g, s2.id, st.id, 'images');
    g = wire(t, g, b.id, st.id, 'images');
    g = wire(t, g, s.id, st.id, 'images');
    g = wire(t, g, st.id, c.id);
    const made = makeGroup(g, t.registry, [a.id, b.id, st.id]);
    const gd = groupData(made.group);
    expect(made.graph.nodes.map((n) => n.id).sort()).toEqual([s.id, s2.id, c.id, made.group.id].sort());
    expect(gd.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, st.id].sort());
    // s feeds two inner sockets: ONE input; s2 a second one
    expect(gd.inputs.length).toBe(2);
    expect(gd.outputs.length).toBe(1);
    const back = ungroupNode(made.graph, made.group.id).graph;
    expect(back.nodes.map((n) => n.id).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    for (const n of g.nodes) expect(back.nodes.find((x) => x.id === n.id)!.params).toEqual(n.params);
    expect(sortedEdges(back)).toEqual(sortedEdges(g));
    expect(perTarget(back)).toEqual(perTarget(g));
  });

  it('flattening namespaces inner ids, re-targets wires and adds no node', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const b = add(t, g, 'color-adjust'); g = b.g;
    const c = add(t, g, 'color-adjust'); g = c.g;
    g = wire(t, g, s.id, a.id);
    g = wire(t, g, a.id, b.id);
    g = wire(t, g, b.id, c.id);
    const made = makeGroup(g, t.registry, [a.id, b.id]);
    const v = flattenGraph(made.graph);
    expect(v.grouped).toBe(true);
    const gid = made.group.id;
    expect(v.graph.nodes.map((n) => n.id).sort()).toEqual([s.id, c.id, `${gid}/${a.id}`, `${gid}/${b.id}`].sort());
    expect(v.graph.nodes.length).toBe(g.nodes.length);
    expect(perTarget(v.graph)).toEqual({ [`${gid}/${a.id}.image`]: [`${s.id}.image`], [`${gid}/${b.id}.image`]: [`${gid}/${a.id}.image`], [`${c.id}.image`]: [`${gid}/${b.id}.image`] });
    expect(v.outputs.get(`${gid}:out1`)).toEqual({ node: `${gid}/${b.id}`, port: 'image' });
    // memoised per document object; a document without groups is returned as it is
    expect(flattenGraph(made.graph)).toBe(v);
    expect(flattenGraph(g).graph).toBe(g);
  });

  it('nested groups flatten and ungroup level by level; the depth cap and loops are refused', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const b = add(t, g, 'color-adjust'); g = b.g;
    g = wire(t, g, s.id, a.id);
    g = wire(t, g, a.id, b.id);
    const inner = makeGroup(g, t.registry, [a.id]);
    const outer = makeGroup(inner.graph, t.registry, [inner.group.id, b.id]);
    const v = flattenGraph(outer.graph);
    const og = outer.group.id;
    const ig = inner.group.id;
    expect(v.graph.nodes.map((n) => n.id).sort()).toEqual([s.id, `${og}/${ig}/${a.id}`, `${og}/${b.id}`].sort());
    expect(perTarget(v.graph)[`${og}/${ig}/${a.id}.image`]).toEqual([`${s.id}.image`]);
    const once = ungroupNode(outer.graph, og).graph;
    const twice = ungroupNode(once, ig).graph;
    expect(sortedEdges(twice)).toEqual(sortedEdges(g));

    // depth cap: wrap a group GROUP_MAX_DEPTH + 1 times
    let deep = outer.graph;
    let top = og;
    for (let i = 0; i < GROUP_MAX_DEPTH; i++) {
      const m = makeGroup(deep, t.registry, [top]);
      deep = m.graph;
      top = m.group.id;
    }
    const dv = flattenGraph(deep);
    expect([...dv.errors.values()].join(' ')).toMatch(/nested more than/);
    expect(validateGroupNode(deep.nodes.find((n) => n.id === top), t.registry).join(' ')).toMatch(/nested more than/);

    // a loop between two groups (only possible in a damaged file) does not hang
    const g1 = makeGroup(g, t.registry, [a.id]);
    const gA = g1.group;
    const gB: NodeInstance = { ...gA, id: 'gB' };
    const loop: GraphDoc = {
      ...g1.graph,
      nodes: [...g1.graph.nodes, gB],
      edges: [
        ...g1.graph.edges,
        { id: 'l1', from: { node: gA.id, port: 'out1' }, to: { node: 'gB', port: 'in1' } },
        { id: 'l2', from: { node: 'gB', port: 'out1' }, to: { node: gA.id, port: 'in1' } },
      ],
    };
    expect(() => flattenGraph(loop)).not.toThrow();
  });

  it('exposed params override the inner value, wires into them reach the inner param, unexpose writes the value back', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const val = add(t, g, 'value', { value: 0.25 }); g = val.g;
    g = wire(t, g, s.id, a.id);
    const made = makeGroup(g, t.registry, [a.id]);
    let gg = exposeParam(made.graph, made.group.id, a.id, 'brightness', t.registry, 'Bright');
    const gid = made.group.id;
    const x = groupData(gg.nodes.find((n) => n.id === gid)!).exposed[0];
    expect(x).toMatchObject({ node: a.id, param: 'brightness', label: 'Bright' });
    gg = setParam(gg, gid, x.id, 0.4);
    expect(flattenGraph(gg).graph.nodes.find((n) => n.id === `${gid}/${a.id}`)!.params.brightness).toBe(0.4);
    // a wire into the exposed socket drives the inner param
    const wired = connect(gg, t.registry, { node: val.id, port: 'value' }, { node: gid, port: x.id });
    expect(perTarget(flattenGraph(wired).graph)[`${gid}/${a.id}.brightness`]).toEqual([`${val.id}.value`]);
    // unexpose: value back inside, wire gone
    const un = unexposeParam(wired, gid, x.id);
    expect(groupData(un.nodes.find((n) => n.id === gid)!).nodes[0].params.brightness).toBe(0.4);
    expect(un.edges.some((e) => e.to.node === gid && e.to.port === x.id)).toBe(false);
    // ungroup keeps the exposed value and re-targets the exposed wire
    const back = ungroupNode(wired, gid).graph;
    expect(back.nodes.find((n) => n.id === a.id)!.params.brightness).toBe(0.4);
    expect(back.edges.some((e) => e.from.node === val.id && e.to.node === a.id && e.to.port === 'brightness')).toBe(true);
  });

  it('a level opens and writes back (boundary nodes carry the ports); copies drop stored results', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const c = add(t, g, 'cache', { baked: 'asset1', bakedSignature: 'x' }); g = c.g;
    g = wire(t, g, s.id, a.id);
    g = wire(t, g, a.id, c.id);
    const made = makeGroup(g, t.registry, [a.id, c.id]);
    const gid = made.group.id;
    const level = levelGraph(made.graph, [gid]);
    expect(level.nodes.map((n) => n.id)).toEqual([GROUP_IN, a.id, c.id, GROUP_OUT]);
    expect(levelGraph(made.graph, [gid])).toBe(level);
    const edited = withLevel(made.graph, [gid], setParam(level, a.id, 'brightness', 0.3));
    expect(groupData(edited.nodes.find((n) => n.id === gid)!).nodes.find((n) => n.id === a.id)!.params.brightness).toBe(0.3);
    expect(groupData(edited.nodes.find((n) => n.id === gid)!).inputs).toEqual(groupData(made.group).inputs);
    // duplicate / paste: the copy (and everything inside it) starts unprocessed
    const clearOf = (n: NodeInstance) => (n.type === 'cache' ? { baked: '', bakedSignature: '' } : null);
    const withHandle = updateGroupAt(edited, [gid], (n) => ({ ...n, params: { ...n.params, __process: { signature: 's', items: {} } } }));
    const copy = withoutProcessResults(withHandle.nodes.find((n) => n.id === gid)!, clearOf);
    expect(copy.params.__process).toBeUndefined();
    expect(groupData(copy).nodes.find((n) => n.type === 'cache')!.params.baked).toBe('');
  });

  it('refuses output and audio nodes; validates imported groups', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const out = t.registry.list().find((d) => d.category === 'output')!;
    const o = add(t, g, out.id); g = o.g;
    expect(() => makeGroup(g, t.registry, [s.id, o.id])).toThrow(/Output nodes/);
    const audio = t.registry.list().find((d) => d.audio && !d.render);
    if (audio) {
      const au = add(t, g, audio.id);
      expect(() => makeGroup(au.g, t.registry, [au.id])).toThrow(/audio/i);
    }
    const made = makeGroup(g, t.registry, [s.id]);
    expect(validateGroupNode(made.group, t.registry)).toEqual([]);
    const bad = { ...made.group, params: { ...made.group.params, nodes: [{ id: 'x', type: 'no-such-node', x: 0, y: 0, params: {} }] } };
    expect(validateGroupNode(bad, t.registry).join(' ')).toMatch(/unknown node type/);
  });
});

describe('groups: engine', () => {
  it('static chain: grouped renders pixel-identical with the same number of renders, cached after', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust', { brightness: 0.1 }); g = a.g;
    const b = add(t, g, 'color-adjust', { contrast: 0.3 }); g = b.g;
    const c = add(t, g, 'color-adjust'); g = c.g;
    g = wire(t, g, s.id, a.id);
    g = wire(t, g, a.id, b.id);
    g = wire(t, g, b.id, c.id);
    const made = makeGroup(g, t.registry, [a.id, b.id]);
    const r = await compare(t, g, c.id, made.graph, c.id, [0, 3]);
    expect(r.renders).toBe(4); // everything once, then all cache hits
    // viewing the group itself = its output; viewing an inner node by path works too
    await compare(t, g, b.id, made.graph, made.group.id);
    await compare(t, g, a.id, made.graph, `${made.group.id}/${a.id}`);
  });

  it('animated, masked, multi-wire and art-grid cases match the flat graph', async () => {
    const t = await harness([still, anim, maskSrc]);
    let g = base();
    const s = add(t, g, 'gx-anim'); g = s.g;
    const s2 = add(t, g, 'gx-still'); g = s2.g;
    const m = add(t, g, 'gx-mask'); g = m.g;
    const a = add(t, g, 'color-adjust', { brightness: 0.2 }); g = a.g;
    const px = add(t, g, 'pixelate', { size: 4 }); g = px.g;
    const st = add(t, g, 'stack'); g = st.g;
    const c = add(t, g, 'color-adjust', { saturation: 0.5 }); g = c.g;
    g = wire(t, g, s.id, a.id);
    g = wire(t, g, m.id, a.id, 'mask', 'mask');
    g = wire(t, g, a.id, px.id);
    g = wire(t, g, s2.id, st.id, 'images');
    g = wire(t, g, px.id, st.id, 'images');
    g = wire(t, g, s.id, st.id, 'images');
    g = wire(t, g, st.id, c.id);
    const made = makeGroup(g, t.registry, [a.id, px.id, st.id]);
    await compare(t, g, c.id, made.graph, c.id, [0, 1, 2, 7]);
    // a group of the sources only (generators inside, nothing entering)
    const srcs = makeGroup(g, t.registry, [s.id, m.id]);
    await compare(t, g, c.id, srcs.graph, c.id, [0, 5]);
  });

  it('lazy inputs (Cache / Bake inside a group, fed from outside) behave as in the flat graph', async () => {
    const t = await harness([anim]);
    let g = base();
    const s = add(t, g, 'gx-anim'); g = s.g;
    const k = add(t, g, 'cache'); g = k.g;
    const c = add(t, g, 'color-adjust'); g = c.g;
    g = wire(t, g, s.id, k.id);
    g = wire(t, g, k.id, c.id);
    const made = makeGroup(g, t.registry, [k.id, c.id]);
    await compare(t, g, c.id, made.graph, made.group.id, [0, 4, 9]);
  });

  it('an exposed param drives the inner node and can be wired from outside', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust'); g = a.g;
    const v = add(t, g, 'value', { value: 0.35 }); g = v.g;
    g = wire(t, g, s.id, a.id);
    const made = makeGroup(g, t.registry, [a.id]);
    const gid = made.group.id;
    let gg = exposeParam(made.graph, gid, a.id, 'brightness', t.registry);
    const xid = groupData(gg.nodes.find((n) => n.id === gid)!).exposed[0].id;
    gg = setParam(gg, gid, xid, 0.2);
    await compare(t, setParam(g, a.id, 'brightness', 0.2), a.id, gg, gid);
    const wiredFlat = connect(g, t.registry, { node: v.id, port: 'value' }, { node: a.id, port: 'brightness' });
    const wiredGroup = connect(gg, t.registry, { node: v.id, port: 'value' }, { node: gid, port: xid });
    await compare(t, wiredFlat, a.id, wiredGroup, gid);
  });

  it('an error inside a group shows on the inner node (by path) and on the group', async () => {
    const t = await harness([still, failing]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const f = add(t, g, 'gx-fail'); g = f.g;
    const c = add(t, g, 'color-adjust'); g = c.g;
    g = wire(t, g, s.id, f.id);
    g = wire(t, g, f.id, c.id);
    const made = makeGroup(g, t.registry, [f.id]);
    const r = await t.engine.evaluate({ graph: made.graph, node: c.id });
    expect(r.errors.get(`${made.group.id}/${f.id}`)).toMatch(/broken on purpose/);
    expect(r.errors.get(made.group.id)).toMatch(/broken on purpose/);
  });

  it('a bypassed group passes its first input through', async () => {
    const t = await harness([still]);
    let g = base();
    const s = add(t, g, 'gx-still'); g = s.g;
    const a = add(t, g, 'color-adjust', { brightness: 0.4 }); g = a.g;
    g = wire(t, g, s.id, a.id);
    const made = makeGroup(g, t.registry, [a.id]);
    const by = { ...made.graph, nodes: made.graph.nodes.map((n) => (n.type === GROUP_TYPE ? { ...n, bypass: true } : n)) };
    await compare(t, g, s.id, by, made.group.id);
  });

  it('a 500-node graph with nested groups: flattening is memoised and the cache-hit frame renders nothing', async () => {
    const t = await harness([still]);
    let g = base();
    const first = add(t, g, 'gx-still'); g = first.g;
    let prev = first.id;
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      const n = add(t, g, 'color-adjust', { brightness: (i % 7) / 100 });
      g = wire(t, n.g, prev, n.id);
      prev = n.id;
      ids.push(n.id);
    }
    let grouped = g;
    for (let k = 0; k < 10; k++) grouped = makeGroup(grouped, t.registry, ids.slice(k * 50, k * 50 + 49)).graph;
    // nest pairs of groups
    const tops = grouped.nodes.filter((n) => n.type === GROUP_TYPE).map((n) => n.id);
    for (let k = 0; k + 1 < tops.length; k += 2) grouped = makeGroup(grouped, t.registry, [tops[k], tops[k + 1]]).graph;
    const e = new Engine(t.gpu, t.registry, t.engine.host);
    e.cacheBudget = 1024 * 1024 * 1024;
    const r1 = await e.evaluate({ graph: grouped, node: prev });
    expect(r1.errors.size).toBe(0);
    expect(renderedNodes(r1).length).toBe(501);
    await e.evaluate({ graph: grouped, node: prev, seconds: 0.2 }); // (GPU queue drained, as for the flat run below)
    const t0 = performance.now();
    const v1 = flattenGraph(grouped);
    expect(flattenGraph(grouped)).toBe(v1);
    const r2 = await e.evaluate({ graph: grouped, node: prev, seconds: 0.5 });
    const ms = performance.now() - t0;
    expect(renderedNodes(r2)).toEqual([]);
    // the same chain without groups, for comparison
    const ef = new Engine(t.gpu, t.registry, t.engine.host);
    ef.cacheBudget = 1024 * 1024 * 1024;
    await ef.evaluate({ graph: g, node: prev });
    await ef.evaluate({ graph: g, node: prev, seconds: 0.2 }); // the first call after a cold render waits for the GPU queue (throttle)
    const t1 = performance.now();
    const rf = await ef.evaluate({ graph: g, node: prev, seconds: 0.5 });
    const msFlat = performance.now() - t1;
    expect(renderedNodes(rf)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[groups] 500-node chain, cache-hit frame: ${ms.toFixed(1)} ms in 5 nested groups of 2 x 49, ${msFlat.toFixed(1)} ms flat`);
    e.clear();
    ef.clear();
  });
});

export type { Edge };
