import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { artSize } from './pixelate.node';

describe('pixelate', () => {
  it('art size comes from the params and the aspect only', () => {
    expect(artSize('fixed-height', 16, 1, 128, 96)).toEqual({ width: 21, height: 16 });
    expect(artSize('fixed-width', 32, 1, 128, 96)).toEqual({ width: 32, height: 24 });
    expect(artSize('short-side', 24, 1, 128, 96)).toEqual({ width: 32, height: 24 });
    expect(artSize('block-size', 0, 8, 128, 96)).toEqual({ width: 16, height: 12 });
    expect(artSize('fixed-height', 16, 1, 256, 192)).toEqual(artSize('fixed-height', 16, 1, 128, 96));
  });

  it('plain mode averages each cell exactly and outputs unit 1', async () => {
    const t = await harness();
    // 64x64 checker with 8px squares, art grid 8x8 aligned with the squares.
    const out = await t.run('pixelate', { mode: 'fixed-height', value: 8, edgeAware: false, colorBlend: 0, preBlur: 0, sharpen: 0 }, { image: t.checker(64, 64, 8, 4) });
    const img = out.image as { width: number; height: number; unit: number };
    expect([img.width, img.height, img.unit]).toEqual([8, 8, 1]);
    const px = await t.pixels(out.image as never);
    let wrong = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const want = (x + y) % 2 ? 255 : 0;
        if (Math.abs(px.data[(y * 8 + x) * 4] - want) > 2) wrong++;
      }
    }
    expect(wrong).toBe(0);
  });

  it('a 2x larger copy of the same picture gives the same grid and nearly the same pixels (units 1 vs 2)', async () => {
    const t = await harness();
    const small = t.scene(128, 96, 1);
    const big = t.scene(256, 192, 2);
    for (const params of [
      { mode: 'fixed-height', value: 24, edgeAware: false },
      { mode: 'fixed-height', value: 24, edgeAware: true },
    ]) {
      const a = (await t.run('pixelate', params, { image: small })).image as never;
      const b = (await t.run('pixelate', params, { image: big })).image as never;
      const pa = await t.pixels(a);
      const pb = await t.pixels(b);
      expect([pa.width, pa.height]).toEqual([pb.width, pb.height]);
      expect([pa.width, pa.height]).toEqual([32, 24]);
      expect(await t.diff(a, b)).toBeLessThan(6);
    }
  });

  it('the grid stays the same when the playback proxy shrinks the input (not in block mode)', async () => {
    const t = await harness();
    // Proxy: input at half resolution, unit halves with it.
    const half = t.scene(64, 64, 0.5);
    const full = t.scene(128, 128, 1);
    const a = (await t.run('pixelate', { mode: 'short-side', value: 16 }, { image: half })).image as never;
    const b = (await t.run('pixelate', { mode: 'short-side', value: 16 }, { image: full })).image as never;
    expect(await t.diff(a, b)).toBeLessThan(6);
  });

  it('block-size mode follows the media scale (unit), so mixed resolutions match', async () => {
    const t = await harness();
    const a = (await t.run('pixelate', { mode: 'block-size', blockSize: 8 }, { image: t.scene(64, 64, 1) })).image as { width: number };
    const b = (await t.run('pixelate', { mode: 'block-size', blockSize: 8 }, { image: t.scene(128, 128, 2) })).image as { width: number };
    expect(a.width).toBe(8);
    expect(b.width).toBe(8);
  });

  it('edge-aware sampling keeps a misaligned edge crisp; the plain average smears it', async () => {
    const t = await harness();
    // 64x16, white from x=33. Art width 8 -> cells of 8px: cell 4 covers 32..40 and has the edge 1px inside it.
    const img = t.fromFn(64, 16, (x) => (x >= 33 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const base = { mode: 'fixed-width', value: 8, colorBlend: 0, preBlur: 0, sharpen: 0 };
    const plain = await t.pixels((await t.run('pixelate', { ...base, edgeAware: false }, { image: img })).image as never);
    const aware = await t.pixels((await t.run('pixelate', { ...base, edgeAware: true, alignment: 1, edgeThreshold: 0.6 }, { image: img })).image as never);
    expect(plain.at(4, 0)[0]).toBeLessThan(235);
    expect(aware.at(4, 0)[0]).toBeGreaterThan(plain.at(4, 0)[0] + 10);
    expect(aware.at(3, 0)[0]).toBeLessThan(10);
  });

  it('dominant colour mode picks the majority colour of a cell instead of a blend', async () => {
    const t = await harness();
    // Each 8x8 cell: left 3 columns red, right 5 columns blue.
    const img = t.fromFn(32, 8, (x) => (x % 8 < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const base = { mode: 'fixed-width', value: 4, edgeAware: false, preBlur: 0, sharpen: 0 };
    const avg = await t.pixels((await t.run('pixelate', { ...base, colorBlend: 0 }, { image: img })).image as never);
    const dom = await t.pixels((await t.run('pixelate', { ...base, colorBlend: 1 }, { image: img })).image as never);
    expect(avg.at(1, 0)[0]).toBeGreaterThan(60); // purple-ish mix
    expect(dom.at(1, 0)[0]).toBeLessThan(20);
    expect(dom.at(1, 0)[2]).toBeGreaterThan(235);
  });

  it('keeps transparency', async () => {
    const t = await harness();
    const img = t.fromFn(32, 32, (x) => (x < 16 ? [0, 0, 0, 0] : [200, 100, 50, 255]));
    const px = await t.pixels((await t.run('pixelate', { mode: 'fixed-height', value: 8, edgeAware: false, sharpen: 0 }, { image: img })).image as never);
    expect(px.at(0, 3)[3]).toBe(0);
    expect(px.at(7, 3)[3]).toBe(255);
    expect(px.at(7, 3)[0]).toBeGreaterThan(190);
  });
});

describe('pixelate silhouette', () => {
  it('crisp (default): hard alpha, no dark fringe; soft keeps partial alpha', async () => {
    const t = await harness();
    // Anti-aliased orange disc on transparent background (premultiplied-correct edge).
    const img = t.fromFn(256, 256, (x, y) => {
      const d = Math.hypot(x - 128, y - 128);
      const cov = Math.min(1, Math.max(0, 90 - d));
      return [230, 120, 20, Math.round(cov * 255)];
    });
    const crisp = await t.pixels((await t.run('pixelate', { mode: 'fixed-height', value: 16 }, { image: img })).image as never);
    let partial = 0;
    let dark = 0;
    let opaque = 0;
    for (let i = 0; i < 256; i++) {
      const a = crisp.data[i * 4 + 3];
      if (a !== 0 && a !== 255) partial++;
      if (a === 255) {
        opaque++;
        if (crisp.data[i * 4] < 215) dark++;
      }
    }
    expect(partial).toBe(0);
    expect(opaque).toBeGreaterThan(60);
    expect(dark).toBe(0);
    const soft = await t.pixels((await t.run('pixelate', { mode: 'fixed-height', value: 16, edges: 'soft' }, { image: img })).image as never);
    let mid = 0;
    for (let i = 0; i < 256; i++) if (soft.data[i * 4 + 3] > 10 && soft.data[i * 4 + 3] < 245) mid++;
    expect(mid).toBeGreaterThan(5);
  });
});
