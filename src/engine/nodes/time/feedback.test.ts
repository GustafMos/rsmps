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

  it('costs one pass per frame while playing forward, and a bounded fold after a jump', async () => {
    const spy = { n: 0 };
    const t = await harness([movingSquareSource('fb-sq', spy)]);
    const K = 4;
    const { graph, node } = sourceChain(t, 'fb-sq', 'feedback', { memory: K }, { loop: false, duration: 10, ...P });
    const pass = vi.spyOn(t.gpu, 'pass');
    const perFrame: number[] = [];
    const sources: number[] = [];
    for (let f = 0; f <= 12; f++) {
      pass.mockClear();
      const before = spy.n;
      await t.evalGraph(graph, node, { seconds: f / 10 });
      sources.push(spy.n - before);
      perFrame.push(pass.mock.calls.filter((c) => c[0].label === 'feedback').length);
    }
    // on chain frames the source renders once (never re-pulled), the node does exactly one pass for every frame that continues the chain
    for (let f = 0; f <= 12; f++) {
      if (f % K !== 0 || f === K) expect(sources[f], `source renders at frame ${f}`).toBe(1);
      expect(sources[f]).toBeLessThanOrEqual(2 * K);
    }
    // frames that start a new window (f = 0 and f = 2K, ...) rebuild from the fold; all others are 1 pass
    expect(perFrame.slice(0, 1)).toEqual([1]);
    for (let f = 1; f <= 12; f++) if (f % K !== 0 || f === K) expect(perFrame[f], `frame ${f}`).toBe(1);
    // a window restart costs at most 2K+1 passes (amortised below 2.5 passes per frame)
    expect(Math.max(...perFrame)).toBeLessThanOrEqual(2 * K + 1);
    expect(perFrame.reduce((a, b) => a + b, 0) / perFrame.length).toBeLessThan(2.5);
    // scrubbing far away rebuilds from the fold: bounded by 2K+1 passes and 2K pulls
    pass.mockClear();
    const before = spy.n;
    await t.evalGraph(graph, node, { seconds: 0.99 }); // frame 9: previous (8) is cached? it is not, 12 was the last
    const passes = pass.mock.calls.filter((c) => c[0].label === 'feedback').length;
    expect(passes).toBeLessThanOrEqual(2 * K + 1);
    expect(spy.n - before).toBeLessThanOrEqual(2 * K + 1);
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
