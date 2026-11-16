import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';
import { GLYPH_H, GLYPH_W, ASCII_PRINTABLE, builtinGlyph, coverage } from '../../lib/fx-ascii-font';
import type { Host } from '../../types';

const ink = { colorMode: 'ink', ink: [1, 1, 1, 1], background: 'black', glow: 0, contrast: 1, gamma: 1, brightness: 0 };
/** ink (white) pixels of one cell */
function cellInk(px: { at(x: number, y: number): number[] }, cx: number, cy: number, w: number, h: number) {
  const pts: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px.at(cx * w + x, cy * h + y)[0] > 128) pts.push([x, y]);
  return pts;
}

describe('built-in font', () => {
  it('draws every printable character, distinct and inside its cell', () => {
    const seen = new Set<string>();
    for (const ch of ASCII_PRINTABLE) {
      const g = builtinGlyph(ch)!;
      expect(g, ch).toBeTruthy();
      expect(g.length).toBe(GLYPH_W * GLYPH_H);
      seen.add(Array.from(g).join(''));
      if (ch !== ' ') expect(coverage(g), ch).toBeGreaterThan(0.02);
    }
    expect(seen.size).toBe(95);
    for (const ch of '░▒▓█─│┼┌┐└┘⠁⣿') expect(builtinGlyph(ch), ch).toBeTruthy();
    expect(coverage(builtinGlyph('█')!)).toBe(1);
    expect(coverage(builtinGlyph('░')!)).toBeLessThan(coverage(builtinGlyph('▓')!));
  });
});

