import { describe, expect, it } from 'vitest';
import { BLACK_WHITE, GREYS4, runWithPalettes } from '../../lib/pixel-test-utils';
import { harness } from '../../testing';

describe('quantize', () => {
  it('snaps every pixel to a palette colour and picks the nearest', async () => {
    const t = await harness();
    const img = t.fromFn(8, 1, (x) => [x * 36, x * 36, x * 36, 255]);
    const px = await t.pixels(await runWithPalettes(t, 'quantize', { colorSpace: 'srgb' }, img, { palette: GREYS4 }));
    const levels = new Set([0, 85, 170, 255]);
    let bad = 0;
    for (let x = 0; x < 8; x++) if (!levels.has(px.data[x * 4])) bad++;
    expect(bad).toBe(0);
    expect(px.at(0, 0)[0]).toBe(0);
    expect(px.at(3, 0)[0]).toBe(85); // 108 is closer to 85
    expect(px.at(4, 0)[0]).toBe(170); // 144 is closer to 170
    expect(px.at(7, 0)[0]).toBe(255);
  });

  it('colour space changes the match: OKLab keeps hue, plain RGB distance does not always', async () => {
    const t = await harness();
    // A saturated orange against black/white/red: OKLab picks red, weighted RGB may pick white.
    const pal: [number, number, number][] = [[0, 0, 0], [1, 1, 1], [0.8, 0.1, 0.1]];
    const img = t.solid(2, 2, [230, 120, 20, 255]);
    const lab = await t.pixels(await runWithPalettes(t, 'quantize', { colorSpace: 'oklab' }, img, { palette: pal }));
    expect(Math.abs(lab.at(0, 0)[0] - 204)).toBeLessThanOrEqual(1);
    expect(Math.abs(lab.at(0, 0)[1] - 26)).toBeLessThanOrEqual(1);
  });

  it('strength mixes between the original and the palette colour; alpha is preserved', async () => {
    const t = await harness();
    const img = t.solid(4, 4, [100, 100, 100, 128]);
    const full = await t.pixels(await runWithPalettes(t, 'quantize', { colorSpace: 'srgb' }, img, { palette: BLACK_WHITE }));
    expect(full.at(1, 1)[0]).toBe(0);
    expect(full.at(1, 1)[3]).toBe(128);
    const half = await t.pixels(await runWithPalettes(t, 'quantize', { colorSpace: 'srgb', strength: 0.5 }, img, { palette: BLACK_WHITE }));
    expect(half.at(1, 1)[0]).toBeGreaterThan(40);
    expect(half.at(1, 1)[0]).toBeLessThan(60);
    const none = await t.pixels(await runWithPalettes(t, 'quantize', { strength: 0 }, img, { palette: BLACK_WHITE }));
    expect(Math.abs(none.at(1, 1)[0] - 100)).toBeLessThan(3);
  });

  it('the palette socket is required: without it the node produces nothing', async () => {
    const t = await harness();
    const out = await t.run('quantize', {}, { image: t.solid(2, 2, [1, 2, 3, 255]) });
    expect(out.image ?? null).toBeNull();
  });

  it('works the same at 2x resolution (no lengths involved)', async () => {
    const t = await harness();
    const small = t.fromFn(8, 8, (x) => [x * 32, 0, 0, 255], 1);
    const big = t.fromFn(16, 16, (x) => [Math.floor(x / 2) * 32, 0, 0, 255], 2);
    const a = await t.pixels(await runWithPalettes(t, 'quantize', {}, small, { palette: GREYS4 }));
    const b = await t.pixels(await runWithPalettes(t, 'quantize', {}, big, { palette: GREYS4 }));
    let mismatch = 0;
    for (let x = 0; x < 8; x++) if (a.data[x * 4] !== b.data[x * 2 * 4]) mismatch++;
    expect(mismatch).toBe(0);
  });
});
