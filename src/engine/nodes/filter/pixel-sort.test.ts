import { describe, expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';

const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const row = (p: { at(x: number, y: number): number[] }, y: number, w: number, ch = 0) => Array.from({ length: w }, (_, x) => p.at(x, y)[ch]);
const sortedAsc = (a: number[]) => a.every((v, i) => i === 0 || v >= a[i - 1]);
const ALL = { spans: 'brightness', low: 0, high: 1 };

describe('pixel-sort', () => {
  it('sorts a long row of random greys completely (span of 1500 pixels)', async () => {
    const t = await harness();
    const r = lcg(5);
    const vals = Array.from({ length: 1500 }, () => 20 + Math.floor(r() * 200));
    const src = t.fromFn(1500, 2, (x) => [vals[x], vals[x], vals[x], 255]);
    const px = await t.pixels((await t.run('pixel-sort', ALL, { image: src })).image as never);
    const out = row(px, 1, 1500);
    expect(sortedAsc(out)).toBe(true);
    expect([...out].sort((a, b) => a - b)).toEqual([...vals].sort((a, b) => a - b)); // a permutation: nothing lost
  });

  it('pixels outside the window stay put and split the row into separate runs', async () => {
    const t = await harness();
    const vals = [200, 50, 120, 80, 150, 255, 90, 30, 170, 60, 255, 140, 20, 110, 70, 180];
    const src = t.fromFn(16, 2, (x) => [vals[x], vals[x], vals[x], 255]);
    const px = await t.pixels((await t.run('pixel-sort', { spans: 'brightness', low: 0, high: 0.9 }, { image: src })).image as never);
    const out = row(px, 0, 16);
    expect(out[5]).toBe(255);
    expect(out[10]).toBe(255);
    for (const [a, b] of [[0, 5], [6, 10], [11, 16]]) {
      const seg = out.slice(a, b);
      expect(sortedAsc(seg)).toBe(true);
      expect([...seg].sort((x, y) => x - y)).toEqual([...vals.slice(a, b)].sort((x, y) => x - y));
    }
  });

  it('reverse order, columns, and sorting by hue', async () => {
    const t = await harness();
    const order = [5, 2, 7, 0, 3, 6, 1, 4];
    const src = t.fromFn(4, 8, (x, y) => { const v = 30 + order[y] * 25; return [v, v, v, 255]; });
    const px = await t.pixels((await t.run('pixel-sort', { ...ALL, direction: 'vertical', reverse: true }, { image: src })).image as never);
    const col = Array.from({ length: 8 }, (_, y) => px.at(1, y)[0]);
    expect(col).toEqual([...col].sort((a, b) => b - a));
    const colours: [number, number, number][] = [[0, 0, 255], [255, 0, 0], [0, 255, 0], [255, 255, 0]];
    const hueSrc = t.fromFn(4, 2, (x) => [...colours[x], 255] as [number, number, number, number]);
    const hp = await t.pixels((await t.run('pixel-sort', { ...ALL, key: 'hue' }, { image: hueSrc })).image as never);
    expect(hp.at(0, 0)[0]).toBe(255); // red (hue 0) first
    expect(hp.at(3, 0)[2]).toBe(255); // blue last
  });

  it('edge mode cuts spans at sharp changes', async () => {
    const t = await harness();
    const r = lcg(9);
    const vals = Array.from({ length: 64 }, (_, x) => (x < 32 ? 150 + Math.floor(r() * 100) : Math.floor(r() * 60)));
    const src = t.fromFn(64, 2, (x) => [vals[x], vals[x], vals[x], 255]);
    const out = row(await t.pixels((await t.run('pixel-sort', { spans: 'edges', edgeThreshold: 0.4 }, { image: src })).image as never), 0, 64);
    expect(sortedAsc(out.slice(0, 32))).toBe(true);
    expect(sortedAsc(out.slice(32))).toBe(true);
    expect(out[31]).toBeGreaterThan(out[32] + 50); // still a drop at the edge: not one big sort
  });

  it('random spans and the span mask', async () => {
    const t = await harness();
    const r = lcg(11);
    const vals = Array.from({ length: 200 }, () => Math.floor(r() * 250));
    const src = t.fromFn(200, 2, (x) => [vals[x], vals[x], vals[x], 255]);
    const rnd = row(await t.pixels((await t.run('pixel-sort', { spans: 'random', spanLength: 20 }, { image: src })).image as never), 0, 200);
    expect([...rnd].sort((a, b) => a - b)).toEqual([...vals].sort((a, b) => a - b));
    expect(sortedAsc(rnd)).toBe(false);
    expect(rnd).not.toEqual(vals);
    const mask = t.maskFn(200, 2, (x) => (x < 100 ? 1 : 0));
    const masked = row(await t.pixels((await t.run('pixel-sort', { spans: 'mask' }, { image: src, spanMask: mask })).image as never), 0, 200);
    expect(sortedAsc(masked.slice(0, 100))).toBe(true);
    expect(masked.slice(100)).toEqual(vals.slice(100));
  });

  it('smear drips the span start forward (or the end backward)', async () => {
    const t = await harness();
    const src = t.fromFn(32, 2, (x) => [x * 8, x * 8, x * 8, 255]);
    const fwd = row(await t.pixels((await t.run('pixel-sort', { ...ALL, mode: 'smear' }, { image: src })).image as never), 0, 32);
    expect(new Set(fwd)).toEqual(new Set([0]));
    const back = row(await t.pixels((await t.run('pixel-sort', { ...ALL, mode: 'smear-back' }, { image: src })).image as never), 0, 32);
    expect(new Set(back)).toEqual(new Set([248]));
    const part = row(await t.pixels((await t.run('pixel-sort', { spans: 'brightness', low: 0.2, high: 1, mode: 'smear' }, { image: src })).image as never), 0, 32);
    expect(part[0]).toBe(0);
    expect(part[10]).toBe(part[9]); // inside the window: dripped
    expect(part[3]).toBe(24); // below the window: untouched
  });

  it('lines longer than 2048 are sorted in pieces', async () => {
    const t = await harness();
    const r = lcg(3);
    const vals = Array.from({ length: 2100 }, () => Math.floor(r() * 250));
    const src = t.fromFn(2100, 2, (x) => [vals[x], vals[x], vals[x], 255]);
    const out = row(await t.pixels((await t.run('pixel-sort', ALL, { image: src })).image as never), 0, 2100);
    expect(sortedAsc(out.slice(0, 2048))).toBe(true);
    expect(sortedAsc(out.slice(2048))).toBe(true);
  });

  it('tilted sorting keeps the size and moves pixels along the tilted line; alpha survives', async () => {
    const t = await harness();
    const r = lcg(4);
    const src = t.fromFn(48, 48, () => { const v = Math.floor(r() * 250); return [v, v, v, 255]; });
    const out = await t.run('pixel-sort', { ...ALL, angle: 45 }, { image: src });
    const img = out.image as { width: number; height: number };
    expect([img.width, img.height]).toEqual([48, 48]);
    expect(await t.diff(src, out.image as never)).toBeGreaterThan(5);
    const clear = await t.pixels((await t.run('pixel-sort', {}, { image: t.solid(8, 8, [100, 100, 100, 0]) })).image as never);
    expect(clear.at(2, 2)[3]).toBe(0);
  });

  it('the window sweep animates and loops; still by default', async () => {
    const t = await harness();
    const src = t.fromFn(32, 8, (x) => { const v = Math.round((x / 31) * 255); return [v, v, v, 255]; });
    const off = await t.loopCheck('pixel-sort', { spans: 'brightness', low: 0.3, high: 0.6 }, { image: t.fromFn(32, 8, (x, y) => { const v = (x * 37 + y * 11) % 256; return [v, v, v, 255]; }) });
    expect(off.motion).toBe(0);
    const noisy = t.fromFn(32, 8, (x, y) => { const v = 50 + ((x * 7 + y * 13 + x * x) % 100); return [v, v, v, 255]; });
    const on = await t.loopCheck('pixel-sort', { spans: 'brightness', low: 0.3, high: 0.5, sweepCycles: 1, sweepAmount: 0.12 }, { image: noisy });
    expect(on.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(on.motion).toBeGreaterThan(0.5);
    void src;
  });
});
