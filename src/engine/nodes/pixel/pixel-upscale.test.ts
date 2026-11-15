import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('pixel-upscale', () => {
  it('enlarges by an integer factor with crisp nearest-neighbour blocks and scales the unit', async () => {
    const t = await harness();
    const src = t.fromFn(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]), 1);
    const out = (await t.run('pixel-upscale', { factor: 3 }, { image: src })).image as { width: number; height: number; unit: number };
    expect([out.width, out.height, out.unit]).toEqual([12, 12, 3]);
    const px = await t.pixels(out as never);
    let wrong = 0;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const want = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 255 : 0;
        if (px.data[(y * 12 + x) * 4] !== want) wrong++;
      }
    }
    expect(wrong).toBe(0);
  });

  it('fit to height picks the largest integer factor', async () => {
    const t = await harness();
    const src = t.solid(5, 5, [10, 20, 30, 255]);
    const h = (await t.run('pixel-upscale', { mode: 'fit-height', target: 23 }, { image: src })).image as { width: number; height: number };
    expect([h.width, h.height]).toEqual([20, 20]);
    const w = (await t.run('pixel-upscale', { mode: 'fit-width', target: 12 }, { image: src })).image as { width: number };
    expect(w.width).toBe(10);
    const tiny = (await t.run('pixel-upscale', { mode: 'fit-height', target: 3 }, { image: src })).image as { width: number };
    expect(tiny.width).toBe(5); // never smaller than the source
  });

  it('keeps alpha', async () => {
    const t = await harness();
    const src = t.fromFn(2, 1, (x) => (x ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const px = await t.pixels((await t.run('pixel-upscale', { factor: 2 }, { image: src })).image as never);
    expect(px.at(1, 1)[3]).toBe(0);
    expect(px.at(3, 0)[3]).toBe(255);
  });
});
