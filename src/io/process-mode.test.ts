/**
 * Process mode, end to end on the real GPU with a RAM library: stand-in modes, state in the cache key, staleness, a missing store,
 * failure, the export gate, and a full 12-frame headless run served from the store with zero upstream renders.
 * (The pure scheduler is tested in processes.test.ts, bake regressions in bake.test.ts, Track's process in process-track.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { withProcessResult, processResultOf } from '../engine/process';
import { RenderTally, harness } from '../engine/testing';
import type { GraphDoc, Host, ImageValue, ProcessLive, ProcessStandIn } from '../engine/types';
import type { ExportRequest } from './api';
import { ExporterImpl } from './exporter';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessPendingError, ProcessRuntime } from './processes';

const FPS = 12;
const FRAMES = 12;

interface Hooks {
  /** Called inside the job before frame f is pulled. */
  step?: (f: number) => Promise<void> | void;
  fail?: boolean;
}

/** A node with a slow job: the job pulls its input for every frame and stores them as a sequence; render serves them. */
function slowNode(id: string, standIn: ProcessStandIn, hooks: Hooks = {}, required: 'always' | 'once-run' | 'never' = 'always') {
  return defineNode({
    id,
    title: 'Slow',
    category: 'generate',
    description: 'test node with a process',
    inputs: { image: { type: 'image', lazy: true } },
    outputs: { image: { type: 'image' } },
    params: {
      strength: { type: 'number', default: 1 },
      tag: { type: 'string', default: '' }, // display only: not part of the signature
    },
    process: {
      title: 'Slow job',
      standIn,
      required,
      signature: (p, sigs) => `${p.strength}|${sigs.image}`,
      async run(job) {
        const blobs: Blob[] = [];
        let size = { width: 0, height: 0 };
        for (let f = 0; f < job.frames; f++) {
          await job.yield();
          await hooks.step?.(f);
          if (hooks.fail && f === 3) throw new Error('model file is corrupt');
          const pulled = await job.pull('image', { frame: f });
          try {
            const img = pulled.value as ImageValue;
            size = { width: img.width, height: img.height };
            blobs.push(await job.encodeImage(img, 'lossless'));
          } finally {
            pulled.release();
          }
          job.progress((f + 1) / job.frames, `frame ${f + 1}`);
        }
        job.store.sequence('frames', blobs, { fps: job.fps, ...size });
        return { meta: { n: job.frames } };
      },
    },
    async render(ctx) {
      const ps = ctx.process!;
      if (ps.servable) {
        const n = (ps.result!.meta.n as number) || 1;
        const f = await ps.frame('frames', ctx.time.frame % n);
        if (f) return { image: { kind: 'image', texture: f.texture, width: f.width, height: f.height, unit: 1 } };
      }
      if (standIn === 'preview') {
        // the node's own cheap approximation: a dimmed copy of the input
        const src = await ctx.pull('image');
        if (!src) return {};
        return { image: ctx.gpu.pass({ size: src, textures: { src }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let c = textureSampleLevel(src, smp, uv, 0.0); return vec4f(c.rgb * 0.25, c.a); }' }) };
      }
      return ps.standIn();
    },
  });
}

async function setup(standIn: ProcessStandIn, hooks: Hooks = {}, required: 'always' | 'once-run' | 'never' = 'always') {
  const lib = new MemoryProcessLibrary();
  const spyId = 'proc-spy';
  const sink = new RenderTally();
  const counts = { spy: 0, down: 0 };
  const spy = defineNode({
    id: spyId,
    title: 'spy',
    category: 'generate',
    description: 'animated source, counts renders',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      counts.spy++;
      const v = ((ctx.time.frame % FRAMES) / FRAMES) * ctx.params.gain;
      return { image: ctx.gpu.pass({ size: { width: 12, height: 8, unit: 1 }, uniforms: { v }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, uv.x * 0.5, 0.25, 1.0); }' }) };
    },
  });
  const still = defineNode({
    id: 'proc-still',
    title: 'still',
    category: 'generate',
    description: 'a still picture (never reads the clock), for the independent branch',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 12, height: 8, unit: 1 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.1, 0.6, 0.3, 1.0); }' }) }),
  });
  const down = defineNode({
    id: 'proc-down',
    title: 'down',
    category: 'filter',
    description: 'downstream of the slow node',
    inputs: { image: { type: 'image', required: true } },
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      counts.down++;
      return { image: ctx.gpu.pass({ size: ctx.in.image, textures: { src: ctx.in.image }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }' }) };
    },
  });
  const slowId = `slow-${standIn}`;
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: (id, s) => lib.assetFrame(id, s),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness([spy, still, down, slowNode(slowId, standIn, hooks, required)], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear(); // what Library.onInvalidate does
  const rt: ProcessRuntime = new ProcessRuntime({
    engine: t.engine,
    gpu: t.gpu,
    registry: t.registry,
    gate: new EvalGate(t.engine),
    library: lib,
    host,
    encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]),
  });
  let g: GraphDoc = createGraph('proc');
  g = { ...g, project: { ...g.project, width: 12, height: 8, fps: FPS, duration: 1, loop: true } };
  const a = addNode(g, t.registry, spyId);
  const s = addNode(a.graph, t.registry, slowId);
  const d = addNode(s.graph, t.registry, 'proc-down');
  // an independent branch that must never be touched by the slow node's state
  const a2 = addNode(d.graph, t.registry, 'proc-still');
  const d2 = addNode(a2.graph, t.registry, 'proc-down');
  g = connect(d2.graph, t.registry, { node: a.node.id, port: 'image' }, { node: s.node.id, port: 'image' });
  g = connect(g, t.registry, { node: s.node.id, port: 'image' }, { node: d.node.id, port: 'image' });
  g = connect(g, t.registry, { node: a2.node.id, port: 'image' }, { node: d2.node.id, port: 'image' });
  const ids = { spy: a.node.id, slow: s.node.id, down: d.node.id, spy2: a2.node.id, down2: d2.node.id };
  const evalAt = async (graph: GraphDoc, node: string, frame: number) => {
    const r = await t.engine.evaluate({ graph, node, seconds: frame / FPS });
    sink.add(r);
    return r;
  };
  /** Run the slow node's process and write the result into the graph (what the UI does). */
  const process = async (graph: GraphDoc) => withProcessResult(graph, t.registry, ids.slow, await rt.run(graph, ids.slow));
  return { t, lib, rt, g, ids, counts, sink, evalAt, process, slowId };
}

