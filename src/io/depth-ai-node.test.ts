/**
 * AI Depth node contract, on the real GPU with a RAM library and a FAKE inference service (no model, no ort):
 * stand-in before processing, stored depth served after, steady depth from a flickering model, staleness, `every` N interpolation,
 * still detection, the export gate and the sentences when there is no runtime or no model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { withProcessResult } from '../engine/process';
import { DEPTH_AI_MESSAGES, setDepthAiService, type DepthAiService } from '../engine/lib/depth-ai-bridge';
import { modelDims } from '../engine/lib/depth-ai-math';
import depthAi from '../engine/nodes/layers/depth-ai.node';
import depthSlice from '../engine/nodes/layers/depth-slice.node';
import lensBlur from '../engine/nodes/filter/lens-blur.node';
import imageToSplats from '../engine/nodes/generate/image-to-splats.node';
import imageTo3d from '../engine/nodes/generate/image-to-3d.node';
import { harness } from '../engine/testing';
import type { GraphDoc, Host, ImageValue, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const FPS = 12;
const FRAMES = 12;

interface Fake {
  calls: number;
  /** Per call: scale and shift the model "forgets" between frames (relative depth is affine-invariant). */
  flicker: boolean;
  ready: boolean;
}

function fakeService(f: Fake): DepthAiService {
  return {
    modelReady: async () => f.ready,
    open: async () => ({
      provider: 'fake',
      async infer(rgba, width, height, long) {
        const k = f.calls++;
        const d = modelDims(width, height, long);
        const data = new Float32Array(d.width * d.height);
        const frameNo = Math.round((rgba[0] / 255) * FRAMES); // the animated source encodes its frame in red
        const scale = f.flicker ? 1 + 0.6 * Math.sin(k * 2.1) : 1;
        const shift = f.flicker ? 0.8 * Math.cos(k * 1.3) : 0;
        for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) data[y * d.width + x] = (x / d.width + (x < d.width / 2 ? 0.02 * frameNo : 0)) * scale + shift;
        return { data, width: d.width, height: d.height };
      },
    }),
  };
}

async function setup(animated = true) {
  const lib = new MemoryProcessLibrary();
  const spy = defineNode({
    id: 'dai-src',
    title: 'src',
    category: 'generate',
    description: 'animated or still source',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      const v = animated ? (ctx.time.frame % FRAMES) / FRAMES : 0.5;
      return { image: ctx.gpu.pass({ size: { width: 28, height: 14, unit: 1 }, uniforms: { v, g: ctx.params.gain }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, uv.x * 0.5 * u.g, 0.25, 1.0); }' }) };
    },
  });
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: (id, s) => lib.assetFrame(id, s),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness([spy, depthAi], host);
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
  let g: GraphDoc = createGraph('dai');
  g = { ...g, project: { ...g.project, width: 28, height: 14, fps: FPS, duration: 1, loop: true } };
  const a = addNode(g, t.registry, 'dai-src');
  const d = addNode(a.graph, t.registry, 'depth-ai');
  g = connect(d.graph, t.registry, { node: a.node.id, port: 'image' }, { node: d.node.id, port: 'image' });
  const ids = { src: a.node.id, depth: d.node.id };
  const evalAt = (graph: GraphDoc, frame: number) => t.engine.evaluate({ graph, node: ids.depth, seconds: frame / FPS });
  /** Mean depth of the left half and the right half of the frame (0..1). */
  const halves = async (graph: GraphDoc, frame: number) => {
    const r = await evalAt(graph, frame);
    expect(r.errors.size).toBe(0);
    const img = r.value as ImageValue;
    const px = await t.pixels(img);
    let l = 0;
    let rr = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) (x < img.width / 2 ? (l += px.at(x, y)[0]) : (rr += px.at(x, y)[0]));
    }
    const n = (img.width / 2) * img.height;
    return { left: l / n / 255, right: rr / n / 255, img };
  };
  const process = async (graph: GraphDoc, opts?: { signal?: AbortSignal }) => withProcessResult(graph, t.registry, ids.depth, await rt.run(graph, ids.depth, opts));
  return { t, lib, rt, g, ids, evalAt, halves, process };
}

afterEach(() => setDepthAiService(null));

