import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

describe('split-layers', () => {
  it('produces a foreground cutout and a filled background', async () => {
    const t = await harness();
    const bg = (x: number, y: number): [number, number, number, number] => [40 + x * 2, 90 + y, 150, 255];
    const img = t.fromFn(64, 64, (x, y) => (inRect(x, y, 24, 20, 44, 46) ? [230, 40, 40, 255] : bg(x, y)));
    const mask = t.maskFn(64, 64, (x, y) => (inRect(x, y, 24, 20, 44, 46) ? 1 : 0));
    const out = await t.run('split-layers', { shrink: 0, feather: 0, texture: 0 }, { image: img, mask });
    const fg = await t.pixels(out.foreground as never);
    const back = await t.pixels(out.background as never);
    expect(fg.at(32, 30).slice(0, 4)).toEqual([230, 40, 40, 255]);
    expect(fg.at(5, 5)[3]).toBe(0);
    expect(back.at(5, 5).slice(0, 3)).toEqual(bg(5, 5).slice(0, 3));
    let err = 0;
    for (let y = 20; y < 46; y++) for (let x = 24; x < 44; x++) for (let c = 0; c < 3; c++) err += Math.abs(back.at(x, y)[c] - bg(x, y)[c]);
    const mean = err / (26 * 20 * 3);
    console.log('split-layers background fill mean abs error', mean.toFixed(2));
    expect(mean).toBeLessThan(3);
    expect(back.at(34, 33)[3]).toBe(255);
  });
});
