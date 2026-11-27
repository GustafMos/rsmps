/**
 * Benchmark and regression guard for the Detect Blobs -> Track -> Region Overlay pipeline on a portrait clip.
 * Prints a table (per-node ms, GPU passes, readbacks, bytes, text rasterisations, detector renders) for first play, loop, scrub
 * and analysed playback. Thresholds are on COUNTS only: the software GPU makes milliseconds meaningless in absolute terms.
 */
import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../engine/graph';
import { defineNode } from '../engine/define';
import { withProcessResult } from '../engine/process';
import { harness } from '../engine/testing';
import type { GraphDoc, Host, ProcessLive, RegionsValue } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const W = 540;
const H = 960;
const FPS = 30;
const FRAMES = 60;

/** Stand-in for decoded video: textured background, three moving bright discs. Costs a full-frame upload per frame, like a decode. */
function clipSource(counter: { n: number }) {
  const bg = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 40 + ((x * 7 + y * 13 + ((x * y) % 17) * 5) % 60);
      bg.set([v, v - 5, v + 10, 255], (y * W + x) * 4);
    }
  }
  return defineNode({
    id: 'bench-clip',
    title: 'bench clip',
    category: 'input',
    description: 'test clip',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      counter.n++;
      const f = ctx.time.frame;
      const data = new Uint8ClampedArray(bg);
      const discs = [
        [90 + 5 * f, 200 + 3 * f, 22],
        [450 - 4 * f, 500 + 2 * f, 18],
        [270 + 2 * f, 800 - 6 * f, 26],
      ];
      for (const [cx, cy, r] of discs) {
        for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
          for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data.set([255, 250, 240, 255], (y * W + x) * 4);
          }
        }
      }
      return { image: ctx.gpu.upload(data, W, H, ctx.unitFor(W, H)) };
    },
  });
}

interface Tally {
  frames: number;
  ms: Map<string, number>;
  passes: number;
  reads: number;
  readBytes: number;
  rasters: number;
  detectorRenders: number;
  clipRenders: number;
  wall: number;
}

async function setup() {
  const clip = { n: 0 };
  const lib = new MemoryProcessLibrary();
  let rasters = 0;
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: async () => null,
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
    rasterizeText: (spec) => {
      rasters++;
      const width = Math.max(8, spec.text.length * 8);
      const height = 20;
      return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
    },
  };
  const t = await harness([clipSource(clip)], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host });
  let g: GraphDoc = createGraph('bench');
  g = { ...g, project: { ...g.project, width: W, height: H, fps: FPS, duration: FRAMES / FPS, loop: false } };
  const add = (type: string, params: Record<string, unknown> = {}) => {
    const r = addNode(g, t.registry, type, { x: 0, y: 0 }, params);
    g = r.graph;
    return r.node.id;
  };
  const wire = (a: string, ap: string, b: string, bp: string) => {
    g = connect(g, t.registry, { node: a, port: ap }, { node: b, port: bp });
  };
  const src = add('bench-clip');
  const det = add('detect-blobs', { threshold: 0.9, blur: 1 });
  const trk = add('track');
  const hud = add('region-overlay', { style: 'brackets', showLabel: true });
  wire(src, 'image', det, 'image');
  wire(det, 'regions', trk, 'regions');
  wire(src, 'image', hud, 'image');
  wire(trk, 'regions', hud, 'regions');

  // Instrument the shared GPU.
  const gpu = t.gpu as unknown as Record<string, (...a: unknown[]) => unknown>;
  const counts = { passes: 0, reads: 0, bytes: 0 };
  const origPass = gpu.pass.bind(t.gpu);
  const origRead = gpu.readRaw.bind(t.gpu);
  gpu.pass = (...a) => {
    counts.passes++;
    return origPass(...a);
  };
  gpu.readRaw = (...a) => {
    const im = a[0] as { width: number; height: number };
    counts.reads++;
    counts.bytes += im.width * im.height * 4;
    return origRead(...a);
  };

  async function play(graph: GraphDoc, frames: number[], node = hud): Promise<Tally> {
    const tl: Tally = { frames: frames.length, ms: new Map(), passes: 0, reads: 0, readBytes: 0, rasters: 0, detectorRenders: 0, clipRenders: 0, wall: 0 };
    const c0 = { ...counts };
    const r0 = rasters;
    const k0 = clip.n;
    const w0 = performance.now();
    for (const f of frames) {
      const r = await t.engine.evaluate({ graph, node, seconds: f / FPS });
      expect(r.errors.size).toBe(0);
      for (const [id, ms] of r.timings) tl.ms.set(id, (tl.ms.get(id) ?? 0) + ms);
      if (r.timings.has(det)) tl.detectorRenders++;
    }
    tl.wall = performance.now() - w0;
    tl.passes = counts.passes - c0.passes;
    tl.reads = counts.reads - c0.reads;
    tl.readBytes = counts.bytes - c0.bytes;
    tl.rasters = rasters - r0;
    tl.clipRenders = clip.n - k0;
    return tl;
  }
  return { t, rt, lib, g: () => g, src, det, trk, hud, play };
}