describe('AI Depth is a drop-in for Depth from Picture', () => {
  it('writes r = g = b = d in 0..1 with alpha 1 (white = near), rgba16float, and Lens Blur / Depth Slice / Picture to Splats / Image to 3D take it unchanged', async () => {
    setDepthAiService(fakeService({ calls: 0, flicker: false, ready: true }));
    const t0 = await setup();
    // a second harness with the consumers registered next to the node under test
    const lib = new MemoryProcessLibrary();
    const host: Host = { assetInfo: (id) => lib.assetInfo(id), assetFrame: (id, s) => lib.assetFrame(id, s), assetBytes: (id) => lib.assetBytes(id), processLive: (n): ProcessLive | null => rt.live(n) };
    const src = defineNode({ id: 'dai-src2', title: 'src2', category: 'generate', description: 'x', inputs: {}, outputs: { image: { type: 'image' } }, params: {}, render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 28, height: 14, unit: 1 }, uniforms: { v: (ctx.time.frame % FRAMES) / FRAMES }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, uv.x * 0.5, 0.25, 1.0); }' }) }) });
    const t = await harness([src, depthAi, depthSlice, lensBlur, imageToSplats, imageTo3d], host);
    lib.gpu = t.gpu;
    lib.onChange = () => t.engine.clear();
    const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host, encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]) });
    let g: GraphDoc = createGraph('dai2');
    g = { ...g, project: { ...g.project, width: 28, height: 14, fps: FPS, duration: 1, loop: true } };
    const a = addNode(g, t.registry, 'dai-src2');
    const d = addNode(a.graph, t.registry, 'depth-ai');
    g = connect(d.graph, t.registry, { node: a.node.id, port: 'image' }, { node: d.node.id, port: 'image' });
    const consumers: [string, string][] = [['lens-blur', 'depth'], ['depth-slice', 'depth'], ['image-to-splats', 'depth'], ['image-to-3d', 'depthMap']];
    const ids: string[] = [];
    for (const [type, port] of consumers) {
      const c = addNode(g, t.registry, type);
      g = connect(c.graph, t.registry, { node: a.node.id, port: 'image' }, { node: c.node.id, port: type === 'image-to-3d' ? 'image' : 'image' });
      g = connect(g, t.registry, { node: d.node.id, port: 'depth' }, { node: c.node.id, port });
      ids.push(c.node.id);
    }
    const done = withProcessResult(g, t.registry, d.node.id, await rt.run(g, d.node.id));
    for (const graph of [g, done]) {
      const r = await t.engine.evaluate({ graph, node: d.node.id, seconds: 0.25 });
      expect(r.errors.size).toBe(0);
      const img = r.value as ImageValue;
      const px = await t.pixels(img);
      for (const [x, y] of [[2, 2], [14, 7], [25, 12]]) {
        const [pr, pg, pb, pa] = px.at(x, y);
        expect(pg).toBe(pr);
        expect(pb).toBe(pr);
        expect(pa).toBe(255);
      }
      for (const id of ids) {
        const out = await t.engine.evaluate({ graph, node: id, seconds: 0.25 });
        expect(out.errors.size, `${id}: ${[...out.errors.values()].join('; ')}`).toBe(0);
      }
    }
    void t0;
  });
});

