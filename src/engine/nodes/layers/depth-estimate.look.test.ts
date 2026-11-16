import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { orbitPosition } from '../../lib/gen-camera';
import { PNG_DIR, sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { buildNode, cam, evalPort, readHalf } from '../../lib/splat-testutil';
import { addNode, connect, createGraph } from '../../graph';
import type { ImageValue } from '../../types';

/** Looks at Depth from Picture on scripts/screenshots/assets/base-scene.png: depth per preset, and the depth through Picture to Splats from two angles. Writes PNGs to <scratchpad>/png/depth/. */
const T = { timeout: 300_000 };
const DIR = `${PNG_DIR}/depth`;
mkdirSync(DIR, { recursive: true });
const save = (name: string, px: Img, backdrop = false) => writePng(`depth/${name}`, px, backdrop);

async function loadPng(name: string): Promise<Img> {
  const { data, info } = await sharp(readFileSync(join(process.cwd(), 'scripts/screenshots/assets', name))).resize(960, 540, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}
const grey = (f: Float32Array, w: number, h: number): Img => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([f[i * 4] * 255, f[i * 4] * 255, f[i * 4] * 255, 255], i * 4);
  return { data: out, width: w, height: h };
};
const half = (px: Img): Img => {
  const w = Math.floor(px.width / 2), h = Math.floor(px.height / 2);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += px.data[((y * 2 + dy) * px.width + x * 2 + dx) * 4 + c];
    out[(y * w + x) * 4 + c] = s / 4;
  }
  return { data: out, width: w, height: h };
};
const orbit = (az: number, el: number, dist = 4.5) => cam({ position: orbitPosition([0, 0, 0], dist, az, el), target: [0, 0, 0], fov: 40 });

it('tuning variants', T, async () => {
  const t = await harness();
  const base = await loadPng('base-scene.png');
  const picture = t.fromFn(base.width, base.height, (x, y) => Array.from(base.data.subarray((y * base.width + x) * 4, (y * base.width + x) * 4 + 4)) as [number, number, number, number]);
  const variants: Record<string, unknown>[] = JSON.parse(process.env.DEPTH_VARIANTS ?? '[{}]');
  const shots: Img[] = [];
  const maps: Img[] = [];
  for (const v of variants) {
    const g = buildNode(t, 'depth-estimate', v, { image: picture }, { width: base.width, height: base.height });
    const d = (await evalPort(t, g, 'depth')) as ImageValue;
    t.gpu.retain(d.texture);
    maps.push(half(grey(await readHalf(t, d), d.width, d.height)));
    const gg = buildNode(t, 'image-to-splats', { density: 640, near: 3.5, far: 5.5 }, { image: picture, depth: d, camera: orbit(16, 3) }, { width: base.width, height: base.height });
    shots.push(half(await t.pixels((await evalPort(t, gg)) as ImageValue)));
  }
  save('tune-depth', sheet(maps, 2));
  save('tune-splats', sheet(shots, 2));
});

