import { expect, it, vi } from 'vitest';
import { cubeText } from '../../lib/color-math';
import { makeChart } from '../../lib/color-testutil';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';
import type { CurveValue, GraphDoc, Host } from '../../types';

/**
 * Performance contract of the grading nodes: dragging any slider re-renders with new uniforms only. No shader module, no pipeline,
 * no buffer and (for the one-pass nodes) no bind group is created once the node has rendered twice.
 */
const curve = (mid: number): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'smooth' }, { t: 0.5, v: mid, interp: 'smooth' }, { t: 1, v: 1, interp: 'smooth' }] });
const hue = (v: number): CurveValue => ({ keys: [{ t: 0, v: 0.5, interp: 'smooth' }, { t: 0.6, v, interp: 'smooth' }] });

const CASES: { id: string; params: (i: number) => Record<string, unknown>; oneBindGroup: boolean }[] = [
  { id: 'white-balance', params: (i) => ({ temperature: 3000 + i * 37, tint: i * 0.01, mode: i % 3 === 0 ? 'temperature' : 'neutral', neutral: [0.5 + i * 0.002, 0.5, 0.4, 1] }), oneBindGroup: true },
  { id: 'saturation', params: (i) => ({ saturation: 0.2 + i * 0.05, vibrance: i * 0.01, mode: ['oklab', 'linear', 'hsl'][i % 3], shadowRolloff: i * 0.01 }), oneBindGroup: true },
  { id: 'color-wheels', params: (i) => ({ liftMaster: i * 0.001, gammaMaster: i * 0.01, gainMaster: i * 0.01, contrast: 1 + i * 0.01, mode: i % 4 === 0 ? 'cdl' : 'lgg', slopeR: 1 + i * 0.01, space: ['display', 'linear', 'log'][i % 3] }), oneBindGroup: true },
  { id: 'curves', params: (i) => ({ master: curve(0.3 + i * 0.01), hueVsSat: hue(0.2 + i * 0.01) }), oneBindGroup: false },
  { id: 'exposure', params: (i) => ({ stops: -2 + i * 0.1, blackPoint: i * 0.001, rolloff: i * 0.01, tonemap: ['none', 'reinhard', 'hable'][i % 3], whitePoint: 2 + i * 0.1 }), oneBindGroup: true },
  { id: 'color-space', params: (i) => ({ from: ['srgb', 'p3', 'logc3', 'linear'][i % 4], to: ['linear', 'rec2020-g24', 'srgb', 'slog3'][i % 4] }), oneBindGroup: true },
  { id: 'hsl-qualifier', params: (i) => ({ hueCenter: i * 7, hueWidth: 10 + i, satLow: i * 0.01, lumHigh: 1 - i * 0.01, invert: i % 2 === 0 }), oneBindGroup: true },
  { id: 'lut', params: (i) => ({ lut: ['look'], intensity: 0.2 + i * 0.03, interpolation: i % 2 ? 'trilinear' : 'tetrahedral', inSpace: ['srgb', 'logc3'][i % 2] }), oneBindGroup: true },
  { id: 'scope', params: (i) => ({ type: ['waveform', 'parade', 'histogram', 'vectorscope'][i % 4], gain: 1 + i * 0.05, samples: 64 + i * 8, resolution: 192 }), oneBindGroup: false },
];

it('dragging sliders never compiles a shader or creates a buffer', async () => {
  const bytes = new TextEncoder().encode(cubeText('3d', 17, (r, g, b) => [g, b, r])).buffer as ArrayBuffer;
  const host: Host = { assetInfo: () => null, assetFrame: async () => null, assetBytes: async () => bytes };
  const t = await harness([], host);
  const src = makeChart(t);
  const device = t.gpu.device;
  const modules = vi.spyOn(device, 'createShaderModule');
  const renderPipes = vi.spyOn(device, 'createRenderPipeline');
  const computePipes = vi.spyOn(device, 'createComputePipeline');
  const buffers = vi.spyOn(device, 'createBuffer');
  try {
    for (const c of CASES) {
      const s = addNode(createGraph('perf'), t.registry, t.source(src));
      const n = addNode(s.graph, t.registry, c.id, { x: 0, y: 0 }, c.params(0));
      const g0 = connect(n.graph, t.registry, { node: s.node.id, port: 'out' }, { node: n.node.id, port: 'image' });
      const port = c.id === 'hsl-qualifier' ? 'mask' : 'image';
      const withParams = (i: number): GraphDoc => ({ ...g0, nodes: g0.nodes.map((x) => (x.id === n.node.id ? { ...x, params: c.params(i) } : x)) });
      // warm-up covers every enum branch (the params cycle with i)
      for (let i = 0; i < 12; i++) {
        const r = await t.engine.evaluate({ graph: withParams(i), node: n.node.id, port });
        expect(r.errors.size, `${c.id} warm-up ${[...r.errors.values()]}`).toBe(0);
      }
      const before = { modules: modules.mock.calls.length, render: renderPipes.mock.calls.length, compute: computePipes.mock.calls.length, buffers: buffers.mock.calls.length, stats: t.gpu.stats() };
      for (let i = 12; i < 60; i++) {
        const r = await t.engine.evaluate({ graph: withParams(i), node: n.node.id, port });
        expect(r.errors.size).toBe(0);
      }
      const after = t.gpu.stats();
      expect(modules.mock.calls.length - before.modules, `${c.id}: shader modules`).toBe(0);
      expect(renderPipes.mock.calls.length - before.render, `${c.id}: render pipelines`).toBe(0);
      expect(computePipes.mock.calls.length - before.compute, `${c.id}: compute pipelines`).toBe(0);
      expect(buffers.mock.calls.length - before.buffers, `${c.id}: buffers`).toBe(0);
      expect(after.objects.pipelinesCreated - before.stats.objects.pipelinesCreated, `${c.id}: pipelines`).toBe(0);
      if (c.oneBindGroup) expect(after.objects.bindGroupsCreated - before.stats.objects.bindGroupsCreated, `${c.id}: bind groups`).toBe(0);
    }
    expect(modules.mock.calls.length, 'the spy sees shader compilation at all').toBeGreaterThanOrEqual(CASES.length);
  } finally {
    modules.mockRestore();
    renderPipes.mockRestore();
    computePipes.mockRestore();
    buffers.mockRestore();
  }
}, 120_000);

it('each grading node renders its picture in exactly one pass (qualifier preview and white balance auto-estimate are the documented extras)', async () => {
  const t = await harness();
  const src = makeChart(t);
  const submits = () => t.gpu.stats().objects.submits;
  const cases: [string, Record<string, unknown>][] = [
    ['white-balance', { temperature: 4000 }],
    ['saturation', { saturation: 1.5 }],
    ['color-wheels', { gainMaster: 0.2 }],
    ['curves', { master: curve(0.4) }],
    ['exposure', { stops: 1 }],
    ['color-space', {}],
    ['hsl-qualifier', {}],
  ];
  for (const [id, p] of cases) {
    await t.run(id, p, { image: src }); // warm
    const before = submits();
    await t.run(id, { ...p, ...(id === 'saturation' ? { saturation: 1.6 } : id === 'exposure' ? { stops: 1.1 } : id === 'white-balance' ? { temperature: 4100 } : id === 'color-wheels' ? { gainMaster: 0.25 } : id === 'curves' ? { master: curve(0.45) } : id === 'color-space' ? { to: 'p3' } : { hueWidth: 31 }) }, { image: src });
    // the harness reads the output once per output port; count only the render submits by subtracting nothing else: it is 1 pass + 0 uploads
    expect(submits() - before, id).toBe(1);
  }
});
