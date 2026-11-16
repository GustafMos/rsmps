/** CLI export gate for process mode: without --process a render that would export a stand-in fails with the list; with it the process runs first. */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { defineNode } from '../../engine/define';
import type { Gpu } from '../../engine/gpu/gpu';
import { testGpu } from '../../engine/testing';
import { renderGraphBatch } from '../render';
import { builtinRegistry, chain, readRaw, tempDir } from './testkit';

/** Analyses every frame (mean red), stores the numbers; once processed it draws solid green so the test can tell stand-in from result. */
const analyse = defineNode({
  id: 'analyse-test',
  title: 'Analyse (test)',
  category: 'generate',
  description: 'test node with a CPU process',
  inputs: { image: { type: 'image', lazy: true, required: true } },
  outputs: { image: { type: 'image' } },
  params: {},
  process: {
    title: 'Analyse',
    standIn: 'bypass',
    gpu: false,
    signature: (_p, sigs) => sigs.image,
    async run(job) {
      const means: number[] = [];
      for (let f = 0; f < job.frames; f++) {
        await job.yield();
        const pulled = await job.pull('image', { frame: f });
        try {
          const px = await job.gpu.read(pulled.value as never, true);
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) sum += px[i];
          means.push(sum / (px.length / 4));
        } finally {
          pulled.release();
        }
        job.progress((f + 1) / job.frames);
      }
      job.store.json('means', means);
      return {};
    },
  },
  async render(ctx) {
    const ps = ctx.process!;
    const means = ps.servable ? await ps.json<number[]>('means') : null;
    if (means) {
      const src = ctx.canvas;
      return { image: ctx.gpu.pass({ size: { width: src.width, height: src.height, unit: src.unit }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }' }) };
    }
    return ps.standIn();
  },
});

let gpu: Gpu;
beforeAll(async () => {
  gpu = await testGpu();
}, 60_000);

function graphWithProcess() {
  const registry = builtinRegistry();
  registry.register(analyse);
  const c = chain(registry, [{ type: 'shape', params: { kind: 'rect', width: 1, height: 1, fill: [1, 0, 0, 1] } }, { type: 'analyse-test' }], { width: 32, height: 24, fps: 4, duration: 1 }, { name: 'out', kind: 'image' });
  return { registry, graph: c.graph };
}

describe('cli process gate', () => {
  it('fails by default and lists what must run first; nothing is written', async () => {
    const { registry, graph } = graphWithProcess();
    const out = join(tempDir(), 'out');
    mkdirSync(out);
    await expect(renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu })).rejects.toThrow(/must be run before exporting[\s\S]*Analyse \(test\) \(Analyse, none\)[\s\S]*--process/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('--process runs it first (in memory) and exports the real result, not the stand-in', async () => {
    const { registry, graph } = graphWithProcess();
    const out = join(tempDir(), 'out');
    mkdirSync(out);
    const infos: string[] = [];
    const sum = await renderGraphBatch({
      graph,
      registry,
      outDir: out,
      sequenceFps: 12,
      gpu,
      processes: 'run',
      reporter: { info: (m) => infos.push(m), warn: () => undefined, event: () => undefined, progress: () => undefined },
    });
    expect(sum.errors).toEqual([]);
    expect(infos.some((m) => /Running 1 process first: Analyse \(test\) \(Analyse\)/.test(m))).toBe(true);
    const img = await readRaw(join(out, readdirSync(out)[0]));
    expect(img.at(10, 10)).toEqual([0, 255, 0, 255]); // green = the processed result
  });
});
