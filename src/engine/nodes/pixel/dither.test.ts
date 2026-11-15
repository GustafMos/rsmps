import { describe, expect, it } from 'vitest';
import { DITHER_ALGORITHMS, DIFFUSION_KERNELS, algorithmFamily, hilbertD2xy, thresholdMatrix } from '../../lib/pixel-dither-data';
import { checkGradient } from '../../lib/pixel-test-utils';
import { harness } from '../../testing';

// The GPU-heavy dither tests are spread over dither*.test.ts files: headless WebGPU in this repo's test setup
// gets unstable after a few dozen evaluations per process, and every test file runs in its own process.

describe('threshold matrices and kernels', () => {
  it('every matrix is a bijective rank matrix (tone-preserving)', () => {
    for (const a of DITHER_ALGORITHMS) {
      const m = thresholdMatrix(a.id);
      if (!m) continue;
      const n = m.width * m.height;
      const ranks = [...m.data].map((v) => Math.round(v * n - 0.5)).sort((x, y) => x - y);
      expect(ranks, a.id).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('blue noise has no clumps: 8x8 block means stay near 0.5', () => {
    const m = thresholdMatrix('blue-noise')!;
    let worst = 0;
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        let s = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += m.data[(by * 8 + y) * 64 + bx * 8 + x];
        worst = Math.max(worst, Math.abs(s / 64 - 0.5));
      }
    }
    expect(worst).toBeLessThan(0.06);
  });

  it('the Hilbert curve is continuous (each step moves one cell)', () => {
    let prev = hilbertD2xy(16, 0);
    const seen = new Set<string>([prev.join(',')]);
    let jumps = 0;
    for (let d = 1; d < 256; d++) {
      const cur = hilbertD2xy(16, d);
      if (Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) !== 1) jumps++;
      seen.add(cur.join(','));
      prev = cur;
    }
    expect(jumps).toBe(0);
    expect(seen.size).toBe(256);
  });

  it('diffusion kernels sum to their divisor (no energy gain or loss), except Atkinson', () => {
    for (const [id, k] of Object.entries(DIFFUSION_KERNELS)) {
      const sum = k.taps.reduce((s, tap) => s + tap[2], 0);
      if (id === 'atkinson') expect(sum).toBe(6);
      else expect(sum, id).toBe(k.divisor);
    }
  });

  it('family grouping labels', () => {
    expect(algorithmFamily('riemersma')).toBe('diffusion');
    expect(algorithmFamily('dots')).toBe('pattern');
    expect(DITHER_ALGORITHMS.find((a) => a.id === 'bayer-4')!.label.startsWith('Ordered')).toBe(true);
  });
});

describe('dither node: every ordered / pattern algorithm', () => {
  it('on a gradient with a 4-grey palette: only palette colours, alpha kept, tone preserved per quarter', async () => {
    const t = await harness();
    const ids = DITHER_ALGORITHMS.filter((a) => a.family === 'ordered' || a.family === 'pattern' || a.family === 'none').map((a) => a.id);
    expect(await checkGradient(t, ids)).toEqual([]);
  }, 120000);
});