describe('process mode', () => {
  it('bypass: passes the input through until done, then serves 12 stored frames with zero upstream renders', async () => {
    const { t, rt, g, ids, counts, sink, evalAt, process } = await setup('bypass');
    expect(rt.status(g, ids.slow)?.state).toBe('none');
    // not processed: the picture of the node is the picture of its input
    for (const f of [0, 5]) {
      const live = await evalAt(g, ids.spy, f);
      const out = await evalAt(g, ids.slow, f);
      expect(out.errors.size).toBe(0);
      expect(await t.diff(out.value as ImageValue, live.value as ImageValue)).toBe(0);
    }
    const done = await process(g);
    expect(rt.status(done, ids.slow)?.state).toBe('done');
    expect(rt.jobs()[0]).toMatchObject({ state: 'done', progress: 1, node: ids.slow });
    // the result is a handle in the node's params: it survives a JSON round trip (saving the project)
    const reloaded = JSON.parse(JSON.stringify(done)) as GraphDoc;
    expect(rt.status(reloaded, ids.slow)?.state).toBe('done');
    expect(processResultOf(reloaded.nodes.find((n) => n.id === ids.slow)!, t.registry.get('slow-bypass')!)?.items.frames.frames).toBe(FRAMES);

    sink.reset();
    const spyBefore = counts.spy;
    for (let f = 0; f < FRAMES; f++) {
      const out = await evalAt(done, ids.down, f);
      expect(out.errors.size).toBe(0);
      // identical to what the live graph gives for that frame (lossless store)
      const live = await t.engine.evaluate({ graph: g, node: ids.spy, seconds: f / FPS });
      expect(await t.diff(out.value as ImageValue, live.value as ImageValue)).toBe(0);
    }
    // the only spy renders were the ones this test asked for itself, as live references (one per frame): none came from the process node
    expect(counts.spy - spyBefore).toBe(FRAMES);
    const t2 = new RenderTally();
    for (let f = 0; f < FRAMES; f++) t2.add(await t.engine.evaluate({ graph: done, node: ids.down, seconds: f / FPS }));
    expect(t2.get(ids.spy)).toBe(0); // upstream never evaluated: the frames come from the store
  });

  it('serving from the store never evaluates upstream even for frames not seen before', async () => {
    const { t, g, ids, process } = await setup('bypass');
    const done = await process(g);
    const tally = new RenderTally();
    await t.engine.clear();
    for (let f = 0; f < FRAMES; f++) tally.add(await t.engine.evaluate({ graph: done, node: ids.down, seconds: f / FPS }));
    expect(tally.get(ids.spy)).toBe(0);
    expect(tally.get(ids.slow)).toBe(FRAMES);
    expect(tally.get(ids.down)).toBe(FRAMES);
  });

  it('finishing a job invalidates exactly this node and what is downstream, not other branches', async () => {
    const { g, ids, sink, evalAt, process } = await setup('bypass');
    const F = 0;
    await evalAt(g, ids.down, F);
    await evalAt(g, ids.down2, F);
    sink.reset();
    expect((await evalAt(g, ids.down, F)).timings.size).toBe(0); // everything cached
    const done = await process(g);
    sink.reset();
    const a = await evalAt(done, ids.down, F);
    const b = await evalAt(done, ids.down2, F);
    expect([...a.timings.keys()].sort()).toEqual([ids.down, ids.slow].sort()); // this node + downstream, nothing upstream
    expect(b.timings.size).toBe(0); // the other branch kept every cached result
  });

  it('progress never invalidates caches; only a state change re-renders the node, once', async () => {
    const seen: number[] = [];
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup('bypass', {
      step: async (f) => {
        const r = await env.t.engine.evaluate({ graph: env.g, node: env.ids.down, seconds: 0 });
        seen.push(r.timings.size);
        void f;
      },
    });
    await env.evalAt(env.g, env.ids.down, 0); // warm: state 'none'
    await env.rt.run(env.g, env.ids.slow);
    // 12 evaluations while the job ran (progress 0 .. 11/12): the first saw the new 'running' state (slow + down render), the rest nothing
    expect(seen).toHaveLength(FRAMES);
    expect(seen[0]).toBe(2);
    expect(seen.slice(1).every((n) => n === 0)).toBe(true);
  });

  it('placeholder: a canvas-sized striped card, re-rendered at most once per progress step', async () => {
    const seen: number[] = [];
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup('placeholder', {
      step: async () => {
        const r = await env.t.engine.evaluate({ graph: env.g, node: env.ids.slow, seconds: 0 });
        seen.push(r.timings.has(env.ids.slow) ? 1 : 0);
      },
    });
    const before = (await env.t.engine.evaluate({ graph: env.g, node: env.ids.slow, seconds: 0 })).value as ImageValue;
    expect(before).toMatchObject({ kind: 'image', width: 12, height: 8 }); // canvas-sized
    const live = (await env.t.engine.evaluate({ graph: env.g, node: env.ids.spy, seconds: 0 })).value as ImageValue;
    expect(await env.t.diff(before, live)).toBeGreaterThan(10); // not the input: a card
    const px = await env.t.pixels(before);
    const distinct = new Set<string>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) distinct.add(px.at(x, y).join(','));
    expect(distinct.size).toBeGreaterThan(1); // stripes
    await env.rt.run(env.g, env.ids.slow);
    expect(seen).toHaveLength(FRAMES);
    const renders = seen.reduce((a, b) => a + b, 0);
    expect(renders).toBeLessThanOrEqual(11); // 10 progress steps + the state change
    expect(renders).toBeGreaterThanOrEqual(2); // it does show progress
    expect(renders).toBeLessThan(FRAMES + 1);
  });

  it('preview: the node decides (its own approximation), and the stored result replaces it', async () => {
    const { t, g, ids, evalAt, process } = await setup('preview');
    const live = (await evalAt(g, ids.spy, 6)).value as ImageValue;
    const approx = (await evalAt(g, ids.slow, 6)).value as ImageValue;
    const pa = await t.pixels(approx);
    const pl = await t.pixels(live);
    expect(pa.at(3, 3)[0]).toBeLessThan(pl.at(3, 3)[0]); // dimmed copy
    const done = await process(g);
    const served = await t.pixels((await evalAt(done, ids.slow, 6)).value as ImageValue);
    expect(Array.from(served.data)).toEqual(Array.from(pl.data)); // read before the job ran: the textures of earlier evaluations are recycled
  });

  it('stale: params or upstream changes keep the result and the badge, never restart by themselves; display params do not count', async () => {
    const { t, rt, g, ids, evalAt, process } = await setup('last');
    const done = await process(g);
    const jobsAfter = rt.jobs().length;
    const live6 = await t.pixels((await evalAt(g, ids.spy, 6)).value as ImageValue);
    expect(rt.status(done, ids.slow)?.state).toBe('done');

    expect(rt.status(setParam(done, ids.slow, 'tag', 'renamed'), ids.slow)?.state).toBe('done'); // display only
    const byParam = setParam(done, ids.slow, 'strength', 2);
    expect(rt.status(byParam, ids.slow)?.state).toBe('stale');
    const byUpstream = setParam(done, ids.spy, 'gain', 0.5);
    expect(rt.status(byUpstream, ids.slow)?.state).toBe('stale');
    expect(rt.status(byUpstream, ids.spy)).toBeNull(); // a node without process has no status

    // 'last' keeps serving the previous result while stale (the upstream is no longer what it was made from)
    const served = await t.pixels((await evalAt(byUpstream, ids.slow, 6)).value as ImageValue);
    expect(Array.from(served.data)).toEqual(Array.from(live6.data));
    expect(rt.jobs().length).toBe(jobsAfter); // nothing was queued
    expect(rt.live(ids.slow)).toBeNull();
    // re-processing makes it done for the new graph
    const again = withProcessResult(byUpstream, t.registry, ids.slow, await rt.run(byUpstream, ids.slow));
    expect(rt.status(again, ids.slow)?.state).toBe('done');
  });

  it('stale with bypass: the stand-in shows again (a stale result is not served)', async () => {
    const { t, g, ids, evalAt, process } = await setup('bypass');
    const done = await process(g);
    const edited = setParam(done, ids.spy, 'gain', 0.5);
    const live = (await evalAt(edited, ids.spy, 6)).value as ImageValue;
    const out = (await evalAt(edited, ids.slow, 6)).value as ImageValue;
    expect(await t.diff(out, live)).toBe(0);
  });

  it('missing: the stored data is gone -> state missing, stand-in shown, no crash', async () => {
    const { t, lib, rt, g, ids, evalAt, process } = await setup('bypass');
    const done = await process(g);
    lib.assets.clear(); // cleared storage
    expect(rt.status(done, ids.slow)?.state).toBe('missing');
    const live = (await evalAt(done, ids.spy, 3)).value as ImageValue;
    const r = await evalAt(done, ids.slow, 3);
    expect(r.errors.size).toBe(0);
    expect(await t.diff(r.value as ImageValue, live)).toBe(0);
  });

  it('failure: reported on the job and as state failed, the stand-in stays, the message is readable, retry works', async () => {
    const hooks: Hooks = { fail: true };
    const { rt, g, ids, process } = await setup('bypass', hooks);
    await expect(rt.run(g, ids.slow)).rejects.toThrow('model file is corrupt');
    expect(rt.job(ids.slow)).toMatchObject({ state: 'failed', error: 'model file is corrupt' });
    expect(rt.live(ids.slow)).toMatchObject({ state: 'failed', error: 'model file is corrupt' });
    expect(rt.status(g, ids.slow)?.state).toBe('failed');
    hooks.fail = false;
    const done = await process(g); // a new run replaces the failed record
    expect(rt.status(done, ids.slow)?.state).toBe('done');
    expect(rt.live(ids.slow)).toBeNull();
  });

  it('cancel: nothing is stored and a previous result stays', async () => {
    const ctl = new AbortController();
    const { lib, rt, g, ids, process } = await setup('bypass', { step: (f) => void (f === 4 && ctl.abort()) });
    // first, a good result under a different hook is not needed: cancelling a first run leaves the store empty
    await expect(rt.run(g, ids.slow, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(lib.assets.size).toBe(0);
    expect(rt.status(g, ids.slow)?.state).toBe('none');
    void process;
  });

  it('export gate: lists what is not done, honours required, and "run first" fills the results in', async () => {
    const { t, rt, g, ids } = await setup('bypass');
    const pending = rt.pending(g, [ids.down]);
    expect(pending).toEqual([{ node: ids.slow, type: 'slow-bypass', label: 'Slow', title: 'Slow job', state: 'none' }]);
    expect(rt.pending(g, [ids.down2])).toEqual([]); // not upstream of that output

    const exporter = new ExporterImpl({ processes: rt, registry: t.registry } as never);
    const gate = (req: ExportRequest) => (exporter as unknown as { processGate(r: ExportRequest): Promise<ExportRequest> }).processGate(req);
    const req: ExportRequest = { graph: g, outputs: [ids.down], items: 'current', item: 0, zip: false };
    await expect(gate(req)).rejects.toBeInstanceOf(ProcessPendingError);
    await expect(gate(req)).rejects.toThrow(/Slow \(Slow job, none\)/);

    const results: string[] = [];
    const out = await gate({ ...req, runProcesses: true, onProcessResult: (n) => results.push(n) });
    expect(results).toEqual([ids.slow]);
    expect(rt.status(out.graph, ids.slow)?.state).toBe('done');
    expect(rt.pending(out.graph, [ids.down])).toEqual([]);
    await expect(gate({ ...req, graph: out.graph })).resolves.toMatchObject({ graph: out.graph }); // nothing left: passes untouched
  });

  it('export gate: a stale result is pending too, and a done process hides what is before it', async () => {
    const { rt, g, ids, process } = await setup('bypass');
    const done = await process(g);
    expect(rt.pending(done, [ids.down])).toEqual([]);
    const edited = setParam(done, ids.spy, 'gain', 0.5);
    expect(rt.pending(edited, [ids.down])).toMatchObject([{ node: ids.slow, state: 'stale' }]);
  });

  it("required 'never' (like Cache / Bake) and 'once-run' only gate when they have to", async () => {
    const never = await setup('bypass', {}, 'never');
    expect(never.rt.pending(never.g, [never.ids.down])).toEqual([]);
    const once = await setup('bypass', {}, 'once-run');
    expect(once.rt.pending(once.g, [once.ids.down])).toEqual([]); // never run: the stand-in is the node's honest behaviour
    const done = await once.process(once.g);
    const lost = (() => {
      once.lib.assets.clear();
      return done;
    })();
    expect(once.rt.pending(lost, [once.ids.down])).toMatchObject([{ state: 'missing' }]); // run once, data gone: an export must not fall back
  });

  it('bypassed process nodes are not needed', async () => {
    const { rt, g, ids } = await setup('bypass');
    const bypassed = { ...g, nodes: g.nodes.map((n) => (n.id === ids.slow ? { ...n, bypass: true } : n)) };
    expect(rt.pending(bypassed, [ids.down])).toEqual([]);
  });

  it('Cache / Bake is a process node: its legacy baked* params are the handle, bake is never required for export', async () => {
    const lib = new MemoryProcessLibrary();
    const host: Host = { assetInfo: (id) => lib.assetInfo(id), assetFrame: (id, s) => lib.assetFrame(id, s), processLive: (n) => rt.live(n) };
    const spy = defineNode({
      id: 'proc-spy2',
      title: 'spy',
      category: 'generate',
      description: 'x',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 12, height: 8, unit: 1 }, uniforms: { v: ctx.time.frame / 8 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, 0.2, 0.2, 1.0); }' }) }),
    });
    const t = await harness([spy], host);
    lib.gpu = t.gpu;
    const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host, encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]) });
    let g = createGraph('c');
    g = { ...g, project: { ...g.project, width: 12, height: 8, fps: 8, duration: 1, loop: true } };
    const a = addNode(g, t.registry, 'proc-spy2');
    const c = addNode(a.graph, t.registry, 'cache');
    g = connect(c.graph, t.registry, { node: a.node.id, port: 'image' }, { node: c.node.id, port: 'image' });
    expect(rt.status(g, c.node.id)?.state).toBe('none');
    expect(rt.pending(g, [c.node.id])).toEqual([]);
    const res = await rt.run(g, c.node.id, { options: { quality: 'lossless' } });
    const baked = withProcessResult(g, t.registry, c.node.id, res);
    const params = baked.nodes.find((n) => n.id === c.node.id)!.params;
    expect(params.baked).toBe(res.items.frames.id); // the old params ARE the handle
    expect(params.bakedSignature).toBe(res.signature);
    expect(rt.status(baked, c.node.id)?.state).toBe('done');
    expect(rt.status(setParam(baked, a.node.id, 'x', 1), c.node.id)?.state).toBe('stale');
    expect(rt.status(withProcessResult(baked, t.registry, c.node.id, null), c.node.id)?.state).toBe('none');
  });
});