it('base-scene: depth for every preset, and through Picture to Splats from two angles', T, async () => {
  const t = await harness();
  const base = await loadPng('base-scene.png');
  const picture = t.fromFn(base.width, base.height, (x, y) => Array.from(base.data.subarray((y * base.width + x) * 4, (y * base.width + x) * 4 + 4)) as [number, number, number, number]);
  const names = ['custom', 'portrait', 'landscape', 'room', 'graphic', 'flat'];
  const maps: Img[] = [];
  const depths = new Map<string, ImageValue>();
  for (const preset of names) {
    const g = buildNode(t, 'depth-estimate', { preset }, { image: picture }, { width: base.width, height: base.height });
    const d = (await evalPort(t, g, 'depth')) as ImageValue;
    t.gpu.retain(d.texture);
    depths.set(preset, d);
    const m = grey(await readHalf(t, d), d.width, d.height);
    maps.push(m);
    save(`base-depth-${preset}`, m);
  }
  save('base-depth-presets', sheet(maps.map(half), 3));
  save('base-picture', base);
  // preview output
  const g = buildNode(t, 'depth-estimate', {}, { image: picture }, { width: base.width, height: base.height });
  save('base-preview', await t.pixels((await evalPort(t, g, 'preview')) as ImageValue));

  const run = async (params: Record<string, unknown>, wire: Parameters<typeof buildNode>[3]) => {
    const gg = buildNode(t, 'image-to-splats', params, { image: picture, ...wire }, { width: base.width, height: base.height });
    return half(await t.pixels((await evalPort(t, gg)) as ImageValue));
  };
  const views = [orbit(16, 3), orbit(-16, 3)];
  const none: Img[] = [];
  const withDepth: Img[] = [];
  for (const v of views) none.push(await run({ density: 640, guess: 'flat', near: 3.5, far: 5.5 }, { camera: v }));
  for (const v of views) withDepth.push(await run({ density: 640, near: 3.5, far: 5.5 }, { depth: depths.get('custom')!, camera: v }));
  save('base-splats-nodepth-vs-depth', sheet([...none, ...withDepth], 2), false);
  save('base-splats-depth-right', withDepth[0]);
  save('base-splats-depth-left', withDepth[1]);
  expect(withDepth.length).toBe(2);
});

it('bench: passes and ms per frame at 1920x1080 (animated procedural source, subject mask wired, preview not wanted)', T, async () => {
  const t = await harness();
  t.registry.register({
    id: 'bench-plaid',
    title: 'bench',
    category: 'input',
    description: 'procedural animated picture, no CPU work',
    inputs: {},
    outputs: { out: { type: 'image' } },
    params: {},
    render: (ctx) => ({
      out: ctx.gpu.pass({
        size: { width: 1920, height: 1080, unit: 1 },
        uniforms: { f: ctx.time.frame },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let v = 0.5 + 0.4 * sin(uv.x * 40.0 + u.f * 0.3) * sin(uv.y * 31.0); let d = length(uv - vec2f(0.5, 0.55)); return vec4f(vec3f(v * smoothstep(0.35, 0.2, d) + 0.1 * uv.y, v * 0.5, 0.3 + 0.2 * uv.y), 1.0); }',
      }),
    }),
  });
  for (const quality of ['normal', 'draft', 'full']) {
    let graph = createGraph('bench');
    graph.project = { ...graph.project, width: 1920, height: 1080, fps: 30, duration: 10, loop: false };
    const a = addNode(graph, t.registry, 'depth-estimate', { x: 0, y: 0 }, { quality, subject: 0.5 });
    const s = addNode(a.graph, t.registry, 'bench-plaid');
    graph = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: a.node.id, port: 'image' });
    const ev = (f: number) => t.engine.evaluate({ graph, node: a.node.id, port: 'depth', seconds: f / 30 });
    for (let f = 0; f < 4; f++) await ev(f); // warm up: pipelines, pools, the one-off subject analysis
    await t.gpu.device.queue.onSubmittedWorkDone();
    const st0 = t.gpu.stats();
    const n = 30;
    const t0 = performance.now();
    for (let f = 4; f < 4 + n; f++) await ev(f);
    await t.gpu.device.queue.onSubmittedWorkDone();
    const ms = (performance.now() - t0) / n;
    const st1 = t.gpu.stats();
    const passes = (st1.caches.pipelineHits + st1.objects.pipelinesCreated - st0.caches.pipelineHits - st0.objects.pipelinesCreated) / n;
    console.log(`BENCH 1920x1080 quality=${quality}: ${ms.toFixed(2)} ms/frame, ${passes.toFixed(1)} passes/frame (includes the 1 source pass), allocations after warm-up: textures ${st1.objects.texturesCreated - st0.objects.texturesCreated}, buffers ${st1.objects.buffersCreated - st0.objects.buffersCreated}, pipelines ${st1.objects.pipelinesCreated - st0.objects.pipelinesCreated}`);
    expect(st1.objects.pipelinesCreated - st0.objects.pipelinesCreated).toBe(0);
  }
});
