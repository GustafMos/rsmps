import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/engine';
import { addNode, connect, createGraph } from '../engine/graph';
import { harness } from '../engine/testing';
import type { ImageValue } from '../engine/types';
import { ExporterImpl } from './exporter';
import { EvalGate } from './gate';

/** Exporter.renderFrame (conform + enlarge) on an animated graph with a tiny engine cache: every frame must be right and memory must plateau. */
describe('export frame path', () => {
  async function setup() {
    const t = await harness();
    let g = createGraph('mem');
    g.project = { ...g.project, width: 64, height: 36, fps: 10, duration: 1.2, loop: true };
    const noise = addNode(g, t.registry, 'noise', { x: 0, y: 0 }, { evolution: 3, scale: 20 });
    const blur = addNode(noise.graph, t.registry, 'blur', { x: 0, y: 0 }, { radius: 3 });
    const adj = addNode(blur.graph, t.registry, 'color-adjust', { x: 0, y: 0 }, { contrast: 1.4 });
    // Portrait frame + pixel size: the exporter conforms (fill) and enlarges every frame.
    const out = addNode(adj.graph, t.registry, 'image-out', { x: 0, y: 0 }, { kind: 'sequence', frame: 'project', orientation: 'portrait', conform: 'fill', pixelSize: 2 });
    g = out.graph;
    g = connect(g, t.registry, { node: noise.node.id, port: 'image' }, { node: blur.node.id, port: 'image' });
    g = connect(g, t.registry, { node: blur.node.id, port: 'image' }, { node: adj.node.id, port: 'image' });
    g = connect(g, t.registry, { node: adj.node.id, port: 'image' }, { node: out.node.id, port: 'image' });
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    engine.cacheBudget = 64 * 1024; // every evaluation evicts and recycles pooled textures
    const gate = new EvalGate(engine);
    const exporter = new ExporterImpl({ gpu: t.gpu, gate, registry: t.registry } as never) as unknown as {
      renderFrame(job: unknown, run: unknown, frame: number): Promise<ImageValue>;
      releaseConformed(): void;
    };
    const job = { out: g.nodes.find((n) => n.id === out.node.id)!, item: 0, itemCount: 1, artMode: false };
    const run = { req: { graph: g } };
    return { t, g, engine, exporter, job, run, outId: out.node.id };
  }

  it('renders every frame correctly and does not grow GPU memory', async () => {
    const { t, g, exporter, job, run, outId } = await setup();
    // References from a fresh engine per frame, passed through the same conform/enlarge path.
    const refExporter = new ExporterImpl({ gpu: t.gpu, gate: new EvalGate(new Engine(t.gpu, t.registry, t.engine.host)), registry: t.registry } as never) as unknown as typeof exporter;
    const frames = 60;
    const reference: Uint8ClampedArray[] = [];
    for (let f = 0; f < 12; f++) {
      const img = await refExporter.renderFrame({ ...job, out: g.nodes.find((n) => n.id === outId)! }, run, f);
      reference.push(await t.gpu.read(img, false));
    }
    refExporter.releaseConformed();

    const allocated: number[] = [];
    for (let f = 0; f < frames; f++) {
      const img = await exporter.renderFrame(job, run, f);
      expect([img.width, img.height]).toEqual([36, 64]);
      const px = await t.gpu.read(img, false);
      const want = reference[f % 12];
      let diff = 0;
      for (let i = 0; i < px.length; i++) diff += Math.abs(px[i] - want[i]);
      expect(diff / px.length, `frame ${f}`).toBeLessThan(0.5);
      allocated.push(t.gpu.stats().allocatedBytes);
    }
    exporter.releaseConformed();
    // After warm-up (about 13 frames) nothing may be allocated any more.
    expect(allocated[allocated.length - 1]).toBe(allocated[20]);
    expect(t.gpu.stats().rootScope).toBeLessThanOrEqual(2);
  });
});

describe('Gpu.scoped ownership', () => {
  it('recycles unretained temporaries, keeps retained ones, and reports stats', async () => {
    const t = await harness();
    const gpu = t.gpu;
    const before = gpu.stats();
    let kept!: GPUTexture;
    gpu.scoped(() => {
      gpu.pass({ size: { width: 33, height: 17 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }' });
      const keep = gpu.pass({ size: { width: 33, height: 19 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }' });
      gpu.retain(keep.texture);
      kept = keep.texture;
    });
    const during = gpu.stats();
    expect(during.idleTextures - before.idleTextures).toBe(1); // the unretained 33x17 went back to the pool
    expect(during.retainedTextures - before.retainedTextures).toBe(1);
    expect(during.rootScope).toBe(before.rootScope);
    gpu.release(kept);
    expect(gpu.stats().idleTextures - before.idleTextures).toBe(2);
    // The pool serves the recycled texture again: no new allocation.
    const bytes = gpu.stats().allocatedBytes;
    gpu.scoped(() => gpu.pass({ size: { width: 33, height: 17 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' }));
    expect(gpu.stats().allocatedBytes).toBe(bytes);
  });

  it('a retained texture that is released later does not linger in the root scope', async () => {
    const t = await harness();
    const gpu = t.gpu;
    const root0 = gpu.stats().rootScope;
    const img = gpu.pass({ size: { width: 8, height: 8 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }' }); // root scope
    expect(gpu.stats().rootScope).toBe(root0 + 1);
    gpu.retain(img.texture);
    expect(gpu.stats().rootScope).toBe(root0);
    gpu.release(img.texture);
    expect(gpu.stats().rootScope).toBe(root0);
  });

  it('read() of a non-rgba8 image does not leak its conversion texture', async () => {
    const t = await harness();
    const gpu = t.gpu;
    const hdr = gpu.alloc(8, 8, 1, 'rgba16float');
    gpu.retain(hdr.texture);
    const root0 = gpu.stats().rootScope;
    await gpu.read(hdr, false);
    expect(gpu.stats().rootScope).toBe(root0);
    gpu.release(hdr.texture);
  });
});

describe('trim()', () => {
  it('never hands a destroyed texture out again, even when an open scope still names it', async () => {
    const t = await harness();
    const gpu = t.gpu;
    gpu.begin();
    const img = gpu.pass({ size: { width: 21, height: 13 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }' });
    gpu.retain(img.texture);
    gpu.release(img.texture); // back in the pool, still listed in the open scope
    gpu.trim(); // destroys it
    gpu.end(); // used to put the destroyed texture back into the pool
    const again = gpu.pass({ size: { width: 21, height: 13 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.5); }' });
    expect(again.texture).not.toBe(img.texture);
    const px = await gpu.read(again, false);
    expect(px[0]).toBeGreaterThan(100);
    gpu.release(again.texture);
  });
});
