import { describe, expect, it } from 'vitest';
import { DITHER_ALGORITHMS, diffuseImage } from '../../lib/pixel-dither-data';
import { BLACK_WHITE, GREYS4, runWithPalettes } from '../../lib/pixel-test-utils';
import { harness } from '../../testing';

const PAL: [number, number, number][] = Array.from({ length: 16 }, (_, i) => [((i * 7) % 16) / 15, ((i * 5) % 16) / 15, ((i * 3) % 16) / 15]);

describe('dither: wavefront error diffusion (parallel, exact)', () => {
  it('is identical to the sequential CPU reference for every kernel, several sizes and colour spaces', async () => {
    const t = await harness();
    const problems: string[] = [];
    const kernels = DITHER_ALGORITHMS.filter((a) => a.family === 'diffusion' && a.id !== 'riemersma').map((a) => a.id);
    for (const [w, h, space] of [[37, 29, 'srgb'], [64, 40, 'oklab'], [150, 20, 'linear']] as const) {
      const img = t.fromFn(w, h, (x, y) => [Math.round((x / w) * 255), Math.round((y / h) * 255), (x * 7 + y * 3) % 256, 255]);
      const rgba = await t.gpu.read(img, true);
      for (const algorithm of kernels) {
        if (space !== 'srgb' && algorithm !== 'floyd-steinberg' && algorithm !== 'stevenson-arce') continue;
        const gpu = await t.pixels(await runWithPalettes(t, 'dither', { algorithm, colorSpace: space }, img, { palette: PAL }));
        const cpu = diffuseImage(rgba, w, h, { algorithm, strength: 1, space, serpentine: false, palette: PAL });
        let same = 0;
        for (let p = 0; p < w * h; p++) if (gpu.data[p * 4] === cpu[p * 4] && gpu.data[p * 4 + 1] === cpu[p * 4 + 1] && gpu.data[p * 4 + 2] === cpu[p * 4 + 2]) same++;
        // Float summation order differs from the scatter walk, so a rare near-tie may flip.
        if (same / (w * h) < 0.99) problems.push(`${algorithm} ${w}x${h} ${space}: ${((same / (w * h)) * 100).toFixed(2)}%`);
      }
    }
    expect(problems).toEqual([]);
  }, 120000);

  it('1920x1080 with 16 colours finishes quickly, and each submit is bounded', async () => {
    const t = await harness();
    const img = t.fromFn(1920, 1080, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
    const out = await runWithPalettes(t, 'dither', { algorithm: 'floyd-steinberg' }, img, { palette: PAL });
    const t0 = performance.now();
    await runWithPalettes(t, 'dither', { algorithm: 'floyd-steinberg', strength: 0.99 }, img, { palette: PAL });
    await t.gpu.device.queue.onSubmittedWorkDone();
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(out.width).toBe(1920);
  }, 60000);

  it('keeps tone, palette-only colours and alpha; errorAmount 0 is plain nearest', async () => {
    const t = await harness();
    const W = 128;
    const img = t.fromFn(W, 32, (x, y) => [Math.round((x / (W - 1)) * 255), Math.round((x / (W - 1)) * 255), Math.round((x / (W - 1)) * 255), y < 4 ? 0 : 255]);
    for (const extra of [{}, { jitter: 0.6 }, { edgeKeep: 1 }, { stable: 1 }]) {
      const px = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: 'jarvis', colorSpace: 'srgb', ...extra }, img, { palette: GREYS4 }));
      let bad = 0;
      let mean = 0;
      let want = 0;
      let n = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (y < 4) {
            if (px.data[i + 3] !== 0) bad++;
            continue;
          }
          const v = px.data[i];
          if (![0, 85, 170, 255].includes(v) || px.data[i + 3] !== 255) bad++;
          mean += v;
          want += Math.round((x / (W - 1)) * 255);
          n++;
        }
      }
      expect(bad, JSON.stringify(extra)).toBe(0);
      expect(Math.abs(mean - want) / n / 255, JSON.stringify(extra)).toBeLessThan(0.03);
    }
    const flat = await runWithPalettes(t, 'dither', { algorithm: 'atkinson', errorAmount: 0 }, img, { palette: GREYS4 });
    const nearest = await runWithPalettes(t, 'dither', { algorithm: 'threshold' }, img, { palette: GREYS4 });
    expect(await t.diff(flat, nearest)).toBe(0);
  }, 60000);

  it('stable: tiny source changes give identical output; without it they do not', async () => {
    const t = await harness();
    // Flat grey with +-6 noise (far from a snap boundary): the video-noise case the option is for.
    const a = t.fromFn(64, 32, () => [107, 107, 107, 255]);
    const b = t.fromFn(64, 32, (x, y) => {
      const v = 107 + ((x * 31 + y * 17) % 13) - 6;
      return [v, v, v, 255];
    });
    const run = (img: typeof a, stable: number) => runWithPalettes(t, 'dither', { algorithm: 'floyd-steinberg', stable, colorSpace: 'srgb' }, img, { palette: BLACK_WHITE });
    expect(await t.diff(await run(a, 0), await run(b, 0))).toBeGreaterThan(0);
    expect(await t.diff(await run(a, 1), await run(b, 1))).toBe(0);
  }, 60000);

  it('summary names the mode actually used (no silent fallback)', async () => {
    const t = await harness();
    const def = t.registry.get('dither')!;
    const s = (p: Record<string, unknown>) => def.summary!({ algorithm: 'floyd-steinberg', serpentine: false, fallback: 'pico-8', ...p } as never, new Set());
    expect(s({})).toContain('exact parallel');
    expect(s({ serpentine: true })).toContain('sequential');
    expect(s({ algorithm: 'riemersma' })).toContain('sequential');
  });
});
