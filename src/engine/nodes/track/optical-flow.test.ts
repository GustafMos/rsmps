import { describe, expect, it, vi } from 'vitest';
import { scrollingTextureSource, stillSource } from '../../lib/video-art-testutil';
import { sourceChain } from '../../lib/util-testsource';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

type H = Awaited<ReturnType<typeof harness>>;
const project = { loop: false, duration: 10, width: 64, height: 64 };

/** Reads the flow image at (x, y) as motion in texels of the 64 px picture: the flow is x8-boosted into an 8-bit picture first. */
async function motionAt(t: H, flow: ImageValue, x: number, y: number): Promise<[number, number]> {
  const boosted = t.gpu.pass({
    label: 'probe',
    size: flow,
    textures: { f: flow },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let m = textureSampleLevel(f, smpNearest, uv, 0.0).rg; return vec4f(0.5 + m.x * 8.0, 0.5 + m.y * 8.0, 0.0, 1.0); }',
  });
  const px = await t.pixels(boosted);
  const [r, g] = px.at(Math.round((x / 64) * flow.width), Math.round((y / 64) * flow.height));
  return [(((r / 255 - 0.5) / 8) * 64), (((g / 255 - 0.5) / 8) * 64)];
}

describe('optical-flow', () => {
  it('measures the direction and size of a known shift (right, down, and left)', async () => {
    for (const [v, want] of [
      [[2, 0], [2, 0]],
      [[0, 2], [0, 2]],
      [[-3, 0], [-3, 0]],
    ] as const) {
      const t = await harness([scrollingTextureSource('of-scroll', [v[0], v[1]])]);
      const { graph, node } = sourceChain(t, 'of-scroll', 'optical-flow', { resolution: 1 }, project);
      const flow = (await t.evalGraph(graph, node, { seconds: 0.5, port: 'flow' })) as ImageValue;
      expect(flow.width).toBe(64);
      const [mx, my] = await motionAt(t, flow, 32, 32);
      expect(mx, `x for ${v}`).toBeGreaterThan(want[0] - 0.5);
      expect(mx).toBeLessThan(want[0] + 0.5);
      expect(my, `y for ${v}`).toBeGreaterThan(want[1] - 0.5);
      expect(my).toBeLessThan(want[1] + 0.5);
    }
  });

  it('works at half resolution and reports the motion in picture fractions', async () => {
    const t = await harness([scrollingTextureSource('of-scroll', [2, 0])]);
    const { graph, node } = sourceChain(t, 'of-scroll', 'optical-flow', { resolution: 0.5 }, project);
    const flow = (await t.evalGraph(graph, node, { seconds: 0.5, port: 'flow' })) as ImageValue;
    expect(flow.width).toBe(32);
    expect(flow.texture.format).toBe('rgba16float');
    const [mx, my] = await motionAt(t, flow, 20, 40);
    expect(mx).toBeGreaterThan(1.4);
    expect(mx).toBeLessThan(2.6);
    expect(Math.abs(my)).toBeLessThan(0.5);
    // the colour wheel: rightward motion = hue 0 (red), and it is bright
    const prev = (await t.evalGraph(graph, node, { seconds: 0.5, port: 'preview' })) as ImageValue;
    const px = await t.pixels(prev);
    const [r, g, b] = px.at(32, 32);
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
  });

  it('a still picture has no motion and is evaluated and cached once', async () => {
    const spy = { n: 0 };
    const t = await harness([stillSource('of-still', spy)]);
    const { graph, node } = sourceChain(t, 'of-still', 'optical-flow', {}, { ...project, width: 32, height: 32 });
    const flow = (await t.evalGraph(graph, node, { seconds: 0.2, port: 'flow' })) as ImageValue;
    const [mx, my] = await motionAt(t, { ...flow }, 16, 16).catch(() => [99, 99] as [number, number]);
    expect(Math.abs(mx)).toBeLessThan(0.2);
    expect(Math.abs(my)).toBeLessThan(0.2);
    const pass = vi.spyOn(t.gpu, 'pass');
    await t.evalGraph(graph, node, { seconds: 0.9, port: 'flow' });
    expect(pass.mock.calls.filter((c) => /flow/.test(String(c[0].label))).length).toBe(0);
    expect(spy.n).toBe(1);
    pass.mockRestore();
  });

  it('forward playback reuses the previous luma and gives the very same flow as a cold start', async () => {
    const spy = { n: 0 };
    const t = await harness([scrollingTextureSource('of-scroll', [2, 1], spy)]);
    const { graph, node } = sourceChain(t, 'of-scroll', 'optical-flow', {}, project);
    const pass = vi.spyOn(t.gpu, 'pass');
    const counts: number[] = [];
    const sources: number[] = [];
    let played: Uint8ClampedArray | null = null;
    for (let f = 0; f <= 6; f++) {
      pass.mockClear();
      const before = spy.n;
      const flow = (await t.evalGraph(graph, node, { seconds: f / 10, port: 'flow' })) as ImageValue;
      counts.push(pass.mock.calls.filter((c) => /^flow-(luma|down|lk)$/.test(String(c[0].label))).length);
      sources.push(spy.n - before);
      if (f === 6) played = new Uint8ClampedArray(await t.gpu.read(flow, false));
    }
    // a jump: the previous frame is not cached, its luma is rebuilt (one more pass, one more input evaluation)
    pass.mockClear();
    await t.evalGraph(graph, node, { seconds: 0.9, port: 'flow' });
    const jump = pass.mock.calls.filter((c) => /^flow-(luma|down|lk)$/.test(String(c[0].label))).length;
    pass.mockRestore();
    expect(jump).toBe(12);
    // L=3, I=2: luma 1 + down 2 (cur) + down 2 (prev) + 6 solver = 11 with a cached previous luma; 12 without it
    expect(counts[6]).toBe(11);
    expect(counts[0]).toBe(11); // frame 0 has no previous frame: zero flow from the frame itself
    expect(sources[6]).toBe(1); // the previous picture is never evaluated during forward playback
    const cold = await harness([scrollingTextureSource('of-scroll', [2, 1])]);
    const c = sourceChain(cold, 'of-scroll', 'optical-flow', {}, project);
    const cflow = (await cold.evalGraph(c.graph, c.node, { seconds: 0.6, port: 'flow' })) as ImageValue;
    expect(Buffer.from(await cold.gpu.read(cflow, false)).equals(Buffer.from(played as Uint8ClampedArray))).toBe(true);
  });

  it('dragging a number never compiles a new shader', async () => {
    const t = await harness([scrollingTextureSource('of-scroll', [2, 0])]);
    const run = async (resolution: number, window: number) => {
      const { graph, node } = sourceChain(t, 'of-scroll', 'optical-flow', { resolution, window, visScale: 3 }, project);
      for (let f = 1; f < 4; f++) await t.evalGraph(graph, node, { seconds: f / 10, port: 'preview' });
    };
    await run(0.5, 3);
    const before = t.gpu.stats().objects.pipelinesCreated;
    await run(0.6, 4);
    await run(0.4, 2);
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
  });
});
