import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { movingBarSource, timeChain } from '../../lib/fx-testutil';

describe('rgb-delay', () => {
  it('red lags, blue leads: a moving bar gets a rainbow time smear', async () => {
    const t = await harness([movingBarSource()]);
    const { graph, node } = timeChain(t, 'fx-moving-bar', 'rgb-delay', { redFrames: -2, greenFrames: 0, blueFrames: 2 });
    const px = await t.pixels((await t.evalGraph(graph, node, { seconds: 1 })) as never); // frame 10: bar at 20; red from frame 8 (16), blue from 12 (24)
    expect(px.at(16, 8)[0]).toBeGreaterThan(200);
    expect(px.at(16, 8)[2]).toBeLessThan(60);
    expect(px.at(24, 8)[2]).toBeGreaterThan(200);
    expect(px.at(24, 8)[0]).toBeLessThan(60);
    expect(px.at(20, 8)[1]).toBeGreaterThan(200);
    expect(px.at(20, 8)[0]).toBeLessThan(60);
  });

  it('wraps around the loop at frame 0', async () => {
    const t = await harness([movingBarSource()]);
    const { graph, node } = timeChain(t, 'fx-moving-bar', 'rgb-delay', { redFrames: -2, greenFrames: 0, blueFrames: 0 });
    const px = await t.pixels((await t.evalGraph(graph, node, { seconds: 0 })) as never); // frame 0 red from frame 18: bar at 36 % 32 = 4
    expect(px.at(4, 8)[0]).toBeGreaterThan(200);
    expect(px.at(4, 8)[1]).toBeLessThan(60);
  });

  it('spatial offsets split the channels of a still picture; zero offsets are a no-op', async () => {
    const t = await harness();
    const src = t.fromFn(32, 8, (x) => (Math.abs(x - 16) < 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const px = await t.pixels((await t.run('rgb-delay', { redFrames: 0, blueFrames: 0, redX: 4, blueX: -4 }, { image: src })).image as never);
    expect(px.at(12, 4)[0]).toBeGreaterThan(px.at(12, 4)[2] + 150); // red copy sampled from the right shows at the left edge
    expect(px.at(20, 4)[2]).toBeGreaterThan(px.at(20, 4)[0] + 150);
    const same = await t.run('rgb-delay', { redFrames: 0, blueFrames: 0 }, { image: src });
    expect(same.image).toBe(src);
  });

  it('keeps alpha', async () => {
    const t = await harness();
    const clear = await t.pixels((await t.run('rgb-delay', { redFrames: 0, blueFrames: 0, redX: 3 }, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
    expect(clear.at(3, 3)[3]).toBe(0);
  });
});
