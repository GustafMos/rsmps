import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

const bump = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => {
  const v = Math.max(0, 1 - Math.hypot(x - w / 2, y - h / 2) / (w * 0.25));
  const c = Math.round(v * 255);
  return [c, c, c, 255];
};
const flat0 = { glow: 0, thickness: 2, amount: 0, smoothing: 0, modulate: 0 };

/** y positions of lit pixels (green channel > 128) down one column */
function litRows(px: { at(x: number, y: number): number[]; height: number }, x: number): number[] {
  const rows: number[] = [];
  for (let y = 0; y < px.height; y++) if (px.at(x, y)[1] > 128) rows.push(y);
  return rows;
}
/** centres of runs of lit pixels */
function runs(rows: number[]): number[] {
  const out: number[] = [];
  let start = -1;
  rows.forEach((y, i) => {
    if (start < 0) start = y;
    if (i === rows.length - 1 || rows[i + 1] !== y + 1) {
      out.push((start + y) / 2);
      start = -1;
    }
  });
  return out;
}

describe('line-modulation', () => {
  it('with no displacement it draws evenly spaced straight lines', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 16, lineColor: [0, 1, 0, 1] }, { image: t.solid(64, 64, [128, 128, 128, 255]) })).image as never);
    const centres = runs(litRows(px, 20));
    expect(centres.length).toBe(16);
    expect(centres[1] - centres[0]).toBeCloseTo(4, 0);
    expect(px.at(20, 2 + 0)[0]).toBeLessThan(10); // red channel off: line is green
  });

  it('bright areas push lines up; the same line stays straight over dark areas', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, bump(64, 64));
    const px = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 4, amount: 12, lineColor: [0, 1, 0, 1], contrast: 1 }, { image: src })).image as never);
    const edge = runs(litRows(px, 2));
    const mid = runs(litRows(px, 32));
    // the line that crosses the middle (centre of the picture) is displaced upward by ~10px
    const crossing = mid.map((y) => edge.reduce((best, e) => (Math.abs(e - y) < Math.abs(best - y) ? e : best), edge[0]) - y);
    expect(Math.max(...crossing)).toBeGreaterThan(3);
  });

  it('a wired height image drives the relief instead of the picture', async () => {
    const t = await harness();
    const src = t.solid(64, 64, [128, 128, 128, 255]);
    const height = t.fromFn(64, 64, bump(64, 64));
    const px = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 8, amount: 10, lineColor: [0, 1, 0, 1] }, { image: src, height })).image as never);
    const mid = runs(litRows(px, 32));
    const edge = runs(litRows(px, 2));
    expect(mid.length).toBeGreaterThan(0);
    const shift = Math.max(...mid.map((y) => Math.min(...edge.map((e) => Math.abs(e - y)))));
    expect(shift).toBeGreaterThan(0.5);
    const flat = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 8, amount: 10, lineColor: [0, 1, 0, 1] }, { image: src })).image as never);
    expect(runs(litRows(flat, 32)).length).toBe(runs(litRows(flat, 2)).length);
  });

  it('occlusion hides lines behind a raised ridge', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, bump(64, 64));
    const p = { ...flat0, lineCount: 24, amount: 30, lineColor: [0, 1, 0, 1], background: [0, 0, 0, 1] };
    const open = await t.pixels((await t.run('line-modulation', { ...p, occlusion: false }, { image: src })).image as never);
    const hidden = await t.pixels((await t.run('line-modulation', { ...p, occlusion: true }, { image: src })).image as never);
    expect(litRows(hidden, 32).length).toBeLessThan(litRows(open, 32).length);
  });

  it('can take line colour from the picture, and a transparent background stays transparent', async () => {
    const t = await harness();
    const src = t.solid(64, 64, [255, 40, 40, 255]);
    const px = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 8, colorMode: 'source', background: [0, 0, 0, 0] }, { image: src })).image as never);
    let lit: number[] | null = null;
    let gap: number[] | null = null;
    for (let y = 0; y < 64; y++) {
      const c = px.at(20, y);
      if (c[3] > 200 && !lit) lit = c.slice();
      if (c[3] === 0 && !gap) gap = c.slice();
    }
    expect(lit).not.toBeNull();
    expect(lit![0]).toBeGreaterThan(lit![1] + 80);
    expect(gap).not.toBeNull();
  });

  it('vertical lines at 90 degrees', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 8, angle: 90, lineColor: [0, 1, 0, 1] }, { image: t.solid(64, 64, [128, 128, 128, 255]) })).image as never);
    const colLit = Array.from({ length: 64 }, (_, x) => (px.at(x, 20)[1] > 128 ? x : -1)).filter((x) => x >= 0);
    expect(runs(colLit).length).toBe(8);
    expect(px.at(2, 10)[1]).toBe(px.at(2, 40)[1]);
  });

  it('glow lights the space around a line', async () => {
    const t = await harness();
    const src = t.solid(64, 64, [128, 128, 128, 255]);
    const a = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 4, glow: 0 }, { image: src })).image as never);
    const b = await t.pixels((await t.run('line-modulation', { ...flat0, lineCount: 4, glow: 2, glowRadius: 4 }, { image: src })).image as never);
    let sa = 0;
    let sb = 0;
    for (let y = 0; y < 64; y++) { sa += a.at(10, y)[1]; sb += b.at(10, y)[1]; }
    expect(sb).toBeGreaterThan(sa * 1.5);
  });

  it('thickness and displacement follow resolution', async () => {
    const t = await harness();
    const d = await resolutionDiff(t, 'line-modulation', { lineCount: 8, amount: 6, thickness: 2, glow: 0, smoothing: 1 }, bump);
    expect(d).toBeLessThan(14);
  });
});
