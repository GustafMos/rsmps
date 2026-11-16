import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { addNode, connect, createGraph, setParam } from '../../graph';
import { harness } from '../../testing';
import type { AssetInfo, GraphDoc, Host, ImageValue } from '../../types';

/**
 * Cache / Bake: pass-through unbaked; baked, the upstream is never evaluated; a graph edit upstream makes it stale but the baked
 * picture keeps being served (until `followEdits`); other times can still be pulled from it.
 */
const FPS = 10;
const FRAMES = 6;

function setup() {
  const stored = new Map<string, ImageValue[]>();
  let sourceRenders = 0;
  const host: Host = {
    assetInfo: (id): AssetInfo | null => {
      const frames = stored.get(id);
      if (!frames) return null;
      return { id, name: id, kind: 'video', width: frames[0].width, height: frames[0].height, duration: frames.length / FPS, fps: FPS, hasAudio: false };
    },
    assetFrame: async (id, seconds) => {
      const frames = stored.get(id);
      if (!frames) return null;
      const i = Math.min(frames.length - 1, Math.max(0, Math.floor(seconds * FPS + 1e-6)));
      return { texture: frames[i].texture, width: frames[i].width, height: frames[i].height };
    },
  };
  const spy = defineNode({
    id: 'spy-anim',
    title: 'spy',
    category: 'generate',
    description: 'counts renders; colour depends on the frame',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      sourceRenders++;
      const v = ((ctx.time.frame % FRAMES) / FRAMES) * ctx.params.gain;
      return { image: ctx.gpu.pass({ label: 'spy', size: { width: 16, height: 16, unit: 1 }, uniforms: { v }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, u.v * 0.5, 0.2, 1.0); }' }) };
    },
  });
  return { stored, host, spy, renders: () => sourceRenders };
}

function build(t: Awaited<ReturnType<typeof harness>>) {
  let g: GraphDoc = createGraph('t');
  g = { ...g, project: { ...g.project, fps: FPS, duration: FRAMES / FPS, width: 16, height: 16 } };
  const a = addNode(g, t.registry, 'spy-anim');
  const c = addNode(a.graph, t.registry, 'cache');
  g = connect(c.graph, t.registry, { node: a.node.id, port: 'image' }, { node: c.node.id, port: 'image' });
  return { g, src: a.node.id, cache: c.node.id };
}

async function bakeFrames(t: Awaited<ReturnType<typeof harness>>, g: GraphDoc, src: string, stored: Map<string, ImageValue[]>, id: string) {
  const frames: ImageValue[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const r = await t.engine.evaluate({ graph: g, node: src, seconds: i / FPS });
    const v = r.value as ImageValue;
    const px = await t.gpu.read(v, false);
    const copy = t.gpu.upload(px, v.width, v.height, v.unit, false);
    t.gpu.retain(copy.texture);
    frames.push(copy);
  }
  stored.set(id, frames);
}

