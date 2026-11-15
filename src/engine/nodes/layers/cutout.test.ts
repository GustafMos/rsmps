import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

describe('cutout', () => {
  it('multiplies alpha by the mask and keeps colour', async () => {
    const t = await harness();
    const img = t.fromFn(32, 32, (x) => (x < 16 ? [200, 50, 40, 255] : [200, 50, 40, 128]));
    const mask = t.maskFn(32, 32, (x) => (x < 8 ? 1 : x < 24 ? 0.5 : 0));
    const px = await t.pixels((await t.run('cutout', { decontaminate: 0 }, { image: img, mask })).image as never);
    expect(px.at(2, 5)[3]).toBe(255);
    expect(px.at(2, 5).slice(0, 3)).toEqual([200, 50, 40]);
    expect(px.at(12, 5)[3]).toBeGreaterThan(120);
    expect(px.at(12, 5)[3]).toBeLessThan(136);
    expect(px.at(20, 5)[3]).toBeGreaterThan(55); // 128 * 0.5
    expect(px.at(20, 5)[3]).toBeLessThan(72);
    expect(px.at(30, 5)[3]).toBe(0);
  });

  it('invert, shrink and feather', async () => {
    const t = await harness();
    const img = t.solid(48, 48, [90, 160, 60, 255]);
    const mask = t.maskFn(48, 48, (x, y) => (x >= 12 && x < 36 && y >= 12 && y < 36 ? 1 : 0));
    const inv = await t.pixels((await t.run('cutout', { invert: true, decontaminate: 0 }, { image: img, mask })).image as never);
    expect(inv.at(24, 24)[3]).toBe(0);
    expect(inv.at(3, 3)[3]).toBe(255);
    const shr = await t.pixels((await t.run('cutout', { shrink: 3, decontaminate: 0 }, { image: img, mask })).image as never);
    expect(shr.at(13, 24)[3]).toBe(0);
    expect(shr.at(24, 24)[3]).toBe(255);
    const fea = await t.pixels((await t.run('cutout', { feather: 4, decontaminate: 0 }, { image: img, mask })).image as never);
    expect(fea.at(12, 24)[3]).toBeGreaterThan(40);
    expect(fea.at(12, 24)[3]).toBeLessThan(220);
  });

  it('decontaminate pulls interior colour into the semi-transparent fringe', async () => {
    const t = await harness();
    // Red subject, a yellow-green fringe (old background bleeding in), then background.
    const img = t.fromFn(48, 8, (x) => (x < 20 ? [220, 30, 30, 255] : x < 26 ? [200, 200, 40, 255] : [40, 200, 40, 255]));
    const mask = t.maskFn(48, 8, (x) => (x < 20 ? 1 : x < 26 ? 1 - (x - 19) / 7 : 0));
    const raw = await t.pixels((await t.run('cutout', { decontaminate: 0 }, { image: img, mask })).image as never);
    const clean = await t.pixels((await t.run('cutout', { decontaminate: 1 }, { image: img, mask })).image as never);
    // straight colour of an edge pixel: green channel should drop a lot once decontaminated
    expect(raw.at(23, 3)[1]).toBeGreaterThan(150);
    expect(clean.at(23, 3)[1]).toBeLessThan(90);
    expect(clean.at(23, 3)[0]).toBeGreaterThan(190);
    expect(clean.at(23, 3)[3]).toBe(raw.at(23, 3)[3]); // alpha unchanged
  });
});

describe('cutout resolution independence', () => {
  it('shrink is the same fraction of the image at 2x (unit 2)', async () => {
    const t = await harness();
    const sq = (n: number, unit: number) => ({
      img: t.solid(n, n, [90, 160, 60, 255], unit),
      mask: t.maskFn(n, n, (x, y) => (x >= n / 4 && x < (3 * n) / 4 && y >= n / 4 && y < (3 * n) / 4 ? 1 : 0), unit),
    });
    const s1 = sq(48, 1);
    const s2 = sq(96, 2);
    const a = await t.pixels((await t.run('cutout', { shrink: 3, decontaminate: 0 }, { image: s1.img, mask: s1.mask })).image as never);
    const b = await t.pixels((await t.run('cutout', { shrink: 3, decontaminate: 0 }, { image: s2.img, mask: s2.mask })).image as never);
    expect(a.at(13, 24)[3]).toBe(0); // 12 + 1 < 12 + 3
    expect(b.at(26, 48)[3]).toBe(0); // 24 + 2 < 24 + 6
    expect(a.at(16, 24)[3]).toBe(255);
    expect(b.at(32, 48)[3]).toBe(255);
  });
});
