import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { movingBarSource, timeChain } from '../../lib/fx-testutil';

/** x range of bright pixels in row y */
function bar(px: { at(x: number, y: number): number[]; width: number }, y: number): [number, number] {
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < px.width; x++) if (px.at(x, y)[0] > 128) { if (lo < 0) lo = x; hi = x; }
  return [lo, hi];
}

describe('datamosh', () => {
  const base = { blockSize: 8, search: 8, holdStart: 0, holdLength: 0.5 }; // frames 0..9 of a 20-frame loop

  async function frame(t: Awaited<ReturnType<typeof harness>>, params: Record<string, unknown>, frameNo: number) {
    const { graph, node } = timeChain(t, 'fx-moving-bar', 'datamosh', { ...base, ...params });
    return t.pixels((await t.evalGraph(graph, node, { seconds: frameNo / 10 })) as never);
  }

  it('outside the span the picture is the real frame', async () => {
    const t = await harness([movingBarSource()]);
    const px = await frame(t, {}, 14); // bar at x=28 (px 27..30)
    expect(bar(px, 10)).toEqual([27, 29]);
  });

  it('smear 0 keeps the held key frame frozen inside the span', async () => {
    const t = await harness([movingBarSource()]);
    const px = await frame(t, { smear: 0 }, 6); // the real bar is at x=12, the held frame 0 has it at x=0 (px 0..2)
    const [lo, hi] = bar(px, 10);
    expect(lo).toBe(0);
    expect(hi).toBeLessThanOrEqual(3);
  });

  it('with motion the held picture is dragged along instead of showing the new frame', async () => {
    const t = await harness([movingBarSource()]);
    const real = (await frame(t, {}, 14)); // outside span reference of what a clean frame looks like
    expect(real.at(5, 10)[0]).toBeLessThan(60);
    const px = await frame(t, { smear: 1 }, 6);
    const clean = await frame(t, { holdLength: 0 }, 6); // real frame 6: bar px 11..14
    let diff = 0;
    for (let x = 0; x < 32; x++) diff += Math.abs(px.at(x, 10)[0] - clean.at(x, 10)[0]);
    expect(diff).toBeGreaterThan(200); // the mosh does not match the real frame
    const [lo] = bar(px, 10);
    expect(lo).toBeGreaterThanOrEqual(0); // there is still picture content (not black)
  });

  it('refreshing key frames pull the picture back to the real frame', async () => {
    const t = await harness([movingBarSource()]);
    const clean = await frame(t, { holdLength: 0 }, 6);
    const refreshed = await frame(t, { smear: 0, refreshEvery: 2 }, 6); // k=6, 6%2=0 -> a fresh key frame: the real frame
    for (let x = 0; x < 32; x++) expect(refreshed.at(x, 10)[0]).toBe(clean.at(x, 10)[0]);
    const limited = await frame(t, { smear: 0, maxFrames: 2 }, 6); // only 2 frames of history: starts from frame 4 (bar px 7..10)
    expect(bar(limited, 10)[0]).toBe(7);
  });

  it('wraps around the loop: a span that starts near the end continues at frame 0', async () => {
    const t = await harness([movingBarSource()]);
    const px = await frame(t, { holdStart: 0.9, holdLength: 0.2, smear: 0 }, 1); // key frame 18 (bar at x=36%32=4: px 3..6)
    expect(bar(px, 10)[0]).toBe(3);
  });

  it('a still picture comes back unchanged; length 0 is off', async () => {
    const t = await harness();
    const src = t.checker(32, 32, 4);
    const px = await t.pixels((await t.run('datamosh', { ...base }, { image: src }, { seconds: 0.5 })).image as never);
    const ref = await t.pixels(src);
    expect(Array.from(px.data)).toEqual(Array.from(ref.data));
    expect((await t.run('datamosh', { holdLength: 0 }, { image: src })).image).toBe(src);
  });
});
