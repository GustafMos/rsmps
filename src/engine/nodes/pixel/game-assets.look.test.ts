/**
 * Looks at the game asset nodes: contact sheets written to <preview dir>/game-assets/ (PNG_DIR in lib/gen-3d-testutil).
 * They are for a human to open; the assertions only check that something was drawn.
 */
import { describe, expect, it } from 'vitest';
import { PNG_DIR, sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { harness, type Harness } from '../../testing';
import type { ImageValue } from '../../types';

type Px = [number, number, number, number];
const CLEAR: Px = [0, 0, 0, 0];

async function grab(t: Harness, image: ImageValue | null | undefined): Promise<Img> {
  const p = await t.pixels(image);
  return { data: p.data, width: p.width, height: p.height };
}

/** Nearest-neighbour enlargement. */
function up(img: Img, k: number): Img {
  const out = new Uint8ClampedArray(img.width * k * img.height * k * 4);
  for (let y = 0; y < img.height * k; y++) for (let x = 0; x < img.width * k; x++) out.set(img.data.subarray((Math.floor(y / k) * img.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4 + 4), (y * img.width * k + x) * 4);
  return { data: out, width: img.width * k, height: img.height * k };
}

/** A 20x20 mushroom-like sprite with a stem, drawn by formulas (so there is something to outline, shade and clean). */
function sprite(t: Harness): ImageValue {
  return t.fromFn(20, 20, (x, y) => {
    const cap = Math.hypot(x - 10, (y - 8) * 1.3) < 8 && y < 11;
    const stem = x >= 8 && x <= 11 && y >= 11 && y <= 17;
    const spot = (Math.hypot(x - 7, y - 6) < 1.6 || Math.hypot(x - 13, y - 7) < 1.2) && cap;
    if (spot) return [250, 245, 230, 255];
    if (cap) return [200 - y * 4, 40 + y * 3, 50, 255];
    if (stem) return [225 - (x - 8) * 12, 200 - (x - 8) * 12, 170 - (x - 8) * 10, 255];
    return CLEAR;
  });
}

describe('game asset looks', () => {
  it('sprite looks: outlines, shadow, cleanup', async () => {
    const t = await harness();
    const s = sprite(t);
    const run = async (type: string, params: Record<string, unknown>, image = s) => (await t.run(type, params, { image })).image as ImageValue;
    const cells: Img[] = [];
    cells.push(await grab(t, s));
    cells.push(await grab(t, await run('pixel-outline', { color: [0.05, 0.02, 0.1, 1], connect: 'eight' })));
    cells.push(await grab(t, await run('pixel-outline', { color: [0.05, 0.02, 0.1, 1], connect: 'four' })));
    cells.push(await grab(t, await run('pixel-outline', { position: 'inside', color: [0.1, 0.02, 0.05, 1], connect: 'four' })));
    cells.push(await grab(t, await run('pixel-outline', { colorMode: 'selective', darken: 0.6, connect: 'eight' })));
    cells.push(await grab(t, await run('pixel-outline', { top: false, left: false, color: [0.05, 0.02, 0.1, 1] })));
    cells.push(await grab(t, await run('pixel-outline', { second: true, color: [0.05, 0.02, 0.1, 1], color2: [1, 1, 1, 1], connect: 'four' })));
    cells.push(await grab(t, await run('sprite-shadow', { mode: 'drop', offset: [2, 2], opacity: 1, pattern: 'bayer' })));
    cells.push(await grab(t, await run('sprite-shadow', { mode: 'ground', ground: 0.9, squash: 0.35, skew: 0.8, opacity: 0.6, pattern: 'bayer' })));
    cells.push(await grab(t, await run('sprite-shadow', { mode: 'contact', ground: 0.92, blob: [7, 2], opacity: 1, pattern: 'checker' })));
    const big = up(sheet(cells.map((c) => ({ ...c, width: 20, height: 20 })), 5), 6);
    const file = writePng('game-assets/outlines-and-shadows', big);
    expect(file.replace(/\\/g, '/')).toContain(`${PNG_DIR}/game-assets/`);
    expect(big.width).toBe(20 * 5 * 6);
  });

  it('pixel cleanup before and after', async () => {
    const t = await harness();
    // a downscaled-looking blob: soft alpha edge, strays and a hole
    const img = t.fromFn(20, 20, (x, y) => {
      const d = Math.hypot(x - 10, y - 10);
      if ((x === 2 && y === 3) || (x === 17 && y === 16)) return [255, 220, 40, 255];
      if (x === 10 && y === 10) return CLEAR;
      if (d < 6) return [60, 150 + y * 3, 90, 255];
      if (d < 7.5) return [20, 20, 20, Math.round(255 * (7.5 - d) / 1.5)];
      return CLEAR;
    });
    const cleaned = (await t.run('clean-pixels', { jaggies: false }, { image: img })).image as ImageValue;
    const a = await grab(t, img);
    const b = await grab(t, cleaned);
    writePng('game-assets/cleanup-before-after', up(sheet([a, b], 2), 10));
    expect(b.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(false);
  });

  it('tilesets: the 16 and the 47 set made from five pieces', async () => {
    const t = await harness();
    const T = 16;
    // Draw the five pieces from a terrain test per piece: grass, a darker rim where terrain meets empty.
    const inside = [
      () => true,
      (_x: number, y: number) => y >= 3,
      (x: number, y: number) => (x >= 3 && y >= 3) && !(x < 6 && y < 6 && Math.hypot(x - 6, y - 6) > 3.2),
      (x: number, y: number) => !(x < 4 && y < 4 && Math.hypot(x - 4, y - 4) < 3.2),
      (x: number, y: number) => Math.hypot(x - 7.5, y - 7.5) < 5.5,
    ];
    const px = (k: number, x: number, y: number): Px => {
      const at = (xx: number, yy: number) => {
        if (k === 0) return true;
        // outside the piece the terrain continues exactly as the piece's own rule says; for rim shading look only inside it
        return xx >= 0 && yy >= 0 && xx < T && yy < T && inside[k](xx, yy);
      };
      if (!inside[k](x, y)) return CLEAR;
      let rim = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        // pieces 1..3 meet their neighbours on the tile border, so only inner empties make a rim
        if ((nx >= 0 && ny >= 0 && nx < T && ny < T) && !at(nx, ny)) rim = true;
      }
      if (rim) return [40, 95, 50, 255];
      return (x + y) % 5 === 0 ? [95, 175, 80, 255] : [80, 160, 70, 255];
    };
    const pieces = t.fromFn(5 * T, T, (x, y) => px(Math.floor(x / T), x % T, y));
    const set47 = (await t.run('autotile', { layout: 'blob47' }, { image: pieces })).image as ImageValue;
    const a = await grab(t, set47);
    const set16 = (await t.run('autotile', { layout: 'edge16' }, { image: pieces })).image as ImageValue;
    const b = await grab(t, set16);
    const strip = await grab(t, pieces);
    writePng('game-assets/tileset-47', up(a, 4));
    writePng('game-assets/tileset-16', up(b, 4));
    writePng('game-assets/tileset-pieces', up(strip, 6));
    expect([a.width, a.height, b.width, b.height]).toEqual([8 * T, 6 * T, 4 * T, 4 * T]);

    // a painted terrain: a blobby mask on a 24 x 16 map
    const map = t.fromFn(24, 16, (x, y) => {
      const v = Math.hypot(x - 8, y - 8) < 5.5 || Math.hypot(x - 16, y - 7) < 4.5 || (y >= 7 && y <= 8 && x > 8 && x < 17) || (x === 20 && y > 9);
      return v ? [255, 255, 255, 255] : [0, 0, 0, 255];
    });
    const painted = (await t.run('tileset-map', { layout: 'blob47' }, { terrain: map, tileset: await retain(t, set47) })).image as ImageValue;
    const m = await grab(t, painted);
    writePng('game-assets/painted-terrain', up(m, 2));
    expect(m.width).toBe(24 * T);
    expect(m.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('seamless: before and after in a 3 x 3 preview', async () => {
    const t = await harness();
    const tex = t.fromFn(48, 48, (x, y) => {
      const v = 0.5 + 0.25 * Math.sin(x * 0.19 + y * 0.05) + 0.2 * Math.sin(y * 0.23 - x * 0.07) + 0.1 * Math.sin((x + y) * 0.41);
      const r = Math.round(60 + 140 * v);
      return [r, Math.round(r * 0.8), Math.round(r * 0.55), 255];
    });
    const tile = (img: Img): Img => {
      const out = new Uint8ClampedArray(img.width * 3 * img.height * 3 * 4);
      for (let y = 0; y < img.height * 3; y++) for (let x = 0; x < img.width * 3; x++) out.set(img.data.subarray(((y % img.height) * img.width + (x % img.width)) * 4, ((y % img.height) * img.width + (x % img.width)) * 4 + 4), (y * img.width * 3 + x) * 4);
      return { data: out, width: img.width * 3, height: img.height * 3 };
    };
    const before = tile(await grab(t, tex));
    const offset = tile(await grab(t, (await t.run('make-seamless', { method: 'offset' }, { image: tex })).image as ImageValue));
    const edge = tile(await grab(t, (await t.run('make-seamless', { method: 'edge', width: 10 }, { image: tex })).image as ImageValue));
    const mirror = tile(await grab(t, (await t.run('make-seamless', { method: 'mirror' }, { image: tex })).image as ImageValue));
    writePng('game-assets/seamless-3x3', up(sheet([before, offset, edge, mirror], 4), 2), false);
    expect(before.width).toBe(144);
  });
});

/** The engine recycles results when the next evaluation runs: keep a copy as a plain picture. */
async function retain(t: Harness, image: ImageValue): Promise<ImageValue> {
  const p = await t.pixels(image);
  return t.fromFn(p.width, p.height, (x, y) => p.at(x, y));
}
