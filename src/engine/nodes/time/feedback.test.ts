import { describe, expect, it, vi } from 'vitest';
import { fadingSource, movingSquareSource, stillSource } from '../../lib/video-art-testutil';
import { sourceChain } from '../../lib/util-testsource';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

const P = { width: 32, height: 32 };

async function bytes(t: Awaited<ReturnType<typeof harness>>, v: unknown): Promise<Uint8ClampedArray> {
  return t.gpu.read(v as ImageValue, false);
}

describe('feedback', () => {
  it('matches the hand-computed bounded fold (K=2, no transform)', async () => {
    const c = (f: number) => 0.1 + 0.05 * f;
    const t = await harness([fadingSource('fb-fade', c)]);
    const gain = 0.5;
    const { graph, node } = sourceChain(t, 'fb-fade', 'feedback', { memory: 2, decay: gain, zoom: 1 }, { loop: false, duration: 10 });
    // start(f) = max(0, (floor(f / K) - 1) * K); out = over(in, gain * previous)
    const expected = (f: number) => {
      const start = Math.max(0, (Math.floor(f / 2) - 1) * 2);
      let acc = 0;
      let first = true;
      for (let g = start; g <= f; g++) {
        acc = first ? c(g) : c(g) + gain * acc * (1 - c(g));
        first = false;
      }
      return acc;
    };
    for (const f of [0, 1, 2, 5, 6, 9]) {
      const px = await t.pixels((await t.evalGraph(graph, node, { seconds: f / 10 })) as ImageValue);
      const want = Math.round(expected(f) * 255);
      expect(Math.abs(px.at(1, 1)[3] - want), `frame ${f}`).toBeLessThanOrEqual(2);
    }
  });

  it('forward playback with the cache gives the very same pixels as the fold from scratch', async () => {
    const params = { memory: 4, decay: 0.85, zoom: 1.05, rotate: 3, shiftX: 1, hueShift: 8, blur: 1 };
    const project = { loop: false, duration: 10, ...P };
    const play = await harness([movingSquareSource('fb-sq')]);
    const a = sourceChain(play, 'fb-sq', 'feedback', params, project);
    const played: Uint8ClampedArray[] = [];
    for (let f = 0; f <= 13; f++) played.push(new Uint8ClampedArray(await bytes(play, await play.evalGraph(a.graph, a.node, { seconds: f / 10 }))));
    // fresh engine each time = nothing cached: every frame is the fold
    for (const f of [1, 3, 4, 5, 8, 9, 13]) {
      const cold = await harness([movingSquareSource('fb-sq')]);
      const b = sourceChain(cold, 'fb-sq', 'feedback', params, project);
      const px = await bytes(cold, await cold.evalGraph(b.graph, b.node, { seconds: f / 10 }));
      expect(Buffer.from(px).equals(Buffer.from(played[f])), `frame ${f}`).toBe(true);
    }
    // the trail really is there: behind the square (it moves right) the picture is not empty
    const last = await play.pixels((await play.evalGraph(a.graph, a.node, { seconds: 1.3 })) as ImageValue);
    let lit = 0;
    for (let x = 0; x < 32; x++) if (last.at(x, 16)[3] > 8) lit++;
    expect(lit).toBeGreaterThan(8);
  });

  /** Passes of this node and input evaluations per frame while playing frames 0..frames-1 forward on one engine. */
  async function playCost(K: number, frames: number, project: Record<string, unknown>) {
    const spy = { n: 0 };
    const t = await harness([movingSquareSource('fb-sq', spy)]);
    const { graph, node } = sourceChain(t, 'fb-sq', 'feedback', { memory: K }, { duration: 100, ...P, ...project });
    const pass = vi.spyOn(t.gpu, 'pass');
    const passes: number[] = [];
    const sources: number[] = [];
    for (let f = 0; f < frames; f++) {
      pass.mockClear();
      const before = spy.n;
      await t.evalGraph(graph, node, { seconds: f / 10 });
      sources.push(spy.n - before);
      passes.push(pass.mock.calls.filter((c) => c[0].label === 'feedback').length);
    }
    return { t, graph, node, spy, pass, passes, sources };
  }

  it('forward playback costs a constant 2 passes and 1 input evaluation per frame: no restart spike over 4K frames', async () => {
    for (const K of [4, 24]) {
      const { passes, sources, pass } = await playCost(K, 4 * K + 3, { loop: false });
      expect(passes[0], 'the first frame is one copy').toBe(1);
      const rest = passes.slice(1);
      expect(Math.max(...rest), `K=${K}: no spike (before: 2K+1 = ${2 * K + 1} every K frames)`).toBe(2);
      expect(Math.min(...rest)).toBe(2);
      expect(sources.every((n) => n === 1), 'the input is evaluated once per frame, never re-pulled').toBe(true);
      pass.mockRestore();
    }
  });

  it('a jump rebuilds the trail once (bounded), then forward playback is constant again', async () => {
    const K = 4;
    const { t, graph, node, spy, pass } = await playCost(K, 3, { loop: false });
    pass.mockClear();
    const before = spy.n;
    await t.evalGraph(graph, node, { seconds: 2.7 }); // frame 27: far from anything cached
    const cold = pass.mock.calls.filter((c) => c[0].label === 'feedback').length;
    expect(cold).toBeLessThanOrEqual(3 * K + 2);
    expect(spy.n - before).toBeLessThanOrEqual(2 * K + 1);
    for (let f = 28; f < 28 + 3 * K; f++) {
      pass.mockClear();
      await t.evalGraph(graph, node, { seconds: f / 10 });
      expect(pass.mock.calls.filter((c) => c[0].label === 'feedback').length, `frame ${f}`).toBe(2);
    }
    pass.mockRestore();
  });

  it('with Loop on the wrap is as cheap as any other frame, and played frames equal cold ones across the seam (K does not divide N)', async () => {
    const K = 4;
    const N = 14; // 3 epochs: [0,4) [4,8) [8,14)
    const project = { loop: true, duration: N / 10 };
    const params = { memory: K, decay: 0.85, zoom: 1.05, rotate: 3, shiftX: 1, hueShift: 8, blur: 1 };
    const spy = { n: 0 };
    const play = await harness([movingSquareSource('fb-sq', spy)]);
    const a = sourceChain(play, 'fb-sq', 'feedback', params, { ...project, ...P });
    const pass = vi.spyOn(play.gpu, 'pass');
    const played: Uint8ClampedArray[] = [];
    const passes: number[] = [];
    for (let lap = 0; lap < 2; lap++) {
      for (let f = 0; f < N; f++) {
        pass.mockClear();
        const px = await bytes(play, await play.evalGraph(a.graph, a.node, { seconds: f / 10 }));
        passes.push(pass.mock.calls.filter((c) => c[0].label === 'feedback').length);
        if (lap === 1) expect(Buffer.from(px).equals(Buffer.from(played[f])), `lap 2 frame ${f} equals lap 1`).toBe(true);
        else played.push(new Uint8ClampedArray(px));
      }
    }
    pass.mockRestore();
    // lap 1 starts cold (frame 0 folds the previous epoch around the seam); from then on every frame, wrap included, is 2 passes
    expect(passes.slice(1).every((n) => n === 2), passes.join(',')).toBe(true);
    for (const f of [0, 1, 3, 4, 7, 8, 11, 13]) {
      const cold = await harness([movingSquareSource('fb-sq')]);
      const b = sourceChain(cold, 'fb-sq', 'feedback', params, { ...project, ...P });
      const px = await bytes(cold, await cold.evalGraph(b.graph, b.node, { seconds: f / 10 }));
      expect(Buffer.from(px).equals(Buffer.from(played[f])), `frame ${f} cold == warm`).toBe(true);
    }
  });

  it('the loop seam closes (frame N is frame 0, the wrap step is no bigger than the others)', async () => {
    const t = await harness([movingSquareSource('fb-sq', { n: 0 }, { speed: 2 })]);
    for (const [frames, memory] of [[16, 4], [16, 5], [32, 24], [32, 7]]) {
      const r = await t.loopCheck('feedback', { memory, decay: 0.9, zoom: 1 }, { image: { node: 'fb-sq' } }, { frames, size: 32, exact: true });
      expect(r.exactDiff, r.text).toBe(0);
      expect(r.motion, r.text).toBeGreaterThan(0);
    }
  });

  it('a static input costs nothing after warm-up: no input evaluation, no pass', async () => {
    const spy = { n: 0 };
    const t = await harness([stillSource('fb-still', spy)]);
    const { graph, node } = sourceChain(t, 'fb-still', 'feedback', { memory: 6 }, { loop: false, duration: 4, ...P });
    const pass = vi.spyOn(t.gpu, 'pass');
    await t.evalGraph(graph, node, { seconds: 0 });
    pass.mockClear();
    for (let f = 1; f < 20; f++) await t.evalGraph(graph, node, { seconds: f / 10 });
    expect(pass.mock.calls.filter((c) => c[0].label === 'feedback').length).toBe(0);
    expect(spy.n).toBe(1);
    pass.mockRestore();
  });

  it('a still input is evaluated once and the result is static', async () => {
    const spy = { n: 0 };
    const t = await harness([stillSource('fb-still', spy)]);
    const { graph, node } = sourceChain(t, 'fb-still', 'feedback', { memory: 6, zoom: 1.1 }, { loop: true, duration: 4, ...P });
    const pass = vi.spyOn(t.gpu, 'pass');
    const first = await t.evalGraph(graph, node, { seconds: 0 });
    const passes = pass.mock.calls.filter((c) => c[0].label === 'feedback').length;
    expect(passes).toBe(6); // K sequential passes, no pulls
    for (const s of [0.1, 0.7, 2.5]) await t.evalGraph(graph, node, { seconds: s });
    expect(spy.n).toBe(1);
    expect(pass.mock.calls.filter((c) => c[0].label === 'feedback').length).toBe(6); // cached: nothing re-rendered on other frames
    expect(first).toBeTruthy();
    pass.mockRestore();
  });

  it('loops: the trail wraps around the seam and frame N equals frame 0', async () => {
    const t = await harness([movingSquareSource('fb-sq', { n: 0 }, { speed: 2 })]);
    const { graph, node } = sourceChain(t, 'fb-sq', 'feedback', { memory: 4, decay: 0.9, zoom: 1 }, { loop: true, duration: 1.6, fps: 10, ...P }); // 16 frames, square wraps every 16
    const at = async (s: number) => bytes(t, await t.evalGraph(graph, node, { seconds: s }));
    const f0 = await at(0);
    const f16 = await at(1.6);
    expect(Buffer.from(f0).equals(Buffer.from(f16))).toBe(true);
    // frame 0 already carries the trail of frames 14 and 15 (square at x=28..30): lit pixels far right of the current square (x 0..7)
    const px = await t.pixels((await t.evalGraph(graph, node, { seconds: 0.0 })) as ImageValue);
    expect(px.at(29, 16)[3]).toBeGreaterThan(40);
  });

  it('dragging a number never compiles a new shader', async () => {
    const t = await harness([movingSquareSource('fb-sq')]);
    const run = async (decay: number, zoom: number) => {
      const { graph, node } = sourceChain(t, 'fb-sq', 'feedback', { memory: 3, decay, zoom, blur: 2, hueShift: 5 }, { loop: false, duration: 5, ...P });
      for (let f = 0; f < 4; f++) await t.evalGraph(graph, node, { seconds: f / 10 });
    };
    await run(0.9, 1.02);
    const before = t.gpu.stats().objects.pipelinesCreated;
    await run(0.8, 1.04);
    await run(0.7, 0.97);
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
  });
});
