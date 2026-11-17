import { describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { groupData, makeGroup, updateGroupAt, withoutProcessResults } from '../engine/group';
import { processParamsPatch, withProcessResult } from '../engine/process';
import { RenderTally, harness } from '../engine/testing';
import type { GraphDoc, Host, ImageValue, NodeInstance, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

/**
 * Bake a group ("cache region", docs/ENGINE.md Pending rules): the group's outputs are rendered once and stored; baked, nothing inside is
 * evaluated; stale after an inner or upstream edit (and then live again); a copy starts unprocessed; unreferenced data is pruned on load.
 */
const FPS = 6;

async function setup() {
  const lib = new MemoryProcessLibrary();
  const counts = { src: 0 };
  const src = defineNode({
    id: 'gb-src',
    title: 'src',
    category: 'generate',
    description: 'animated source, counts renders',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      counts.src++;
      const v = ((ctx.time.frame % FPS) / FPS) * ctx.params.gain;
      return { image: ctx.gpu.pass({ size: { width: 12, height: 8, unit: 1 }, uniforms: { v }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, uv.x * 0.5, 0.25, 1.0); }' }) };
    },
  });
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: (id, s) => lib.assetFrame(id, s),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness([src], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({
    engine: t.engine,
    gpu: t.gpu,
    registry: t.registry,
    gate: new EvalGate(t.engine),
    library: lib,
    host,
    encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]),
  });
  let g: GraphDoc = createGraph('gb');
  g = { ...g, project: { ...g.project, width: 12, height: 8, fps: FPS, duration: 1, loop: true } };
  const a = addNode(g, t.registry, 'gb-src', { x: 0, y: 0 });
  const b = addNode(a.graph, t.registry, 'color-adjust', { x: 200, y: 0 }, { brightness: 0.2 });
  const c = addNode(b.graph, t.registry, 'invert', { x: 400, y: 0 });
  const d = addNode(c.graph, t.registry, 'color-adjust', { x: 600, y: 0 });
  g = connect(d.graph, t.registry, { node: a.node.id, port: 'image' }, { node: b.node.id, port: 'image' });
  g = connect(g, t.registry, { node: b.node.id, port: 'image' }, { node: c.node.id, port: 'image' });
  g = connect(g, t.registry, { node: c.node.id, port: 'image' }, { node: d.node.id, port: 'image' });
  const made = makeGroup(g, t.registry, [a.node.id, b.node.id, c.node.id]);
  return { t, lib, rt, flat: g, g: made.graph, gid: made.group.id, ids: { src: a.node.id, adj: b.node.id, inv: c.node.id, down: d.node.id }, counts };
}

describe('bake a group', () => {
  it('baked: same pixels as live, zero renders inside; stale (and live) after an inner edit; never re-bakes by itself', async () => {
    const { t, rt, g, gid, ids, counts } = await setup();
    expect(rt.status(g, gid)?.state).toBe('none');
    const result = await rt.run(g, gid, { projectId: 'p1' });
    const baked = withProcessResult(g, t.registry, gid, result);
    expect(rt.status(baked, gid)?.state).toBe('done');
    // survives a save (JSON round trip)
    expect(rt.status(JSON.parse(JSON.stringify(baked)), gid)?.state).toBe('done');
    const tally = new RenderTally();
    for (let f = 0; f < FPS; f++) {
      const live = await t.engine.evaluate({ graph: g, node: ids.down, seconds: f / FPS });
      const before = counts.src;
      const r = await t.engine.evaluate({ graph: baked, node: ids.down, seconds: f / FPS });
      tally.add(r);
      expect([...r.errors.values()]).toEqual([]);
      expect(counts.src).toBe(before); // nothing inside the group ran
      expect(await t.diff(r.value as ImageValue, live.value as ImageValue)).toBe(0);
    }
    for (const id of tally.counts.keys()) expect(id.startsWith(`${gid}/`)).toBe(false);
    // an inner edit makes it stale: the inside is evaluated live again (bypass stand-in), nothing restarts
    const edited = updateGroupAt(baked, [gid], (n) => ({ ...n, params: { ...n.params, nodes: groupData(n).nodes.map((x) => (x.id === ids.adj ? { ...x, params: { ...x.params, brightness: 0.5 } } : x)) } }));
    expect(rt.status(edited, gid)?.state).toBe('stale');
    const before = counts.src;
    await t.engine.evaluate({ graph: edited, node: ids.down, seconds: 0.5 });
    expect(counts.src).toBeGreaterThan(before);
    expect(rt.jobs().filter((j) => j.state === 'running' || j.state === 'queued')).toEqual([]);
    // an export never waits for a group bake (the live inside is exactly what the group computes)
    expect(rt.pending(edited)).toEqual([]);
  });

  it('a duplicate starts unprocessed, and data nothing references is pruned on load (not before)', async () => {
    const { t, lib, rt, g, gid } = await setup();
    const result = await rt.run(g, gid, { projectId: 'p1' });
    const baked = withProcessResult(g, t.registry, gid, result);
    const node = baked.nodes.find((n) => n.id === gid)!;
    const clearOf = (n: NodeInstance) => {
      const def = t.registry.get(n.type);
      return def?.process && n.type !== 'group' ? processParamsPatch(def, null) : null;
    };
    const copy = { ...withoutProcessResults(node, clearOf), id: 'copy1', y: 300 };
    const two = { ...baked, nodes: [...baked.nodes, copy] };
    expect(rt.status(two, 'copy1')?.state).toBe('none');
    expect(rt.status(two, gid)?.state).toBe('done');
    // pruning on load keeps what is referenced
    expect(await rt.prune('p1', two, { unreferenced: true })).toBe(0);
    expect(lib.assets.size).toBeGreaterThan(0);
    // the bake was undone (handle gone, node still there): a plain prune keeps the data (undo may bring it back) ...
    expect(await rt.prune('p1', g)).toBe(0);
    expect(lib.assets.size).toBeGreaterThan(0);
    // ... a result whose job finished in this session may still be on its way into the graph (another tab was open): kept ...
    expect(await rt.prune('p1', g, { unreferenced: true })).toBe(0);
    // ... once the UI has written it (and dismissed the job), pruning on load removes what nothing references
    rt.dismiss(gid, 'p1');
    expect(await rt.prune('p1', g, { unreferenced: true })).toBe(1);
    expect(lib.assets.size).toBe(0);
  });

  it('an inner process node is addressed by path: status, run and result handle', async () => {
    const { t, rt, flat, ids } = await setup();
    // a Cache / Bake inside a group, fed from outside
    let g = flat;
    const k = addNode(g, t.registry, 'cache', { x: 300, y: 200 });
    g = connect(k.graph, t.registry, { node: ids.inv, port: 'image' }, { node: k.node.id, port: 'image' });
    const made = makeGroup(g, t.registry, [k.node.id]);
    const path = `${made.group.id}/${k.node.id}`;
    expect(rt.status(made.graph, path)?.state).toBe('none');
    const res = await rt.run(made.graph, path, { projectId: 'p1', options: { quality: 'lossless' } });
    const done = withProcessResult(made.graph, t.registry, path, res);
    expect(rt.status(done, path)?.state).toBe('done');
    expect(groupData(done.nodes.find((n) => n.id === made.group.id)!).nodes[0].params.baked).toBeTruthy();
    // an upstream edit outside the group makes the inner bake stale
    expect(rt.status(setParam(done, ids.adj, 'brightness', 0.9), path)?.state).toBe('stale');
  });
});
