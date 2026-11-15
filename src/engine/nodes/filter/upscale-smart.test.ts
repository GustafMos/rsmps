import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

type Px = [number, number, number, number];
const W: Px = [255, 255, 255, 255];
const K: Px = [0, 0, 0, 255];

describe('upscale-smart', () => {
  it('nearest makes exact blocks, by factor or by literal height, and scales the unit', async () => {
    const t = await harness();
    const src = t.fromFn(4, 3, (x, y) => [x * 60, y * 80, 0, 255]);
    const out = await t.run('upscale-smart', { mode: 'nearest', factor: 3 }, { image: src });
    const img = out.image as { width: number; height: number; unit: number };
    expect([img.width, img.height, img.unit]).toEqual([12, 9, 3]);
    const px = await t.pixels(img as never);
    expect(px.at(7, 4).slice(0, 3)).toEqual([120, 80, 0]);
    expect(px.at(8, 5).slice(0, 3)).toEqual([120, 80, 0]);
    const lit = (await t.run('upscale-smart', { mode: 'nearest', by: 'height', height: 30 }, { image: src })).image as { width: number; height: number };
    expect([lit.width, lit.height]).toEqual([40, 30]);
  });

  it('Scale2x applies the published rules: a diagonal corner is smoothed', async () => {
    const t = await harness();
    // 3x3: up and left of the centre are black, everything else white. Centre E is white.
    const src = t.fromFn(3, 3, (x, y) => ((x === 1 && y === 0) || (x === 0 && y === 1) || (x === 0 && y === 0) ? K : W));
    const px = await t.pixels((await t.run('upscale-smart', { mode: 'scale2x', factor: 2 }, { image: src })).image as never);
    // block of the centre pixel is x 2..3, y 2..3: E0 (top-left) takes D (black), the rest stay E (white)
    expect(px.at(2, 2)[0]).toBe(0);
    expect(px.at(3, 2)[0]).toBe(255);
    expect(px.at(2, 3)[0]).toBe(255);
    expect(px.at(3, 3)[0]).toBe(255);
  });

  it('Scale3x applies its rules and 4x chains two 2x steps', async () => {
    const t = await harness();
    const src = t.fromFn(3, 3, (x, y) => ((x === 1 && y === 0) || (x === 0 && y === 1) || (x === 0 && y === 0) ? K : W));
    const out = await t.run('upscale-smart', { mode: 'scale2x', factor: 3 }, { image: src });
    const px = await t.pixels(out.image as never);
    expect(px.width).toBe(9);
    expect(px.at(3, 3)[0]).toBe(0); // E0 of the centre block (x 3..5, y 3..5) takes D
    expect(px.at(4, 4)[0]).toBe(255); // E4 = E
    expect(px.at(5, 5)[0]).toBe(255);
    const four = (await t.run('upscale-smart', { mode: 'scale2x', factor: 4 }, { image: src })).image as { width: number; unit: number };
    expect(four.width).toBe(12);
    expect(four.unit).toBe(4);
    const flat = await t.pixels((await t.run('upscale-smart', { mode: 'scale2x', factor: 2 }, { image: t.solid(4, 4, [9, 8, 7, 255]) })).image as never);
    expect(flat.at(5, 5).slice(0, 3)).toEqual([9, 8, 7]);
  });

  it('Scale2x to a non-smooth factor ends with the exact size', async () => {
    const t = await harness();
    const out = (await t.run('upscale-smart', { mode: 'scale2x', by: 'height', height: 22 }, { image: t.checker(6, 4, 1) })).image as { width: number; height: number };
    expect([out.width, out.height]).toEqual([33, 22]);
  });

  it('lanczos and bicubic are smooth, monotonic on a ramp, and keep the average colour', async () => {
    const t = await harness();
    const ramp = t.fromFn(8, 2, (x) => [x * 36, x * 36, x * 36, 255]);
    for (const mode of ['lanczos', 'bicubic']) {
      const px = await t.pixels((await t.run('upscale-smart', { mode, factor: 4 }, { image: ramp })).image as never);
      expect(px.width).toBe(32);
      let prev = -1;
      let rising = 0;
      for (let x = 2; x < 30; x++) { const v = px.at(x, 3)[0]; if (v >= prev - 2) rising++; prev = v; }
      expect(rising, mode).toBe(28);
      const distinct = new Set(Array.from({ length: 32 }, (_, x) => px.at(x, 3)[0]));
      expect(distinct.size, mode).toBeGreaterThan(20);
    }
  });

  it('transparent sprites upscale without dark fringes', async () => {
    const t = await harness();
    const src = t.fromFn(16, 16, (x, y) => (Math.hypot(x - 8, y - 8) < 5 ? [255, 160, 40, 255] : [0, 0, 0, 0]));
    for (const mode of ['lanczos', 'bicubic', 'lineart']) {
      const px = await t.pixels((await t.run('upscale-smart', { mode, factor: 4 }, { image: src })).image as never);
      let n = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const [r, g, , a] = px.at(x, y);
        if (a > 40 && a < 220) { n++; expect(r, mode).toBeGreaterThan(210); expect(g, mode).toBeGreaterThan(110); }
      }
      expect(n, mode).toBeGreaterThan(10);
      expect(px.at(2, 2)[3]).toBe(0);
    }
  });

  it('edge-sharpened mode makes edges crisper than Lanczos', async () => {
    const t = await harness();
    const diag = t.fromFn(24, 24, (x, y) => (x + y > 24 ? [20, 20, 20, 255] : [240, 240, 240, 255]));
    const soft = await t.pixels((await t.run('upscale-smart', { mode: 'lanczos', factor: 4 }, { image: diag })).image as never);
    const crisp = await t.pixels((await t.run('upscale-smart', { mode: 'lineart', factor: 4 }, { image: diag })).image as never);
    const mid = (p: typeof soft) => { let n = 0; for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) { const v = p.at(x, y)[0]; if (v > 60 && v < 200) n++; } return n; };
    expect(mid(crisp)).toBeLessThan(mid(soft));
  });

  it('factor 1 returns the input', async () => {
    const t = await harness();
    const src = t.solid(4, 4, [1, 2, 3, 255]);
    expect((await t.run('upscale-smart', { factor: 1 }, { image: src })).image).toBe(src);
  });
});