describe('cache node', () => {
  it('is a transparent pass-through while unbaked', async () => {
    const s = setup();
    const t = await harness([s.spy], s.host);
    const { g, src, cache } = build(t);
    const live = (await t.engine.evaluate({ graph: g, node: src, seconds: 0.3 })).value as ImageValue;
    const r = await t.engine.evaluate({ graph: g, node: cache, seconds: 0.3 });
    expect(r.errors.size).toBe(0);
    expect(await t.diff(r.value as ImageValue, live)).toBe(0);
    const stale = await t.engine.evaluate({ graph: g, node: cache, port: 'stale', seconds: 0.3 });
    expect(stale.value).toBe(0);
  });

  it('baked: the upstream is not evaluated at all, and the picture is the baked one', async () => {
    const s = setup();
    const t = await harness([s.spy], s.host);
    const { g, src, cache } = build(t);
    await bakeFrames(t, g, src, s.stored, 'baked-1');
    const sig = t.engine.signatureOf(g, src, 'image');
    let baked = setParam(g, cache, 'baked', 'baked-1');
    baked = setParam(baked, cache, 'bakedSignature', sig);
    const before = s.renders();
    for (let i = 0; i < FRAMES; i++) {
      const r = await t.engine.evaluate({ graph: baked, node: cache, seconds: i / FPS });
      expect(r.errors.size).toBe(0);
      expect(await t.diff(r.value as ImageValue, s.stored.get('baked-1')![i])).toBe(0);
    }
    expect(s.renders() - before).toBe(0); // the spy upstream was never rendered
    const stale = await t.engine.evaluate({ graph: baked, node: cache, port: 'stale', seconds: 0 });
    expect(stale.value).toBe(0);
  });

  it('detects an upstream edit as stale, keeps serving the bake, and goes live with followEdits', async () => {
    const s = setup();
    const t = await harness([s.spy], s.host);
    const { g, src, cache } = build(t);
    await bakeFrames(t, g, src, s.stored, 'baked-2');
    let baked = setParam(g, cache, 'baked', 'baked-2');
    baked = setParam(baked, cache, 'bakedSignature', t.engine.signatureOf(g, src, 'image'));
    const edited = setParam(baked, src, 'gain', 0.5);
    const before = s.renders();
    const r = await t.engine.evaluate({ graph: edited, node: cache, seconds: 0.2 });
    expect(await t.diff(r.value as ImageValue, s.stored.get('baked-2')![2])).toBe(0); // still the baked frame
    expect((await t.engine.evaluate({ graph: edited, node: cache, port: 'stale', seconds: 0.2 })).value).toBe(1);
    expect(s.renders() - before).toBe(0);
    const follow = setParam(edited, cache, 'followEdits', true);
    const live = await t.engine.evaluate({ graph: follow, node: cache, seconds: 0.2 });
    expect(s.renders() - before).toBeGreaterThan(0);
    expect(await t.diff(live.value as ImageValue, s.stored.get('baked-2')![2])).toBeGreaterThan(1); // gain 0.5 differs from the baked gain 1
    // 'always live' ignores a fresh bake as well
    const alwaysLive = setParam(baked, cache, 'mode', 'live');
    const n = s.renders();
    await t.engine.evaluate({ graph: alwaysLive, node: cache, seconds: 0.4 });
    expect(s.renders()).toBeGreaterThan(n);
  });

  it('other times can still be pulled from a baked node (time offset downstream)', async () => {
    const s = setup();
    const t = await harness([s.spy], s.host);
    const { g, src, cache } = build(t);
    await bakeFrames(t, g, src, s.stored, 'baked-3');
    let baked = setParam(g, cache, 'baked', 'baked-3');
    baked = setParam(baked, cache, 'bakedSignature', t.engine.signatureOf(g, src, 'image'));
    const off = addNode(baked, t.registry, 'time-offset', { x: 0, y: 0 }, { offset: 0.3 });
    const wired = connect(off.graph, t.registry, { node: cache, port: 'image' }, { node: off.node.id, port: 'image' });
    const before = s.renders();
    const r = await t.engine.evaluate({ graph: wired, node: off.node.id, seconds: 0 });
    expect(r.errors.size).toBe(0);
    expect(await t.diff(r.value as ImageValue, s.stored.get('baked-3')![3])).toBe(0);
    expect(s.renders() - before).toBe(0);
  });

  it('a bake of one batch item is served for that item only', async () => {
    const s = setup();
    const t = await harness([s.spy], s.host);
    const { g, src, cache } = build(t);
    await bakeFrames(t, g, src, s.stored, 'baked-4');
    let baked = setParam(g, cache, 'baked', 'baked-4');
    baked = setParam(baked, cache, 'bakedSignature', t.engine.signatureOf(g, src, 'image'));
    baked = setParam(baked, cache, 'bakedItem', '1');
    const before = s.renders();
    await t.engine.evaluate({ graph: baked, node: cache, seconds: 0.1, item: 1, itemCount: 2 });
    expect(s.renders() - before).toBe(0);
    await t.engine.evaluate({ graph: baked, node: cache, seconds: 0.1, item: 0, itemCount: 2 });
    expect(s.renders() - before).toBeGreaterThan(0); // item 0 was not baked: live
  });

  it('a static upstream stays cacheable through the pass-through (no render per frame)', async () => {
    const s = setup();
    let renders = 0;
    const still = defineNode({
      id: 'spy-still',
      title: 'still',
      category: 'generate',
      description: 'static',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render: (ctx) => {
        renders++;
        return { image: ctx.gpu.pass({ size: { width: 8, height: 8 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.5, 0.5, 0.5, 1.0); }' }) };
      },
    });
    const t = await harness([s.spy, still], s.host);
    let g = createGraph('t');
    const a = addNode(g, t.registry, 'spy-still');
    const c = addNode(a.graph, t.registry, 'cache');
    g = connect(c.graph, t.registry, { node: a.node.id, port: 'image' }, { node: c.node.id, port: 'image' });
    for (const sec of [0, 0.1, 0.2, 0.3]) await t.engine.evaluate({ graph: g, node: c.node.id, seconds: sec });
    expect(renders).toBe(1);
  });
});
