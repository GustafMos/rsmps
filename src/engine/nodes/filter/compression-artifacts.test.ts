import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const photo = (x: number, y: number): [number, number, number, number] => [
  120 + 100 * Math.sin(x / 11) * Math.cos(y / 13),
  110 + 90 * Math.cos(x / 9 + y / 17),
  100 + 100 * Math.sin((x + y) / 14),
  255,
];

describe('compression-artifacts', () => {
  it('quality 100 is nearly lossless, low quality is not', async () => {
    const t = await harness();
    const src = t.fromFn(64, 48, photo);
    const hi = await t.run('compression-artifacts', { quality: 100 }, { image: src });
    const lo = await t.run('compression-artifacts', { quality: 5 }, { image: src });
    expect(await t.diff(src, hi.image as never)).toBeLessThan(3);
    expect(await t.diff(src, lo.image as never)).toBeGreaterThan(5);
  });

  it('low quality makes visible 8x8 blocks on a smooth gradient', async () => {
    const t = await harness();
    const src = t.fromFn(64, 32, (x) => [x * 1.4 + 60, x * 1.4 + 60, x * 1.4 + 60, 255]);
    const px = await t.pixels((await t.run('compression-artifacts', { quality: 6, chroma: false }, { image: src })).image as never);
    const seams: number[] = [];
    const inners: number[] = [];
    for (let x = 1; x < 63; x++) (x % 8 === 0 ? seams : inners).push(Math.abs(px.at(x, 12)[0] - px.at(x - 1, 12)[0]));
    const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length;
    expect(mean(seams)).toBeGreaterThan(mean(inners) * 1.3);
  });

  it('ringing: values overshoot beside a hard edge', async () => {
    const t = await harness();
    const src = t.fromFn(32, 16, (x) => (x < 12 ? [60, 60, 60, 255] : [200, 200, 200, 255]));
    const px = await t.pixels((await t.run('compression-artifacts', { quality: 12, chroma: false }, { image: src })).image as never);
    const row = Array.from({ length: 32 }, (_, x) => px.at(x, 6)[0]);
    expect(Math.min(...row.slice(0, 12))).toBeLessThan(57);
    expect(Math.max(...row.slice(12))).toBeGreaterThan(203);
  });

  it('4:2:0 chroma subsampling smears colour across a hard colour edge', async () => {
    const t = await harness();
    const src = t.fromFn(48, 16, (x) => (x < 25 ? [200, 80, 80, 255] : [80, 80, 200, 255]));
    const on = await t.pixels((await t.run('compression-artifacts', { quality: 40, chroma: true }, { image: src })).image as never);
    const off = await t.pixels((await t.run('compression-artifacts', { quality: 40, chroma: false }, { image: src })).image as never);
    const dev = (p: typeof on) => Math.abs(p.at(24, 6)[0] - 200);
    expect(dev(on)).toBeGreaterThan(dev(off) + 10);
  });

  it('generations pile up damage when the grid shifts; odd sizes and alpha are fine', async () => {
    const t = await harness();
    const src = t.fromFn(37, 21, photo);
    const one = await t.run('compression-artifacts', { quality: 25, generations: 1 }, { image: src });
    const four = await t.run('compression-artifacts', { quality: 25, generations: 4 }, { image: src });
    expect((four.image as { width: number }).width).toBe(37);
    expect(await t.diff(src, four.image as never)).toBeGreaterThan(await t.diff(src, one.image as never));
    const a = await t.pixels((await t.run('compression-artifacts', {}, { image: t.solid(16, 16, [200, 100, 50, 128]) })).image as never);
    expect(a.at(5, 5)[3]).toBe(128);
  });
});
