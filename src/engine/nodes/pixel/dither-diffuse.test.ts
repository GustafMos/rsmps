import { describe, expect, it } from 'vitest';
import { DITHER_ALGORITHMS, diffuseImage } from '../../lib/pixel-dither-data';
import { GREYS4, checkGradient, runWithPalettes } from '../../lib/pixel-test-utils';
import { harness } from '../../testing';

// Several dither test files exist because headless WebGPU in this repo's test setup gets unstable after a few
// dozen evaluations per process (each file runs in its own process). Loops here count problems and assert once,
// to keep JS garbage low while GPU work is in flight.
describe('dither: error diffusion and palette blend', () => {
  it('every diffusion / blend algorithm on a gradient: only palette colours, alpha kept, tone preserved', async () => {
    const t = await harness();
    const ids = DITHER_ALGORITHMS.filter((a) => a.family === 'diffusion' || a.family === 'blend').map((a) => a.id);
    expect(await checkGradient(t, ids)).toEqual([]);
  }, 120000);
});

describe('dither: GPU error diffusion matches the CPU reference', () => {
  it('floyd-steinberg and riemersma give the same pixels as the CPU implementation', async () => {
    const t = await harness();
    const W = 48;
    const H = 24;
    const img = t.fromFn(W, H, (x, y) => [Math.round((x / (W - 1)) * 255), Math.round((y / (H - 1)) * 255), 120, 255]);
    const rgba = await t.gpu.read(img, true);
    const pal: [number, number, number][] = [...GREYS4, [0.9, 0.3, 0.2], [0.2, 0.4, 0.9]];
    const problems: string[] = [];
    for (const algorithm of ['floyd-steinberg', 'riemersma']) {
      const gpu = await t.pixels(await runWithPalettes(t, 'dither', { algorithm, colorSpace: 'srgb' }, img, { palette: pal }));
      const cpu = diffuseImage(rgba, W, H, { algorithm, strength: 1, space: 'srgb', serpentine: true, palette: pal });
      let same = 0;
      for (let p = 0; p < W * H; p++) {
        if (Math.abs(gpu.data[p * 4] - cpu[p * 4]) <= 1 && Math.abs(gpu.data[p * 4 + 1] - cpu[p * 4 + 1]) <= 1 && Math.abs(gpu.data[p * 4 + 2] - cpu[p * 4 + 2]) <= 1) same++;
      }
      // f32 on the GPU vs f64 arithmetic on the CPU can flip a rare near-tie; everything else must match.
      if (same / (W * H) < 0.97) problems.push(`${algorithm}: only ${((same / (W * H)) * 100).toFixed(1)}% identical`);
    }
    expect(problems).toEqual([]);
  }, 60000);

  it('keeps transparency and leaves transparent pixels out of the error flow', async () => {
    const t = await harness();
    const img = t.fromFn(16, 16, (x) => (x < 8 ? [0, 0, 0, 0] : [140, 140, 140, 255]));
    const px = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'floyd-steinberg' }, img, { palette: [[0, 0, 0], [1, 1, 1]] }));
    expect(px.at(2, 2)[3]).toBe(0);
    expect(px.at(12, 2)[3]).toBe(255);
    expect([0, 255]).toContain(px.at(12, 2)[0]);
  }, 60000);
});