const seq = (n: number, reverse = false) => Array.from({ length: n }, (_, i) => (reverse ? n - 1 - i : i));

describe('detect -> track -> overlay on a portrait clip', () => {
  it('stays cheap on the second loop, on scrubbing and once analysed', async () => {
    const s = await setup();
    const rows: [string, Tally][] = [];
    const first = await s.play(s.g(), seq(FRAMES));
    rows.push(['first play (not analysed)', first]);
    const loop = await s.play(s.g(), seq(FRAMES));
    rows.push(['second loop', loop]);
    const scrub = await s.play(s.g(), seq(FRAMES, true));
    rows.push(['scrub back', scrub]);

    s.t.engine.clear();
    rows.push(['decode floor (clip only)', await s.play(s.g(), seq(FRAMES), s.src)]);

    const result = await s.rt.run(s.g(), s.trk);
    const done = withProcessResult(s.g(), s.t.registry, s.trk, result);
    s.t.engine.clear();
    const analysed = await s.play(done, seq(FRAMES));
    rows.push(['analysed, first play', analysed]);
    const analysedLoop = await s.play(done, seq(FRAMES));
    rows.push(['analysed, second loop', analysedLoop]);

    const names: Record<string, string> = { [s.src]: 'clip', [s.det]: 'detect', [s.trk]: 'track', [s.hud]: 'overlay' };
    const lines = ['', 'scenario                   | frames | ms/frame wall | clip   detect  track  overlay (ms/frame) | passes/f | reads/f | KB/f | detector renders | text rasters | clip renders'];
    for (const [name, tl] of rows) {
      const per = (id: string) => ((tl.ms.get(id) ?? 0) / tl.frames).toFixed(1).padStart(6);
      lines.push(
        `${name.padEnd(26)} | ${String(tl.frames).padStart(6)} | ${(tl.wall / tl.frames).toFixed(1).padStart(13)} | ${Object.keys(names).map(per).join(' ')} | ${(tl.passes / tl.frames).toFixed(1).padStart(8)} | ${(tl.reads / tl.frames).toFixed(2).padStart(7)} | ${(tl.readBytes / tl.frames / 1024).toFixed(0).padStart(4)} | ${String(tl.detectorRenders).padStart(16)} | ${String(tl.rasters).padStart(12)} | ${tl.clipRenders}`,
      );
    }
    console.log(lines.join('\n'));

    const check = await s.t.engine.evaluate({ graph: done, node: s.trk, seconds: 5 / FPS });
    expect((check.value as RegionsValue).items.length).toBeGreaterThan(0);

    // Count guards (not milliseconds).
    expect(first.reads / FRAMES).toBeLessThanOrEqual(1.01); // one small readback per detected frame, never more
    expect(first.readBytes / FRAMES).toBeLessThan(256 * 256 * 4 * 1.2); // only the analysis grid leaves the GPU
    expect(loop.detectorRenders).toBe(0); // second loop: nothing is detected again
    expect(loop.reads).toBe(0);
    expect(scrub.detectorRenders).toBe(0);
    expect(scrub.reads).toBe(0);
    expect(analysed.detectorRenders).toBe(0); // current analysis: Detect Blobs is never evaluated
    expect(analysed.reads).toBe(0);
    expect(analysedLoop.detectorRenders).toBe(0);
    expect(analysed.passes / FRAMES).toBeLessThanOrEqual(4);
    expect(first.rasters).toBeLessThanOrEqual(FRAMES * 4); // labels are rasterised per distinct text, not per region per frame
  }, 600_000);
});
