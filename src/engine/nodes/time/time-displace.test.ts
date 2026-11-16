import { describe, expect, it, vi } from 'vitest';
import { addNode, connect } from '../../graph';
import { movingBarSource, timeChain } from '../../lib/fx-testutil';
import { SLICE_GROUP } from '../../lib/time-slices';
import { movingSquareSource, stillSource } from '../../lib/video-art-testutil';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

type H = Awaited<ReturnType<typeof harness>>;

function withMap(t: H, graph: ReturnType<typeof timeChain>['graph'], node: string, map: ImageValue) {
  const m = addNode(graph, t.registry, t.source(map));
  return connect(m.graph, t.registry, { node: m.node.id, port: 'out' }, { node, port: 'map' });
}

describe('time-displace', () => {
  it('a map picks the moment per pixel: black = now, white = the far end of the range', async () => {
    const t = await harness([movingBarSource()]);
    const map = t.fromFn(32, 32, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    let { graph, node } = timeChain(t, 'fx-moving-bar', 'time-displace', { range: 1, slices: 3, smooth: 0 });
    graph = withMap(t, graph, node, map);
    // frame 0: left half = now (bar at x=0); right half = 1 s earlier = frame -10 -> wraps to frame 10 (bar at x=20)
    const px = await t.pixels((await t.evalGraph(graph, node, { seconds: 0 })) as ImageValue);
    expect(px.at(1, 5)[0]).toBeGreaterThan(200);
    expect(px.at(20, 5)[0]).toBeGreaterThan(200);
    expect(px.at(8, 5)[0]).toBeLessThan(60);
    // direction future: frame +10 = also frame 10 here (loop of 20), so use a quarter range to tell them apart
    let b = timeChain(t, 'fx-moving-bar', 'time-displace', { range: 1.2, slices: 2, smooth: 0, direction: 'future' });
    const g2 = withMap(t, b.graph, b.node, map);
    const fut = await t.pixels((await t.evalGraph(g2, b.node, { seconds: 0 })) as ImageValue); // right half: frame 12, bar at x=24
    expect(fut.at(25, 5)[0]).toBeGreaterThan(200);
    expect(fut.at(19, 5)[0]).toBeLessThan(60);
  });

  it('shares the slice mechanism: passes = ceil(slices / group), pulls = distinct frames only', async () => {
    const spy = { n: 0 };
    const t = await harness([movingSquareSource('td-sq', spy)]);
    const map = t.fromFn(32, 32, (x) => { const g = Math.round((x / 31) * 255); return [g, g, g, 255]; });
    let { graph, node } = timeChain(t, 'td-sq', 'time-displace', { range: 1, slices: 20, smooth: 1 });
    graph = withMap(t, graph, node, map);
    const pass = vi.spyOn(t.gpu, 'pass');
    await t.evalGraph(graph, node, { seconds: 0.5 });
    expect(pass.mock.calls.filter((c) => c[0].label === 'time-displace').length).toBe(Math.ceil(20 / SLICE_GROUP)); // 3 passes, not 20
    // 20 slices over 1 s at 10 fps land on 11 distinct frames (the current one included): the source renders 11 times, not 20
    expect(spy.n).toBe(11);
    pass.mockRestore();
  });

  it('a still input needs no pulls, no slices and no clock', async () => {
    const t = await harness([stillSource('td-still')]);
    const map = t.fromFn(32, 32, (x) => [x * 8, x * 8, x * 8, 255]);
    let g = timeChain(t, 'td-still', 'time-displace', { range: 2, slices: 32 });
    const graph = withMap(t, g.graph, g.node, map);
    const pass = vi.spyOn(t.gpu, 'pass');
    const out = (await t.evalGraph(graph, g.node, { seconds: 0.3 })) as ImageValue;
    await t.evalGraph(graph, g.node, { seconds: 1.1 });
    expect(pass.mock.calls.filter((c) => c[0].label === 'time-displace').length).toBe(0);
    expect((await t.pixels(out)).at(16, 16)[0]).toBe(255);
    pass.mockRestore();
  });

  it('dragging a number never compiles a new shader', async () => {
    const t = await harness([movingBarSource()]);
    const map = t.fromFn(32, 32, (x) => [x * 8, x * 8, x * 8, 255]);
    const run = async (range: number, slices: number, smooth: number) => {
      let g = timeChain(t, 'fx-moving-bar', 'time-displace', { range, slices, smooth });
      const graph = withMap(t, g.graph, g.node, map);
      for (const s of [0.5, 0.9]) await t.evalGraph(graph, g.node, { seconds: s });
    };
    await run(1, 16, 1);
    const before = t.gpu.stats().objects.pipelinesCreated;
    await run(0.7, 16, 0.5);
    await run(1.3, 16, 0.2);
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
  });
});
