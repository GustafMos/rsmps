import { describe, expect, it } from 'vitest';
import { runWithPalettes } from '../../lib/pixel-test-utils';
import { harness } from '../../testing';

describe('dither: colour palettes', () => {
  it('one algorithm per family keeps the mean colour and only uses palette colours', async () => {
    const t = await harness();
    const W = 128;
    const H = 32;
    const sr0 = (x: number) => 60 + Math.round((x / (W - 1)) * 120);
    const img = t.fromFn(W, H, (x) => [sr0(x), 90, 160, 255]);
    const pal: [number, number, number][] = [
      [0.1, 0.1, 0.25],
      [0.9, 0.2, 0.2],
      [0.2, 0.8, 0.3],
      [0.95, 0.9, 0.5],
      [0.3, 0.3, 0.7],
      [1, 1, 1],
    ];
    const levels = pal.map((c) => c.map((v) => v * 255));
    const problems: string[] = [];
    for (const algorithm of ['bayer-8', 'blue-noise', 'dots', 'crosshatch', 'yliluoma', 'floyd-steinberg', 'riemersma']) {
      const px = await t.pixels(await runWithPalettes(t, 'dither', { algorithm, colorSpace: 'srgb' }, img, { palette: pal }));
      let bad = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let sr = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const pr = px.data[i];
          const pg = px.data[i + 1];
          const pb = px.data[i + 2];
          let ok = false;
          for (const c of levels) if (Math.abs(c[0] - pr) <= 1 && Math.abs(c[1] - pg) <= 1 && Math.abs(c[2] - pb) <= 1) ok = true;
          if (!ok) bad++;
          r += pr;
          g += pg;
          b += pb;
          sr += sr0(x);
        }
      }
      if (bad) problems.push(`${algorithm}: ${bad} non-palette pixels`);
      const n = W * H * 255;
      // Mean colour within 8% on every channel (the palette is far from the source colours, so this is a real test).
      if (Math.abs(r - sr) / n >= 0.08 || Math.abs(g - W * H * 90) / n >= 0.08 || Math.abs(b - W * H * 160) / n >= 0.08) {
        problems.push(`${algorithm}: mean drift r${((r - sr) / n).toFixed(3)} g${((g - W * H * 90) / n).toFixed(3)} b${((b - W * H * 160) / n).toFixed(3)}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120000);
});
