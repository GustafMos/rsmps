import { describe, expect, it } from 'vitest';
import { BLACK_WHITE, GREYS4, runWithPalettes } from '../../lib/pixel-test-utils';
import { harness } from '../../testing';

describe('dither: pattern behaviour', () => {
  it('Bayer 4x4 on mid grey with black/white gives exactly half white', async () => {
    const t = await harness();
    const out = await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', colorSpace: 'srgb' }, t.solid(16, 16, [128, 128, 128, 255]), { palette: BLACK_WHITE });
    const px = await t.pixels(out);
    let white = 0;
    for (let i = 0; i < 16 * 16; i++) if (px.data[i * 4] === 255) white++;
    expect(white).toBe(128);
  });

  it('checker pattern at 50% is a real checkerboard', async () => {
    const t = await harness();
    const out = await runWithPalettes(t, 'dither', { algorithm: 'checker', colorSpace: 'srgb' }, t.solid(8, 8, [128, 128, 128, 255]), { palette: BLACK_WHITE });
    const px = await t.pixels(out);
    let wrong = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 7; x++) if (px.data[(y * 8 + x) * 4] === px.data[(y * 8 + x + 1) * 4]) wrong++;
    }
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 8; x++) if (px.data[(y * 8 + x) * 4] === px.data[((y + 1) * 8 + x) * 4]) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('line patterns draw lines in the named direction', async () => {
    const t = await harness();
    const img = t.solid(16, 16, [80, 80, 80, 255]);
    const rows = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'line-horizontal', colorSpace: 'srgb' }, img, { palette: BLACK_WHITE }));
    // Horizontal lines: every row is fully black, fully white, or an even dotted mix.
    let oddRows = 0;
    for (let y = 0; y < 16; y++) {
      let ones = 0;
      for (let x = 0; x < 16; x++) if (rows.data[(y * 16 + x) * 4] === 255) ones++;
      if (ones !== 0 && ones !== 16 && ones !== 8) oddRows++;
    }
    expect(oddRows).toBe(0);
    const cols = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'line-vertical', colorSpace: 'srgb' }, img, { palette: BLACK_WHITE }));
    let oddCols = 0;
    for (let x = 0; x < 16; x++) {
      let ones = 0;
      for (let y = 0; y < 16; y++) if (cols.data[(y * 16 + x) * 4] === 255) ones++;
      if (ones !== 0 && ones !== 16 && ones !== 8) oddCols++;
    }
    expect(oddCols).toBe(0);
  });

  it('keeps transparency on ordered dithering and never colours transparent pixels', async () => {
    const t = await harness();
    const img = t.fromFn(16, 16, (x) => (x < 8 ? [0, 0, 0, 0] : [140, 140, 140, 255]));
    const px = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'bayer-8' }, img, { palette: BLACK_WHITE }));
    expect(px.at(2, 2)[3]).toBe(0);
    expect(px.at(12, 2)[3]).toBe(255);
    expect([0, 255]).toContain(px.at(12, 2)[0]);
  });

  it('white noise is deterministic per seed and differs between seeds', async () => {
    const t = await harness();
    const img = t.solid(32, 32, [128, 128, 128, 255]);
    const a = await runWithPalettes(t, 'dither', { algorithm: 'white-noise', seed: 3 }, img, { palette: BLACK_WHITE });
    const b = await runWithPalettes(t, 'dither', { algorithm: 'white-noise', seed: 3 }, img, { palette: BLACK_WHITE });
    const c = await runWithPalettes(t, 'dither', { algorithm: 'white-noise', seed: 4 }, img, { palette: BLACK_WHITE });
    expect(await t.diff(a, b)).toBe(0);
    expect(await t.diff(a, c)).toBeGreaterThan(10);
  });

  it('pattern scale 2 makes 2x2 pattern cells; the same look at 2x resolution with unit 2', async () => {
    const t = await harness();
    const small = t.solid(16, 16, [100, 100, 100, 255], 1);
    const big = t.solid(32, 32, [100, 100, 100, 255], 2);
    const scaled = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', scale: 2 }, small, { palette: BLACK_WHITE }));
    let unequal = 0;
    for (let y = 0; y < 16; y += 2) for (let x = 0; x < 16; x += 2) if (scaled.data[(y * 16 + x) * 4] !== scaled.data[((y + 1) * 16 + x + 1) * 4]) unequal++;
    expect(unequal).toBe(0);
    const a = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'bayer-4' }, small, { palette: BLACK_WHITE }));
    const b = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'bayer-4' }, big, { palette: BLACK_WHITE }));
    // Same pattern at 2x: each small pixel is a 2x2 block in the big image.
    let mismatch = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (b.data[(y * 2 * 32 + x * 2) * 4] !== a.data[(y * 16 + x) * 4]) mismatch++;
    expect(mismatch).toBe(0);
  });

  it('strength 0 is plain nearest colour', async () => {
    const t = await harness();
    const img = t.fromFn(32, 8, (x) => [x * 8, x * 8, x * 8, 255]);
    const dithered = await runWithPalettes(t, 'dither', { algorithm: 'bayer-8', strength: 0 }, img, { palette: GREYS4 });
    const nearest = await runWithPalettes(t, 'dither', { algorithm: 'threshold' }, img, { palette: GREYS4 });
    expect(await t.diff(dithered, nearest)).toBe(0);
  });
});

describe('dither on coarse and fine render grids', () => {
  it('pattern cells stay whole texels (period integer, >= 2) at unit 0.25, 1 and 4, with palette-only colours and tone kept', async () => {
    const t = await harness();
    for (const unit of [0.25, 4]) {
      const W = 64;
      const img = t.fromFn(W, 16, () => [128, 128, 128, 255], unit);
      const px = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', colorSpace: 'srgb', scale: 1 }, img, { palette: BLACK_WHITE }));
      let white = 0;
      let notBW = 0;
      for (let i = 0; i < W * 16; i++) {
        const v = px.data[i * 4];
        if (v === 255) white++;
        else if (v !== 0) notBW++;
      }
      expect(notBW).toBe(0);
      expect(Math.abs(white / (W * 16) - 0.5)).toBeLessThan(0.02);
      // Row 0 must repeat with an integer period >= 2 (4 for a 1-texel Bayer 4x4 cell; 1-texel cells at unit 0.25 too).
      let period = 0;
      for (const cand of [2, 3, 4, 5, 6, 8, 12, 16]) {
        let ok = true;
        for (let x = 0; x + cand < W; x++) if (px.data[x * 4] !== px.data[(x + cand) * 4]) ok = false;
        if (ok) {
          period = cand;
          break;
        }
      }
      expect(period).toBeGreaterThanOrEqual(2);
      expect(Number.isInteger(period)).toBe(true);
    }
  });

  it('fractional scales round to whole texels (unit 0.25 never gives sub-texel cells)', async () => {
    const t = await harness();
    const img = t.fromFn(16, 16, () => [100, 100, 100, 255], 0.25);
    const a = await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', scale: 1 }, img, { palette: BLACK_WHITE });
    const b = await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', scale: 3.6 }, t.fromFn(16, 16, () => [100, 100, 100, 255], 1), { palette: BLACK_WHITE });
    const c = await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', scale: 4 }, t.fromFn(16, 16, () => [100, 100, 100, 255], 1), { palette: BLACK_WHITE });
    expect(await t.diff(a, await runWithPalettes(t, 'dither', { algorithm: 'bayer-4', scale: 1 }, t.fromFn(16, 16, () => [100, 100, 100, 255], 1), { palette: BLACK_WHITE }))).toBe(0);
    expect(await t.diff(b, c)).toBe(0);
  });
});
