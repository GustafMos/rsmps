import { describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { harness } from '../engine/testing';
import type { AssetInfo, GraphDoc, Host, ImageValue } from '../engine/types';
import { BakeImpl, type BakeLibrary } from './bake';
import { EvalGate } from './gate';

/** A library without a browser: sequences are kept as raw bytes and served through Host.assetFrame. */
class FakeLibrary implements Host, BakeLibrary {
  assets = new Map<string, { info: AssetInfo & { owner?: string; hidden?: boolean; bake?: { width: number; height: number } }; raw: Uint8Array[] }>();
  exact = false;
  gpu!: import('../engine/gpu/gpu').Gpu;
  private n = 0;
  assetInfo(id: string): AssetInfo | null {
    return this.assets.get(id)?.info ?? null;
  }
  async assetFrame(id: string, seconds: number) {
    const a = this.assets.get(id);
    if (!a) return null;
    const i = Math.min(a.raw.length - 1, Math.max(0, Math.floor(seconds * a.info.fps + 1e-6)));
    const img = this.gpu.upload(a.raw[i], a.info.width, a.info.height, 1, false);
    this.gpu.retain(img.texture);
    return { texture: img.texture, width: a.info.width, height: a.info.height };
  }
  async attachSequence(owner: string, name: string, frames: Blob[], fps: number, meta?: Record<string, unknown>) {
    const existing = [...this.assets.values()].find((a) => a.info.owner === owner);
    const id = existing?.info.id ?? `seq${++this.n}`;
    const raw = await Promise.all(frames.map(async (b) => new Uint8Array(await b.arrayBuffer())));
    const bake = (meta as { bake: { width: number; height: number } }).bake;
    const info = { id, name, kind: 'video' as const, width: bake.width, height: bake.height, duration: frames.length / fps, fps, hasAudio: false, owner, hidden: true, ...(meta ?? {}) };
    this.assets.set(id, { info, raw });
    return info;
  }
  async removeOwned(owner: string) {
    for (const [id, a] of [...this.assets]) if (a.info.owner === owner) this.assets.delete(id);
  }
  list(opts?: { includeHidden?: boolean }) {
    return [...this.assets.values()].map((a) => a.info).filter((i) => opts?.includeHidden || !i.hidden);
  }
}

const FPS = 8;

async function setup() {
  let renders = 0;
  const lib = new FakeLibrary();
  const spy = defineNode({
    id: 'bake-spy',
    title: 'spy',
    category: 'generate',
    description: 'animated, counts renders',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      renders++;
      const v = ((ctx.time.frame % 8) / 8) * ctx.params.gain;
      return { image: ctx.gpu.pass({ size: { width: 12, height: 8, unit: 1 }, uniforms: { v }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, uv.x * 0.5, 0.25, 1.0); }' }) };
    },
  });
  const t = await harness([spy], lib);
  lib.gpu = t.gpu;
  const gate = new EvalGate(t.engine);
  const bake = new BakeImpl({
    engine: t.engine,
    gpu: t.gpu,
    registry: t.registry,
    gate,
    library: lib,
    activeProject: async () => 'proj1',
    encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]),
  });
  let g: GraphDoc = createGraph('bake');
  g = { ...g, project: { ...g.project, width: 12, height: 8, fps: FPS, duration: 1, loop: true } };
  const a = addNode(g, t.registry, 'bake-spy');
  const c = addNode(a.graph, t.registry, 'cache');
  g = connect(c.graph, t.registry, { node: a.node.id, port: 'image' }, { node: c.node.id, port: 'image' });
  return { t, lib, bake, g, src: a.node.id, cache: c.node.id, renders: () => renders };
}

function apply(g: GraphDoc, node: string, params: Record<string, string>): GraphDoc {
  let out = g;
  for (const [k, v] of Object.entries(params)) out = setParam(out, node, k, v);
  return out;
}

describe('Io.bake (headless, fake library)', () => {
  it('bakes the whole loop; the node then serves identical frames without evaluating upstream', async () => {
    const { t, lib, bake, g, src, cache, renders } = await setup();
    const progress: number[] = [];
    const res = await bake.bake(g, cache, { quality: 'lossless', onProgress: (p) => progress.push(p.frame) });
    expect(res.frames).toBe(FPS);
    expect(progress).toEqual(Array.from({ length: FPS }, (_, i) => i + 1));
    expect(res.bytes).toBe(FPS * 12 * 8 * 4);
    expect(res.itemDependent).toBe(false);
    expect(res.params.baked).toBe(res.assetId);
    expect(lib.exact).toBe(false); // restored after the bake
    expect(bake.info(cache)?.frames).toBe(FPS);
    expect(bake.info(cache)?.signature).toBe(res.signature);

    const baked = apply(g, cache, res.params);
    const before = renders();
    for (let i = 0; i < FPS; i++) {
      const live = await t.engine.evaluate({ graph: g, node: src, seconds: i / FPS });
      const afterLive = renders();
      const r = await t.engine.evaluate({ graph: baked, node: cache, seconds: i / FPS });
      expect(r.errors.size).toBe(0);
      expect(await t.diff(r.value as ImageValue, live.value as ImageValue)).toBe(0); // lossless: exact
      expect(renders()).toBe(afterLive); // the baked node rendered nothing upstream
    }
    expect(renders()).toBeGreaterThan(before); // (the live comparison renders did run)
    // fresh right after the bake
    expect((await t.engine.evaluate({ graph: baked, node: cache, port: 'stale', seconds: 0 })).value).toBe(0);
    // an edit before the node makes it stale
    const edited = setParam(baked, src, 'gain', 0.3);
    expect((await t.engine.evaluate({ graph: edited, node: cache, port: 'stale', seconds: 0 })).value).toBe(1);
  });

  it('cancels cleanly: nothing is stored', async () => {
    const { lib, bake, g, cache } = await setup();
    const ctl = new AbortController();
    await expect(bake.bake(g, cache, { quality: 'lossless', signal: ctl.signal, onProgress: (p) => p.frame === 2 && ctl.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(lib.assets.size).toBe(0);
    expect(bake.info(cache)).toBeNull();
  });

  it('re-baking replaces the sequence under the same asset; unbake and prune remove it', async () => {
    const { lib, bake, g, cache } = await setup();
    const a = await bake.bake(g, cache, { quality: 'lossless' });
    const b = await bake.bake(g, cache, { quality: 'lossless' });
    expect(b.assetId).toBe(a.assetId);
    expect(lib.assets.size).toBe(1);
    expect(await bake.prune('proj1', g)).toBe(0); // the node still exists
    const without = { ...g, nodes: g.nodes.filter((n) => n.id !== cache), edges: [] };
    expect(await bake.prune('proj1', without)).toBe(1);
    expect(lib.assets.size).toBe(0);
    await bake.bake(g, cache, { quality: 'lossless' });
    await bake.unbake(cache);
    expect(lib.assets.size).toBe(0);
  });

  it('refuses a node with nothing connected, and stops at the byte limit', async () => {
    const { t, bake, g, cache } = await setup();
    const bare = addNode(createGraph('x'), t.registry, 'cache');
    await expect(bake.bake(bare.graph, bare.node.id, { quality: 'lossless' })).rejects.toThrow(/Connect something/);
    await expect(bake.bake(g, cache, { quality: 'lossless', maxBytes: 100 })).rejects.toThrow(/over/);
  });
});
