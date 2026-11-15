import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('pixel-sort', () => {
  it('sorts a row of shuffled greys into ascending brightness inside the window', async () => {
    const t = await harness();
    const order = [9, 3, 12, 1, 7, 14, 5, 0, 11, 2, 8, 15, 4, 10, 6, 13];
    const src = t.fromFn(16, 4, (x) => { const v = 40 + order[x] * 10; return [v, v, v, 255]; });
    const px = await t.pixels((await t.run('pixel-sort', { low: 0, high: 1, passes: 40 }, { image: src })).image as never);
    const row = Array.from({ length: 16 }, (_, x) => px.at(x, 2)[0]);
    expect(row).toEqual([...row].sort((a, b) => a - b));
    expect(new Set(row).size).toBe(16);
  });

  it('pixels outside the window stay put and split the row into separate runs', async () => {
    const t = await harness();
    // bright (255) separators at x=5 and x=10 are outside the window (high=0.9)
    const vals = [200, 50, 120, 80, 150, 255, 90, 30, 170, 60, 255, 140, 20, 110, 70, 180];
    const src = t.fromFn(16, 2, (x) => [vals[x], vals[x], vals[x], 255]);
    const px = await t.pixels((await t.run('pixel-sort', { low: 0, high: 0.9, passes: 30 }, { image: src })).image as never);
    expect(px.at(5, 0)[0]).toBe(255);
    expect(px.at(10, 0)[0]).toBe(255);
    const a = Array.from({ length: 5 }, (_, x) => px.at(x, 0)[0]);
    const b = Array.from({ length: 4 }, (_, x) => px.at(6 + x, 0)[0]);
    const c = Array.from({ length: 5 }, (_, x) => px.at(11 + x, 0)[0]);
    for (const run of [a, b, c]) expect(run).toEqual([...run].sort((x, y) => x - y));
    expect(Math.max(...a)).toBeLessThanOrEqual(200);
    expect([...a].sort()).toEqual([200, 50, 120, 80, 150].sort());
  });

  it('descending and vertical directions, sort-by-hue', async () => {
    const t = await harness();
    const order = [5, 2, 7, 0, 3, 6, 1, 4];
    const src = t.fromFn(4, 8, (x, y) => { const v = 30 + order[y] * 25; return [v, v, v, 255]; });
    const px = await t.pixels((await t.run('pixel-sort', { low: 0, high: 1, passes: 20, direction: 'vertical', descending: true }, { image: src })).image as never);
    const col = Array.from({ length: 8 }, (_, y) => px.at(1, y)[0]);
    expect(col).toEqual([...col].sort((a, b) => b - a));
    const colours: [number, number, number][] = [[0, 0, 255], [255, 0, 0], [0, 255, 0], [255, 255, 0]];
    const hueSrc = t.fromFn(4, 2, (x) => [...colours[x], 255] as [number, number, number, number]);
    const hp = await t.pixels((await t.run('pixel-sort', { low: 0, high: 1, passes: 8, key: 'hue' }, { image: hueSrc })).image as never);
    expect(hp.at(0, 0)[0]).toBe(255); // red (hue 0) first
    expect(hp.at(3, 0)[2]).toBe(255); // blue (hue 0.67) last
  });

  it('keeps alpha, and more passes give longer streaks', async () => {
    const t = await harness();
    const clear = await t.pixels((await t.run('pixel-sort', {}, { image: t.solid(8, 8, [100, 100, 100, 0]) })).image as never);
    expect(clear.at(2, 2)[3]).toBe(0);
    const ramp = t.fromFn(64, 2, (x) => { const v = 20 + ((x * 37) % 64) * 3; return [v, v, v, 255]; });
    const few = await t.pixels((await t.run('pixel-sort', { low: 0, high: 1, passes: 4 }, { image: ramp })).image as never);
    const many = await t.pixels((await t.run('pixel-sort', { low: 0, high: 1, passes: 80 }, { image: ramp })).image as never);
    const inversions = (p: typeof few) => { let n = 0; for (let x = 1; x < 64; x++) if (p.at(x, 0)[0] < p.at(x - 1, 0)[0]) n++; return n; };
    expect(inversions(many)).toBeLessThan(inversions(few));
    expect(inversions(many)).toBe(0);
  });
});