describe('AI Depth node', () => {
  it('shows the Depth from Picture stand-in until the job has run, and never needs the model for that', async () => {
    const fake: Fake = { calls: 0, flicker: false, ready: false };
    setDepthAiService(fakeService(fake));
    const { rt, g, evalAt, ids } = await setup();
    expect(rt.status(g, ids.depth)?.state).toBe('none');
    const r = await evalAt(g, 3);
    expect(r.errors.size).toBe(0);
    expect(r.value).toMatchObject({ kind: 'image', width: 28, height: 14 });
    expect(fake.calls).toBe(0); // rendering never touches the model
  });

  it('the job refuses with a clear sentence when there is no model runtime (command line) or no model file', async () => {
    const { rt, g, ids } = await setup();
    setDepthAiService(null);
    await expect(rt.run(g, ids.depth)).rejects.toThrow(DEPTH_AI_MESSAGES.noRuntime);
    setDepthAiService(fakeService({ calls: 0, flicker: false, ready: false }));
    await expect(rt.run(g, ids.depth)).rejects.toThrow(DEPTH_AI_MESSAGES.noModel);
    expect(rt.status(g, ids.depth)?.state).toBe('failed');
  });

  it('serves the stored depth (white = near, 16 bit) and keeps it steady although the model flickers frame to frame', async () => {
    const fake: Fake = { calls: 0, flicker: true, ready: true };
    setDepthAiService(fakeService(fake));
    const { rt, g, ids, halves, process } = await setup();
    const done = await process(g);
    expect(rt.status(done, ids.depth)?.state).toBe('done');
    expect(fake.calls).toBe(FRAMES);
    const meta = rt.status(done, ids.depth)?.result?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ w: 518, h: 266, k: FRAMES, every: 1, still: false, provider: 'fake' });
    const lefts: number[] = [];
    const rights: number[] = [];
    for (let f = 0; f < FRAMES; f++) {
      const h = await halves(done, f);
      lefts.push(h.left);
      rights.push(h.right);
      expect(h.right).toBeGreaterThan(h.left); // x / w ramp: the right is nearer, so whiter
    }
    // the raw model scale / shift swing by a factor of several; the stored depth moves little
    expect(Math.max(...rights) - Math.min(...rights)).toBeLessThan(0.1);
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(0.12);
  });

  it('is stale after params or the picture before it change, but not after display params', async () => {
    setDepthAiService(fakeService({ calls: 0, flicker: false, ready: true }));
    const { rt, g, ids, process } = await setup();
    const done = await process(g);
    expect(rt.status(setParam(done, ids.depth, 'invert', true), ids.depth)?.state).toBe('done');
    expect(rt.status(setParam(done, ids.depth, 'nearLevel', 0.8), ids.depth)?.state).toBe('done');
    expect(rt.status(setParam(done, ids.depth, 'size', '392'), ids.depth)?.state).toBe('stale');
    expect(rt.status(setParam(done, ids.depth, 'every', 2), ids.depth)?.state).toBe('stale');
    expect(rt.status(setParam(done, ids.depth, 'temporal', 0), ids.depth)?.state).toBe('stale');
    expect(rt.status(setParam(done, ids.src, 'gain', 0.5), ids.depth)?.state).toBe('stale');
  });

  it('invert and levels act on the stored depth without running the model again', async () => {
    const fake: Fake = { calls: 0, flicker: false, ready: true };
    setDepthAiService(fakeService(fake));
    const { g, ids, halves, process } = await setup();
    const done = await process(g);
    const calls = fake.calls;
    const a = await halves(done, 2);
    const b = await halves(setParam(done, ids.depth, 'invert', true), 2);
    expect(b.right).toBeLessThan(b.left);
    expect(b.right).toBeCloseTo(1 - a.right, 1);
    expect(fake.calls).toBe(calls);
  });

  it('Every N frames runs the model on a fraction of the frames and blends the frames in between', async () => {
    const fake: Fake = { calls: 0, flicker: false, ready: true };
    setDepthAiService(fakeService(fake));
    const { rt, g, ids, halves, process } = await setup();
    const done = await process(setParam(g, ids.depth, 'every', 3));
    expect(fake.calls).toBe(4); // frames 0, 3, 6, 9
    expect(rt.status(done, ids.depth)?.result?.meta).toMatchObject({ k: 4, every: 3, frames: FRAMES });
    const l0 = (await halves(done, 0)).left;
    const l1 = (await halves(done, 1)).left;
    const l3 = (await halves(done, 3)).left;
    expect(l3).not.toBeCloseTo(l0, 3);
    // frame 1 is a third of the way from the stored frame 0 to the stored frame 3
    expect(l1).toBeCloseTo(l0 + (l3 - l0) / 3, 2);
    // the tail of a looping clip blends towards the start
    const l11 = (await halves(done, 11)).left;
    expect(Number.isFinite(l11)).toBe(true);
  });

  it('a still picture costs one model run and is served for every frame', async () => {
    const fake: Fake = { calls: 0, flicker: false, ready: true };
    setDepthAiService(fakeService(fake));
    const { rt, g, ids, halves, process } = await setup(false);
    const done = await process(g);
    expect(fake.calls).toBe(1);
    expect(rt.status(done, ids.depth)?.result?.meta).toMatchObject({ still: true, k: 1 });
    const a = await halves(done, 0);
    const b = await halves(done, 7);
    expect(b.left).toBeCloseTo(a.left, 5);
  });

  it('export gate: never run = the stand-in is fine; run once and then outdated = pending, so no silent stand-in', async () => {
    setDepthAiService(fakeService({ calls: 0, flicker: false, ready: true }));
    const { rt, g, ids, process } = await setup();
    expect(rt.pending(g, [ids.depth])).toEqual([]);
    const done = await process(g);
    expect(rt.pending(done, [ids.depth])).toEqual([]);
    expect(rt.pending(setParam(done, ids.depth, 'size', '392'), [ids.depth])).toMatchObject([{ node: ids.depth, type: 'depth-ai', state: 'stale' }]);
  });

  it('cancel stores nothing', async () => {
    const fake: Fake = { calls: 0, flicker: false, ready: true };
    const svc = fakeService(fake);
    const ctl = new AbortController();
    setDepthAiService({
      modelReady: svc.modelReady,
      open: async (s) => {
        const e = await svc.open(s);
        return { ...e, infer: async (...a) => (fake.calls === 3 && ctl.abort(), e.infer(...a)) };
      },
    });
    const { lib, rt, g, ids } = await setup();
    await expect(rt.run(g, ids.depth, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(lib.assets.size).toBe(0);
    expect(rt.status(g, ids.depth)?.state).toBe('none');
  });
});
