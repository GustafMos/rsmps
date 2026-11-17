/** Batch Palette: one palette for a set of sprites, made by a process job and served for every batch item. */
import { describe, expect, it } from 'vitest';
import { addNode, createGraph } from '../engine/graph';
import { withProcessResult } from '../engine/process';
import { srgbToOklab, type Rgb } from '../engine/lib/pixel-color';
import { harness } from '../engine/testing';
import type { AssetInfo, Host, ImageValue, PaletteValue, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const SPRITES: Record<string, [number, number, number, number][]> = {
  'a.png': [[200, 30, 30, 255], [90, 10, 10, 255]],
  'b.png': [[30, 40, 220, 255], [10, 15, 100, 255]],
  'c.png': [[40, 200, 60, 255], [12, 80, 20, 255]],
};

const dist = (a: Rgb, b: Rgb) => {
  const [x, y] = [srgbToOklab(a), srgbToOklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

async function setup() {
  const lib = new MemoryProcessLibrary();
  const files = new Map<string, ImageValue>();
  const host: Host = {
    assetInfo: (id): AssetInfo | null => (files.has(id) ? { id, name: id, kind: 'image', width: 8, height: 8, duration: 0, fps: 0, hasAudio: false } : lib.assetInfo(id)),
    assetFrame: async (id, s) => (files.get(id) ? { texture: files.get(id)!.texture, width: 8, height: 8 } : lib.assetFrame(id, s)),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness([], host);
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
  for (const [name, [c1, c2]] of Object.entries(SPRITES)) files.set(name, t.fromFn(8, 8, (x) => (x < 4 ? c1 : c2)));
  return { t, rt, files };
}

describe('batch-palette', () => {
  it('covers the colors of every sprite after the job, and serves the same palette for every item', async () => {
    const { t, rt } = await setup();
    let g = createGraph('bp');
    const node = addNode(g, t.registry, 'batch-palette', { x: 0, y: 0 }, { source: 'files', sprites: Object.keys(SPRITES), count: 8 });
    g = node.graph;
    const id = node.node.id;

    // Before the job: the palette of the current item alone.
    const first = (await t.engine.evaluate({ graph: g, node: id, port: 'palette', item: 0, itemCount: 3 })).value as PaletteValue;
    expect(first.colors.some((c) => dist(c, [0.78, 0.12, 0.12]) < 0.05)).toBe(true);
    expect(first.colors.some((c) => dist(c, [0.12, 0.16, 0.86]) < 0.05)).toBe(false);
    const second = (await t.engine.evaluate({ graph: g, node: id, port: 'palette', item: 1, itemCount: 3 })).value as PaletteValue;
    expect(second.colors.some((c) => dist(c, [0.12, 0.16, 0.86]) < 0.05)).toBe(true);

    const done = withProcessResult(g, t.registry, id, await rt.run(g, id));
    expect(rt.status(done, id)?.state).toBe('done');
    for (const item of [0, 1, 2]) {
      const pal = (await t.engine.evaluate({ graph: done, node: id, port: 'palette', item, itemCount: 3 })).value as PaletteValue;
      for (const sprite of Object.values(SPRITES)) {
        for (const c of sprite) expect(pal.colors.some((p) => dist(p, [c[0] / 255, c[1] / 255, c[2] / 255]) < 0.04), `item ${item}: ${c}`).toBe(true);
      }
    }
    // changing what it reads makes the result stale (it is not silently re-used)
    const changed = { ...done, nodes: done.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, count: 4 } } : n)) };
    expect(rt.status(changed, id)?.state).toBe('stale');
  });

  it('a clip: samples frames of the wired picture across the project', async () => {
    const { t, rt } = await setup();
    // an animated source: the colour changes with the frame, so the palette must contain colors from different moments
    const { defineNode } = await import('../engine/define');
    const anim = defineNode({
      id: 'bp-anim',
      title: 'anim',
      category: 'generate',
      description: 'test',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render: (ctx) => ({ image: ctx.gpu.pass({ size: { width: 8, height: 8, unit: 1 }, uniforms: { f: ctx.time.frame }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(select(1.0, 0.0, u.f < 6.0), select(0.0, 1.0, u.f < 6.0), 0.0, 1.0); }' }) }),
    });
    t.registry.register(anim);
    let g = createGraph('bp2');
    g = { ...g, project: { ...g.project, width: 8, height: 8, fps: 12, duration: 1, loop: true } };
    const a = addNode(g, t.registry, 'bp-anim');
    const n = addNode(a.graph, t.registry, 'batch-palette', { x: 0, y: 0 }, { source: 'clip', samples: 6, count: 4 });
    const { connect } = await import('../engine/graph');
    g = connect(n.graph, t.registry, { node: a.node.id, port: 'image' }, { node: n.node.id, port: 'image' });
    const done = withProcessResult(g, t.registry, n.node.id, await rt.run(g, n.node.id));
    const pal = (await t.engine.evaluate({ graph: done, node: n.node.id, port: 'palette' })).value as PaletteValue;
    expect(pal.colors.some((c) => dist(c, [1, 0, 0]) < 0.05)).toBe(true);
    expect(pal.colors.some((c) => dist(c, [0, 1, 0]) < 0.05)).toBe(true);
  });

  it('every batch item: the wired chain is evaluated for ALL items, effects included (ProcessCtx.pull with item)', async () => {
    const { t, rt } = await setup();
    const { defineNode } = await import('../engine/define');
    const { batchCount, connect } = await import('../engine/graph');
    // a source whose colour is the batch item (like a Media In with three files), so only a pull by item can see all of them
    const COLORS: [number, number, number, number][] = [[200, 30, 30, 255], [30, 40, 220, 255], [40, 200, 60, 255]];
    t.registry.register(
      defineNode({
        id: 'bp-per-item',
        title: 'per item',
        category: 'input',
        description: 'test',
        inputs: {},
        outputs: { image: { type: 'image' } },
        params: { assets: { type: 'assets', default: [], accept: 'image-video' } },
        render: (ctx) => ({ image: ctx.gpu.upload(new Uint8ClampedArray(Array.from({ length: 16 }, () => COLORS[ctx.item.index]).flat()), 4, 4, 1, true) }),
      }),
    );
    let g = createGraph('bp3');
    g = { ...g, project: { ...g.project, width: 4, height: 4, fps: 10, duration: 0.5, loop: true } };
    const src = addNode(g, t.registry, 'bp-per-item', { x: 0, y: 0 }, { assets: ['x', 'y', 'z'] });
    const inv = addNode(src.graph, t.registry, 'invert');
    const bp = addNode(inv.graph, t.registry, 'batch-palette', { x: 0, y: 0 }, { source: 'items', samples: 2, count: 8 });
    g = connect(bp.graph, t.registry, { node: src.node.id, port: 'image' }, { node: inv.node.id, port: 'image' });
    g = connect(g, t.registry, { node: inv.node.id, port: 'image' }, { node: bp.node.id, port: 'image' });
    expect(batchCount(g, t.registry)).toBe(3);
    const id = bp.node.id;
    const inverted = COLORS.map((c): Rgb => [(255 - c[0]) / 255, (255 - c[1]) / 255, (255 - c[2]) / 255]);
    const has = (pal: PaletteValue, c: Rgb) => pal.colors.some((p) => dist(p, c) < 0.05);

    // before the job: only the current item
    const before = (await t.engine.evaluate({ graph: g, node: id, port: 'palette', item: 1, itemCount: 3 })).value as PaletteValue;
    expect(has(before, inverted[1])).toBe(true);
    expect(has(before, inverted[0])).toBe(false);

    const result = await rt.run(g, id, { item: 2 }); // run "for item 2": the result still covers every item
    const done = withProcessResult(g, t.registry, id, result);
    expect(result.meta.pictures).toBe(6); // 3 items x 2 moments
    for (const item of [0, 1, 2]) {
      const pal = (await t.engine.evaluate({ graph: done, node: id, port: 'palette', item, itemCount: 3 })).value as PaletteValue;
      for (const c of inverted) expect(has(pal, c), `item ${item}`).toBe(true);
      expect(has(pal, [200 / 255, 30 / 255, 30 / 255])).toBe(false); // the colours AFTER the effect, not the source's
    }
    // the stored palette depends on the upstream chain: editing the effect makes it stale
    const edited = { ...done, nodes: done.nodes.map((n) => (n.id === inv.node.id ? { ...n, params: { ...n.params, amount: 0.5 } } : n)) };
    expect(rt.status(edited, id)?.state).toBe('stale');
  });
});
