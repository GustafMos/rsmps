import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { addNode, connect, createGraph } from '../graph';
import { harness } from '../testing';
import type { ColdStore, ImageValue } from '../types';

describe('GPU memory regressions', () => {
  it('300 frames of an animated chain leave GPU object counts and bytes flat after warm-up', async () => {
    const t = await harness();
    let g = createGraph();
    g.project = { ...g.project, width: 96, height: 96, fps: 25, duration: 12, loop: true };
    const R = t.registry;
    const ids: string[] = [];
    const chain = ['noise', 'blur', 'bloom', 'pixelate', 'dither', 'crt-display', 'pixel-sort'];
    const params: Record<string, Record<string, unknown>> = { noise: { evolution: 3, scale: 30 }, blur: { radius: 5 }, dither: { algorithm: 'floyd-steinberg' } };
    for (const type of chain) {
      const r = addNode(g, R, type, { x: 0, y: 0 }, params[type] ?? {});
      g = r.graph;
      ids.push(r.node.id);
    }
    for (let i = 1; i < ids.length; i++) g = connect(g, R, { node: ids[i - 1], port: 'image' }, { node: ids[i], port: 'image' });
    // A second branch with a 3D object, merged in, so a generator and a compute-heavy node are both in the loop.
    const obj = addNode(g, R, 'object-3d', { x: 0, y: 0 }, { spinY: 1 });
    const stack = addNode(obj.graph, R, 'stack');
    g = stack.graph;
    g = connect(g, R, { node: ids[ids.length - 1], port: 'image' }, { node: stack.node.id, port: 'images' });
    g = connect(g, R, { node: obj.node.id, port: 'image' }, { node: stack.node.id, port: 'images' });

    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    const snap = () => {
      const s = t.gpu.stats();
      return {
        total: s.totalBytes,
        liveTextures: s.objects.liveTextures,
        liveBuffers: s.objects.liveBuffers,
        texturesCreated: s.objects.texturesCreated,
        buffersCreated: s.objects.buffersCreated,
        pipelinesCreated: s.objects.pipelinesCreated,
        livePipelines: s.objects.livePipelines,
        viewsCreated: s.objects.viewsCreated,
        liveBindGroups: s.objects.liveBindGroups,
        rootScope: s.rootScope,
      };
    };
    let warm = snap();
    for (let f = 0; f < 300; f++) {
      const r = await engine.evaluate({ graph: g, node: stack.node.id, seconds: f / 25 });
      expect(r.errors.size).toBe(0);
      if (f === 40) warm = snap();
    }
    const end = snap();
    expect(end.total).toBeLessThanOrEqual(warm.total);
    expect(end.liveTextures).toBeLessThanOrEqual(warm.liveTextures);
    expect(end.liveBuffers).toBeLessThanOrEqual(warm.liveBuffers);
    // nothing new was created at all in the last 260 frames
    expect(end.texturesCreated).toBe(warm.texturesCreated);
    expect(end.buffersCreated).toBe(warm.buffersCreated);
    expect(end.pipelinesCreated).toBe(warm.pipelinesCreated);
    expect(end.viewsCreated).toBe(warm.viewsCreated);
    expect(end.liveBindGroups).toBeLessThanOrEqual(t.gpu.limits.bindGroups);
    expect(end.rootScope).toBeLessThanOrEqual(2);
    engine.clear();
  }, 300_000);

  it('a pass creates no buffer, no view and (once warm) no bind group', async () => {
    const t = await harness();
    const gpu = t.gpu;
    const src = t.checker(32, 32);
    const run = (i: number) =>
      gpu.scoped(() => {
        const a = gpu.pass({ label: 'churn-a', size: { width: 32, height: 32 }, textures: { src }, uniforms: { k: i % 7, tint: [1, 0.5, 0.2] }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0) * u.k * u.tint.x; }' });
        gpu.pass({ label: 'churn-b', size: { width: 32, height: 32 }, textures: { src: a }, uniforms: { k: i }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0) * u.k; }' });
      });
    for (let i = 0; i < 20; i++) run(i); // warm-up
    const before = gpu.stats();
    for (let i = 0; i < 500; i++) run(i);
    const after = gpu.stats();
    expect(after.objects.buffersCreated - before.objects.buffersCreated).toBe(0);
    expect(after.objects.viewsCreated - before.objects.viewsCreated).toBe(0);
    expect(after.objects.texturesCreated - before.objects.texturesCreated).toBe(0);
    expect(after.objects.bindGroupsCreated - before.objects.bindGroupsCreated).toBe(0);
    expect(after.objects.submits - before.objects.submits).toBe(1000);
    expect(after.categories['uniform-buffer'].count).toBeLessThanOrEqual(2); // one pooled buffer per size bucket, not one per pass
  });

  it('every object is counted: no file outside gpu.ts creates a raw buffer or texture on the device', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name === 'node_modules' || name === '__tests__') continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !p.replace(/\\/g, '/').endsWith('engine/gpu/gpu.ts')) {
          const text = readFileSync(p, 'utf8');
          if (/\bdevice\.create(Buffer|Texture)\(|\.device\.create(Buffer|Texture)\(/.test(text)) offenders.push(p);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });

  it('scratch buffers are reused, zeroed on request, and counted', async () => {
    const t = await harness();
    const gpu = t.gpu;
    const a = gpu.scratch(1000, GPUBufferUsage.STORAGE, 'a');
    gpu.device.queue.writeBuffer(a, 0, new Uint32Array(250).fill(7));
    gpu.releaseScratch(a);
    const b = gpu.scratch(1000, GPUBufferUsage.STORAGE, 'b', { clear: true });
    expect(b).toBe(a); // same buffer back
    const rb = gpu.scratch(1024, GPUBufferUsage.MAP_READ, 'rb');
    const enc = gpu.device.createCommandEncoder();
    enc.copyBufferToBuffer(b, 0, rb, 0, 1024);
    gpu.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    expect(data.every((x) => x === 0)).toBe(true);
    gpu.releaseScratch(b);
    gpu.releaseScratch(rb);
    gpu.trim();
    expect(gpu.stats().categories['scratch-buffer'].count).toBe(0);
  });

  it('the pool keeps at most the configured idle bytes and sizes, least recently used first', async () => {
    const t = await harness();
    const gpu = t.gpu;
    gpu.trim();
    const saved = { ...gpu.limits };
    gpu.limits.idleBytes = 4 * 64 * 64 * 4;
    gpu.limits.idleSizes = 3;
    try {
      for (let i = 0; i < 6; i++) gpu.scoped(() => gpu.alloc(60 + i, 64, 1));
      gpu.advance();
      const s = gpu.stats();
      expect(s.idleSizes).toBeLessThanOrEqual(3);
      expect(s.idleBytes).toBeLessThanOrEqual(gpu.limits.idleBytes);
    } finally {
      Object.assign(gpu.limits, saved);
    }
  });
});

