import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { movingBarSource, timeChain } from '../../lib/fx-testutil';

const dot = (x0: number, y0: number, col: [number, number, number] = [255, 255, 255]) => (x: number, y: number): [number, number, number, number] =>
  Math.abs(x - x0) < 1.5 && Math.abs(y - y0) < 1.5 ? [col[0], col[1], col[2], 255] : [0, 0, 0, 255];
const base = { mode: 'still', darken: 0, decay: 0.5, echoes: 3, offsetX: 6, offsetY: 0 };

describe('feedback-trail', () => {
  it('still mode: echoes are shifted, fading copies', async () => {
    const t = await harness();
    const src = t.fromFn(48, 16, dot(8, 8));
    const px = await t.pixels((await t.run('feedback-trail', base, { image: src })).image as never);
    expect(px.at(8, 8)[0]).toBe(255);
    expect(px.at(14, 8)[0]).toBeGreaterThan(115);
    expect(px.at(14, 8)[0]).toBeLessThan(140);
    expect(px.at(20, 8)[0]).toBeGreaterThan(55);
    expect(px.at(20, 8)[0]).toBeLessThan(75);
    expect(px.at(26, 8)[0]).toBeGreaterThan(25);
    expect(px.at(32, 8)[0]).toBeLessThan(5); // only 3 echoes
  });

  it('echoes darken, shift hue and rotate/scale around the pivot', async () => {
    const t = await harness();
    const src = t.fromFn(48, 16, dot(8, 8, [255, 0, 0]));
    const dark = await t.pixels((await t.run('feedback-trail', { ...base, decay: 1, darken: 0.5 }, { image: src })).image as never);
    expect(dark.at(14, 8)[0]).toBeGreaterThan(110);
    expect(dark.at(14, 8)[0]).toBeLessThan(145);
    const hue = await t.pixels((await t.run('feedback-trail', { ...base, decay: 1, hueShift: 120 }, { image: src })).image as never);
    expect(hue.at(14, 8)[1]).toBeGreaterThan(hue.at(14, 8)[0]);
    const big = t.fromFn(48, 48, (x, y) => (Math.hypot(x - 24, y - 24) < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const grown = await t.pixels((await t.run('feedback-trail', { ...base, offsetX: 0, scale: 1.5, echoes: 1, decay: 1 }, { image: big })).image as never);
    expect(grown.at(24 + 5, 24)[0]).toBeGreaterThan(200); // beyond the original radius 4
    expect(grown.at(24 + 8, 24)[0]).toBeLessThan(40);
  });

  it('blend modes: add brightens overlaps, behind keeps the front sprite on top', async () => {
    const t = await harness();
    const src = t.fromFn(48, 16, (x, y) => (Math.abs(x - 8) < 3 && Math.abs(y - 8) < 3 ? [100, 100, 100, 255] : [0, 0, 0, 0]));
    const add = await t.pixels((await t.run('feedback-trail', { ...base, blend: 'add', offsetX: 2, decay: 1, echoes: 2 }, { image: src })).image as never);
    expect(add.at(8, 8)[0]).toBeGreaterThan(190);
    const behind = await t.pixels((await t.run('feedback-trail', { ...base, blend: 'behind', offsetX: 8, decay: 0.5, echoes: 1 }, { image: src })).image as never);
    expect(behind.at(8, 8).slice(0, 4)).toEqual([100, 100, 100, 255]);
    expect(behind.at(16, 8)[3]).toBeGreaterThan(100);
    expect(behind.at(40, 8)[3]).toBe(0);
  });

  it('blur growth softens later echoes', async () => {
    const t = await harness();
    const src = t.fromFn(64, 16, dot(8, 8));
    const crisp = await t.pixels((await t.run('feedback-trail', { ...base, decay: 1, blurGrowth: 0, echoes: 3 }, { image: src })).image as never);
    const soft = await t.pixels((await t.run('feedback-trail', { ...base, decay: 1, blurGrowth: 3, echoes: 3 }, { image: src })).image as never);
    expect(soft.at(26, 8)[0]).toBeLessThan(crisp.at(26, 8)[0] - 20);
    expect(soft.at(26, 12)[0]).toBeGreaterThan(crisp.at(26, 12)[0]);
  });

  it('time mode pulls earlier frames of moving footage, and wraps around the loop', async () => {
    const t = await harness([movingBarSource()]);
    const params = { mode: 'time', echoes: 2, spacing: 2, decay: 0.6, darken: 0, offsetX: 0 };
    const at = async (seconds: number) => {
      const { graph, node } = timeChain(t, 'fx-moving-bar', 'feedback-trail', params);
      return t.pixels((await t.evalGraph(graph, node, { seconds })) as never);
    };
    // frame 10: bar at x=20 (px 19..22). Echo 1 = frame 8 (bar at 16: px 15..18), echo 2 = frame 6 (bar at 12)
    const px = await at(1);
    expect(px.at(20, 10)[0]).toBeGreaterThan(240);
    expect(px.at(16, 10)[0]).toBeGreaterThan(130);
    expect(px.at(12, 10)[0]).toBeGreaterThan(70);
    // frame 0: echoes come from the end of the loop (frames 18 and 16: bars at 4 and 0)
    const first = await at(0);
    expect(first.at(5, 10)[0]).toBeGreaterThan(100);
  });

  it('still mode never reads the clock (stays cached)', async () => {
    const t = await harness();
    const r = await t.loopCheck('feedback-trail', base, { image: t.fromFn(32, 32, dot(8, 8)) });
    expect(r.motion).toBe(0);
  });
});