describe('ascii-art', () => {
  it('brightness ramp: dark cells get sparse characters, bright cells dense ones', async () => {
    const t = await harness();
    const src = t.fromFn(96, 32, (x) => { const v = Math.round((x / 95) * 255); return [v, v, v, 255]; });
    const px = await t.pixels((await t.run('ascii-art', { ...ink, charset: 'classic', cellSize: 8 }, { image: src })).image as never);
    const amounts = Array.from({ length: 12 }, (_, cx) => cellInk(px, cx, 1, 8, 10).length);
    expect(amounts[0]).toBe(0);
    expect(amounts[11]).toBeGreaterThan(8);
    expect(amounts[11]).toBeGreaterThan(amounts[6]);
    expect(amounts[6]).toBeGreaterThan(amounts[2]);
  });

  it('invert swaps which cells are dense', async () => {
    const t = await harness();
    const src = t.fromFn(32, 24, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const run = async (invert: boolean) => t.pixels((await t.run('ascii-art', { ...ink, invert }, { image: src })).image as never);
    const a = await run(false);
    const b = await run(true);
    expect(cellInk(a, 0, 1, 8, 10).length).toBeLessThan(cellInk(a, 3, 1, 8, 10).length);
    expect(cellInk(b, 0, 1, 8, 10).length).toBeGreaterThan(cellInk(b, 3, 1, 8, 10).length);
  });

  it('native grid output is exactly cols x glyph width, with the unit scaled', async () => {
    const t = await harness();
    const out = (await t.run('ascii-art', { cellSize: 8, output: 'native', scale: 2 }, { image: t.solid(96, 64, [200, 200, 200, 255]) })).image as { width: number; height: number; unit: number };
    expect(out.width).toBe(12 * GLYPH_W * 2);
    expect(out.height).toBe(Math.floor(64 / ((8 * GLYPH_H) / GLYPH_W)) * GLYPH_H * 2);
    expect(out.unit).toBeCloseTo(out.width / 96, 5);
  });

  it('shape matching turns lines into characters with the same direction', async () => {
    const t = await harness();
    const params = { ...ink, charset: 'lines', match: 'shape', edgeBoost: 1, cellSize: 12, contrast: 1.5 };
    const h = await t.pixels((await t.run('ascii-art', params, { image: t.fromFn(48, 48, (x, y) => (Math.abs(y - 24) < 3 ? [255, 255, 255, 255] : [0, 0, 0, 255])) })).image as never);
    const v = await t.pixels((await t.run('ascii-art', params, { image: t.fromFn(48, 48, (x) => (Math.abs(x - 24) < 3 ? [255, 255, 255, 255] : [0, 0, 0, 255])) })).image as never);
    const extent = (pts: [number, number][]) => [Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]))];
    // cell (2,1)/(2,2) are on the line: collect ink of the cells along it
    const hp = [...cellInk(h, 1, 1, 12, 16), ...cellInk(h, 2, 1, 12, 16)].concat(cellInk(h, 1, 2, 12, 16), cellInk(h, 2, 2, 12, 16));
    const vp = [...cellInk(v, 1, 1, 12, 16), ...cellInk(v, 1, 2, 12, 16), ...cellInk(v, 2, 1, 12, 16), ...cellInk(v, 2, 2, 12, 16)];
    expect(hp.length).toBeGreaterThan(3);
    expect(vp.length).toBeGreaterThan(3);
    const [hw, hh] = extent(hp);
    const [vw, vh] = extent(vp);
    expect(hw / Math.max(1, hh)).toBeGreaterThan(vw / Math.max(1, vh));
  });

  it('braille charset draws only dot positions; custom strings work as sorted ramps', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('ascii-art', { ...ink, charset: 'braille', cellSize: 6, match: 'shape' }, { image: t.fromFn(48, 48, (x, y) => (x < 24 && y < 24 ? [255, 255, 255, 255] : [0, 0, 0, 255])) })).image as never);
    const pts = cellInk(px, 1, 1, 6, 8);
    expect(pts.length).toBeGreaterThan(3);
    for (const [x] of pts) expect([0, 1, 3, 4]).toContain(x);
    const custom = await t.pixels((await t.run('ascii-art', { ...ink, charset: 'custom', custom: '#.:@ ', cellSize: 8 }, { image: t.fromFn(96, 32, (x) => { const v = Math.round((x / 95) * 255); return [v, v, v, 255]; }) })).image as never);
    expect(cellInk(custom, 0, 1, 8, 10).length).toBe(0);
    expect(cellInk(custom, 11, 1, 8, 10).length).toBeGreaterThan(20);
  });

  it('colour modes: source, terminal, palette', async () => {
    const t = await harness();
    const red = t.solid(48, 32, [255, 0, 0, 255]);
    const bright = { charset: 'blocks', cellSize: 8, background: 'black', glow: 0, contrast: 1, gamma: 1 };
    const s = await t.pixels((await t.run('ascii-art', { ...bright, colorMode: 'source' }, { image: red })).image as never);
    const sc = s.at(3, 5);
    expect(sc[0]).toBeGreaterThan(sc[1] + 60);
    const white = t.solid(48, 32, [255, 255, 255, 255]);
    const term = await t.pixels((await t.run('ascii-art', { ...bright, colorMode: 'terminal', terminal: 'green' }, { image: white })).image as never);
    const tc = term.at(3, 5);
    expect(tc[1]).toBeGreaterThan(tc[0]);
    expect(tc[1]).toBeGreaterThan(tc[2]);
    const pal = await t.pixels((await t.run('ascii-art', { ...bright, colorMode: 'palette', palette: [[0, 0, 1], [1, 1, 0]], inkGain: 1 }, { image: white })).image as never);
    const pc = pal.at(3, 5);
    expect([pc[0], pc[1], pc[2]]).toEqual([255, 255, 0]);
  });

  it('transparent background and the glyph mask output', async () => {
    const t = await harness();
    const src = t.fromFn(64, 32, (x) => (x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = await t.run('ascii-art', { ...ink, background: 'transparent' }, { image: src });
    const px = await t.pixels(out.image as never);
    const mask = await t.pixels(out.mask as never);
    expect(px.at(2, 5)[3]).toBe(0);
    let ink2 = 0;
    for (let x = 40; x < 64; x++) for (let y = 0; y < 32; y++) if (px.at(x, y)[3] > 200) ink2++;
    expect(ink2).toBeGreaterThan(30);
    let covered = 0;
    for (let x = 0; x < 64; x++) for (let y = 0; y < 32; y++) if (mask.at(x, y)[0] > 128) covered++;
    expect(covered).toBeGreaterThan(30);
    expect(mask.at(2, 5)[0]).toBe(0);
    const clear = await t.pixels((await t.run('ascii-art', { ...ink, background: 'transparent' }, { image: t.solid(32, 32, [255, 255, 255, 0]) })).image as never);
    expect(clear.at(5, 5)[3]).toBe(0);
  });

  it('glow lights the space around characters', async () => {
    const t = await harness();
    const src = t.solid(64, 32, [255, 255, 255, 255]);
    const sum = async (glow: number) => { const px = await t.pixels((await t.run('ascii-art', { ...ink, glow, charset: 'binary' }, { image: src })).image as never); let s = 0; for (let i = 0; i < px.data.length; i += 4) s += px.data[i]; return s; };
    expect(await sum(1.5)).toBeGreaterThan(await sum(0));
  });

  it('uses the host font through a bound rasteriser when a font is chosen', async () => {
    let calls = 0;
    const host = {
      tag: 'bound',
      assetInfo: () => null,
      assetFrame: async () => null,
      rasterizeText(this: { tag?: string }, spec: { text: string }) {
        if (this.tag !== 'bound') throw new Error('detached call lost this');
        calls++;
        const w = 20;
        const h = 24;
        const data = new Uint8ClampedArray(w * h * 4);
        const dense = spec.text === '@';
        for (let i = 0; i < w * h; i++) data[i * 4 + 3] = dense ? 255 : spec.text === ' ' ? 0 : i % 7 === 0 ? 255 : 0;
        return { data, width: w, height: h };
      },
    } as unknown as Host;
    const t = await harness([], host);
    const px = await t.pixels((await t.run('ascii-art', { ...ink, font: 'Test Mono', charset: 'classic', cellSize: 12 }, { image: t.solid(48, 36, [255, 255, 255, 255]) })).image as never);
    expect(calls).toBeGreaterThan(5);
    let n = 0;
    for (let y = 0; y < 18; y++) for (let x = 0; x < 12; x++) if (px.at(x, y)[0] > 128) n++;
    expect(n).toBeGreaterThan(100); // the dense '@' of the fake font fills the cell
  });

  it('cells follow resolution', async () => {
    const t = await harness();
    expect(await resolutionDiff(t, 'ascii-art', { cellSize: 8, colorMode: 'ink', contrast: 1.5 }, scalable, 64)).toBeLessThan(30);
  });

  it('is stable over time and alpha-free input stays opaque', async () => {
    const t = await harness();
    const r = await t.loopCheck('ascii-art', {}, { image: t.fromFn(32, 32, (x, y) => [x * 8, y * 8, 100, 255]) });
    expect(r.motion).toBe(0);
  });
});