/** An in-memory ColdStore that records what happened. */
function memoryStore(): ColdStore & { gets: number; puts: number; map: Map<string, { data: Uint8Array; width: number; height: number }> } {
  const map = new Map<string, { data: Uint8Array; width: number; height: number }>();
  return {
    map,
    gets: 0,
    puts: 0,
    async put(key, px) {
      this.puts++;
      map.set(key, { data: px.data.slice(), width: px.width, height: px.height });
      return true;
    },
    async get(key) {
      this.gets++;
      const v = map.get(key);
      return v ? { data: v.data.slice(), width: v.width, height: v.height } : null;
    },
    delete(key) {
      map.delete(key);
    },
    has: (key) => map.has(key),
  };
}

describe('RAM tier (cold store)', () => {
  it('an expensive result evicted from the GPU cache comes back exactly from RAM, without re-rendering', async () => {
    const t = await harness();
    let renders = 0;
    t.registry.register({
      id: 'slow-gen',
      title: 'slow',
      category: 'generate',
      description: 'pretends to be expensive',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: { seed: { type: 'number', default: 1 } },
      render(ctx) {
        renders++;
        return { image: ctx.gpu.pass({ size: { width: 40, height: 24, unit: 1 }, uniforms: { s: Number(ctx.params.seed) }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(fract(uv.x * u.s), uv.y, 0.5 * uv.x, 1.0); }' }) };
      },
    });
    const engine = new Engine(t.gpu, t.registry, t.engine.host);
    const store = memoryStore();
    engine.setColdStore(store, { minRenderMs: 0 });
    let g = createGraph();
    const a = addNode(g, t.registry, 'slow-gen', { x: 0, y: 0 }, { seed: 3 });
    const b = addNode(a.graph, t.registry, 'slow-gen', { x: 0, y: 0 }, { seed: 5 });
    g = b.graph;
    const first = (await engine.evaluate({ graph: g, node: a.node.id })).value as ImageValue;
    const pixels = await t.gpu.read(first, false);
    expect(renders).toBe(1);

    // squeeze the GPU cache: evaluating another node evicts the first one into the RAM tier
    engine.cacheBudget = 1;
    await engine.evaluate({ graph: g, node: b.node.id });
    await engine.evaluate({ graph: g, node: b.node.id });
    await new Promise((r) => setTimeout(r, 200)); // the readback is asynchronous
    expect(store.puts).toBeGreaterThan(0);
    expect(engine.coldStats().demoted).toBeGreaterThan(0);

    engine.cacheBudget = 1 << 30;
    const rendersBefore = renders;
    const back = await engine.evaluate({ graph: g, node: a.node.id });
    expect(back.errors.size).toBe(0);
    expect(renders).toBe(rendersBefore); // restored, not recomputed
    expect(engine.coldStats().promoted).toBeGreaterThan(0);
    const again = await t.gpu.read(back.value as ImageValue, false);
    expect(Array.from(again)).toEqual(Array.from(pixels)); // exact
    engine.clear();
  });
});
