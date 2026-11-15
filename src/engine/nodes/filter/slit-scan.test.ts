import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { movingBarSource, timeChain } from '../../lib/fx-testutil';

/** x range (min,max) of bright pixels in row y */
function barAt(px: { at(x: number, y: number): number[]; width: number }, y: number): [number, number] {
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < px.width; x++) if (px.at(x, y)[0] > 128) { if (lo < 0) lo = x; hi = x; }
  return [lo, hi];
}

describe('slit-scan', () => {
  it('rows show different moments: the top is now, the bottom is the past', async () => {
    const t = await harness([movingBarSource()]);
    const { graph, node } = timeChain(t, 'fx-moving-bar', 'slit-scan', { direction: 'rows', range: 10, slices: 6, smooth: 0 });
    const px = await t.pixels((await t.evalGraph(graph, node, { seconds: 1 })) as never); // frame 10: bar at x=20
    const top = barAt(px, 0);
    const bottom = barAt(px, 31);
    expect(top[0]).toBeGreaterThanOrEqual(18);
    expect(top[1]).toBeLessThanOrEqual(23);
    expect(bottom[1]).toBeLessThanOrEqual(3); // frame 0: bar at x=0
    const mid = barAt(px, 16);
    expect(mid[0]).toBeGreaterThan(bottom[1]);
    expect(mid[1]).toBeLessThan(top[0] + 2);
  });

  it('columns and rings work, and reverse flips the delay', async () => {
    const t = await harness([movingBarSource()]);
    const run = async (params: Record<string, unknown>) => {
      const { graph, node } = timeChain(t, 'fx-moving-bar', 'slit-scan', { range: 10, slices: 6, smooth: 0, ...params });
      return t.pixels((await t.evalGraph(graph, node, { seconds: 1 })) as never);
    };
    const rows = await run({ direction: 'rows' });
    const rev = await run({ direction: 'rows', reverse: true });
    expect(barAt(rev, 31)[0]).toBeGreaterThanOrEqual(18);
    expect(barAt(rev, 0)[1]).toBeLessThanOrEqual(3);
    expect(barAt(rows, 0)[0]).toBeGreaterThanOrEqual(18);
    const cols = await run({ direction: 'columns' });
    expect(cols.at(20, 0)[0]).toBe(cols.at(20, 31)[0]); // columns: every row identical
    const ring = await run({ direction: 'radial' });
    expect(ring.width).toBe(32);
  });

  it('a time map chooses the delay per pixel and wraps around the loop', async () => {
    const t = await harness([movingBarSource()]);
    const tmap = t.fromFn(32, 32, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    let { graph, node } = timeChain(t, 'fx-moving-bar', 'slit-scan', { range: 10, slices: 3, smooth: 0 });
    // second input: wire the map
    const mapSource = t.source(tmap);
    const { addNode, connect } = await import('../../graph');
    const m = addNode(graph, t.registry, mapSource);
    graph = connect(m.graph, t.registry, { node: m.node.id, port: 'out' }, { node, port: 'timeMap' });
    const px = await t.pixels((await t.evalGraph(graph, node, { seconds: 0 })) as never); // frame 0
    // left half: delay 0 -> bar at x=0 now; right half: delay 10 frames -> frame -10 wraps to 10 -> bar at x=20
    expect(px.at(1, 5)[0]).toBeGreaterThan(128);
    expect(px.at(20, 5)[0]).toBeGreaterThan(128);
    expect(px.at(8, 5)[0]).toBeLessThan(60);
  });

  it('a still picture comes back unchanged', async () => {
    const t = await harness();
    const src = t.checker(32, 32, 4);
    const px = await t.pixels((await t.run('slit-scan', { smooth: 1, range: 6 }, { image: src })).image as never);
    const ref = await t.pixels(src);
    expect(Math.abs(px.at(5, 5)[0] - ref.at(5, 5)[0])).toBeLessThan(3);
    expect(Math.abs(px.at(13, 29)[0] - ref.at(13, 29)[0])).toBeLessThan(3);
  });
});
