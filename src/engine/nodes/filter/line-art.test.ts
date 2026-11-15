import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

/** a 3px dark line across a paper with a strong brightness gradient */
const gradSheet = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => {
  const paper = 120 + 130 * (x / w);
  const line = Math.abs(y - h / 2) < Math.max(1.5, h * 0.03);
  const v = line ? paper * 0.45 : paper;
  return [v, v, v, 255];
};
const base = { smooth: 0, background: [1, 1, 1, 1], lineColor: [0, 0, 0, 1], radius: 16 };

describe('line-art', () => {
  it('makes black lines on white paper regardless of uneven light', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('line-art', base, { image: t.fromFn(128, 64, gradSheet(128, 64)) })).image as never);
    for (const x of [20, 64, 110]) {
      expect(px.at(x, 32)[0], `line at ${x}`).toBeLessThan(40);
      expect(px.at(x, 10)[0], `paper at ${x}`).toBeGreaterThan(235);
    }
  });

  it('thicken grows strokes, negative values thin them', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x, y) => (Math.abs(y - 32) < 2.5 ? [30, 30, 30, 255] : [240, 240, 240, 255]));
    const width = (p: { at(x: number, y: number): number[] }) => { let c = 0; for (let y = 0; y < 64; y++) if (p.at(48, y)[0] < 128) c++; return c; };
    const plain = width(await t.pixels((await t.run('line-art', base, { image: src })).image as never));
    const fat = width(await t.pixels((await t.run('line-art', { ...base, thicken: 2 }, { image: src })).image as never));
    const thin = width(await t.pixels((await t.run('line-art', { ...base, thicken: -1 }, { image: src })).image as never));
    expect(fat).toBeGreaterThan(plain + 2);
    expect(thin).toBeLessThan(plain);
    expect(thin).toBeGreaterThan(0);
  });

  it('smoothing rounds a jagged staircase edge', async () => {
    const t = await harness();
    const stair = t.fromFn(96, 96, (x, y) => (y > Math.floor(x / 4) * 4 ? [20, 20, 20, 255] : [240, 240, 240, 255]));
    const rough = await t.pixels((await t.run('line-art', { ...base, radius: 40 }, { image: stair })).image as never);
    const smooth = await t.pixels((await t.run('line-art', { ...base, radius: 40, smooth: 3 }, { image: stair })).image as never);
    const mid = (p: typeof rough) => { let n = 0; for (let y = 10; y < 86; y++) for (let x = 10; x < 86; x++) { const v = p.at(x, y)[0]; if (v > 40 && v < 215) n++; } return n; };
    expect(mid(rough)).toBe(0); // hard threshold: only two values
    expect(mid(smooth)).toBeGreaterThan(20); // smoothed edge is anti-aliased
  });

  it('recolours lines, supports transparent paper, and can keep coloured fills', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x, y) => (Math.abs(y - 32) < 2 ? [20, 20, 20, 255] : x > 60 && y < 20 ? [230, 120, 120, 255] : [245, 245, 245, 255]));
    const red = await t.pixels((await t.run('line-art', { ...base, lineColor: [1, 0, 0, 1], background: [1, 1, 1, 0] }, { image: src })).image as never);
    expect(red.at(30, 32)[0]).toBeGreaterThan(200);
    expect(red.at(30, 32)[1]).toBeLessThan(40);
    expect(red.at(30, 32)[3]).toBe(255);
    expect(red.at(30, 10)[3]).toBe(0);
    const fills = await t.pixels((await t.run('line-art', { ...base, mode: 'fills' }, { image: src })).image as never);
    expect(fills.at(80, 8)[0]).toBeGreaterThan(fills.at(80, 8)[2] + 40); // pink fill kept
    expect(fills.at(20, 8)[0]).toBeGreaterThan(235); // plain paper stays white
    expect(fills.at(30, 32)[0]).toBeLessThan(40);
  });

  it('window and thickness follow resolution', async () => {
    const t = await harness();
    const d = await resolutionDiff(t, 'line-art', { ...base, radius: 10, thicken: 1, smooth: 1 }, gradSheet, 48);
    expect(d).toBeLessThan(24);
  });
});
