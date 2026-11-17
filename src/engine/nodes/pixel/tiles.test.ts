import { describe, expect, it } from 'vitest';
import { BLOB47, BLOB47_INDEX, E, N, NE, NW, S, SE, SW, W, edge16Index, edge16Mask, layoutMasks, maskOf, reduceMask, tileIndex } from '../../lib/autotile';
import { crispResize } from '../../lib/art-grid';
import { harness, type Harness } from '../../testing';
import type { ImageValue } from '../../types';

type Px = [number, number, number, number];
const G: Px = [0, 160, 0, 255];
const CLEAR: Px = [0, 0, 0, 0];

describe('autotile tables', () => {
  it('reduces diagonals that have no orthogonal support', () => {
    expect(reduceMask(255)).toBe(255);
    expect(reduceMask(N | E)).toBe(5);
    expect(reduceMask(N | E | NE)).toBe(7);
    expect(reduceMask(NE)).toBe(0);
    expect(reduceMask(N | NE)).toBe(N);
    expect(reduceMask(N | E | S | W)).toBe(85);
    expect(reduceMask(255 & ~NE)).toBe(253);
    expect(reduceMask(S | W | SW | NW)).toBe(S | W | SW);
  });

  it('the blob set is exactly the 47 hand-checked masks', () => {
    const hand = [0, 1, 4, 5, 7, 16, 17, 20, 21, 23, 28, 29, 31, 64, 65, 68, 69, 71, 80, 81, 84, 85, 87, 92, 93, 95, 112, 113, 116, 117, 119, 124, 125, 127, 193, 197, 199, 209, 213, 215, 221, 223, 241, 245, 247, 253, 255];
    expect(hand).toHaveLength(47);
    expect([...BLOB47]).toEqual(hand);
    expect(BLOB47_INDEX[0]).toBe(0);
    expect(BLOB47_INDEX[255]).toBe(46);
    expect(BLOB47_INDEX[85]).toBe(21);
    expect(BLOB47_INDEX[2]).toBe(-1);
  });

  it('every one of the 256 neighbourhoods maps to a tile that shows exactly that neighbourhood', () => {
    const seen = new Set<number>();
    for (let m = 0; m < 256; m++) {
      const i = tileIndex('blob47', m);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(47);
      seen.add(i);
      expect(BLOB47[i]).toBe(reduceMask(m));
      expect(tileIndex('edge16', m)).toBe(edge16Index(m));
    }
    expect(seen.size).toBe(47);
  });

  it('neighbours to index: hand-checked cases', () => {
    const t = (n: Partial<Parameters<typeof maskOf>[0]>) => maskOf({ n: false, ne: false, e: false, se: false, s: false, sw: false, w: false, nw: false, ...n });
    expect(tileIndex('blob47', t({}))).toBe(0);
    expect(tileIndex('blob47', t({ n: true }))).toBe(1);
    expect(tileIndex('blob47', t({ n: true, e: true, ne: true }))).toBe(4);
    expect(tileIndex('blob47', t({ n: true, e: true }))).toBe(3);
    expect(tileIndex('blob47', t({ n: true, e: true, s: true, w: true }))).toBe(21);
    expect(tileIndex('blob47', t({ n: true, e: true, s: true, w: true, ne: true, se: true, sw: true, nw: true }))).toBe(46);
    expect(tileIndex('edge16', t({ n: true }))).toBe(1);
    expect(tileIndex('edge16', t({ e: true, w: true }))).toBe(10);
    expect(tileIndex('edge16', t({ n: true, e: true, s: true, w: true }))).toBe(15);
    expect(edge16Mask(15)).toBe(255);
    expect(edge16Mask(3)).toBe(N | E | NE);
    expect(layoutMasks('edge16')).toHaveLength(16);
    expect(layoutMasks('blob47')).toHaveLength(47);
    expect([SE, SW, NW, S, W].every(Number.isInteger)).toBe(true);
  });
});

/** Five 4x4 pieces in a row: center, edge (empty top row), outer corner (empty top row and left column), inner corner (empty NW pixel), single (2x2 island). */
function pieces(t: Harness): ImageValue {
  const rows = [
    ['GGGG', 'GGGG', 'GGGG', 'GGGG'],
    ['....', 'GGGG', 'GGGG', 'GGGG'],
    ['....', '.GGG', '.GGG', '.GGG'],
    ['.GGG', 'GGGG', 'GGGG', 'GGGG'],
    ['....', '.GG.', '.GG.', '....'],
  ];
  return t.fromFn(20, 4, (x, y) => (rows[Math.floor(x / 4)][y][x % 4] === 'G' ? G : CLEAR));
}

async function tile(t: Harness, set: ImageValue, col: number, row: number, T: number): Promise<string[]> {
  const px = await t.pixels(set);
  const out: string[] = [];
  for (let y = 0; y < T; y++) {
    let r = '';
    for (let x = 0; x < T; x++) r += px.at(col * T + x, row * T + y)[3] ? 'G' : '.';
    out.push(r);
  }
  return out;
}

describe('autotile', () => {
  it('builds the 47 set: 8 x 6 grid, tile i = i-th reduced mask', async () => {
    const t = await harness();
    const o = await t.run('autotile', { layout: 'blob47' }, { image: pieces(t) });
    const set = o.image as ImageValue;
    expect([set.width, set.height, o.tiles, o.columns]).toEqual([32, 24, 47, 8]);
    const at = (mask: number) => tile(t, set, BLOB47_INDEX[mask] % 8, Math.floor(BLOB47_INDEX[mask] / 8), 4);
    expect(await at(0)).toEqual(['....', '.GG.', '.GG.', '....']);
    expect(await at(255)).toEqual(['GGGG', 'GGGG', 'GGGG', 'GGGG']);
    expect(await at(85)).toEqual(['.GG.', 'GGGG', 'GGGG', '.GG.']);
    expect(await at(N)).toEqual(['.GG.', '.GG.', '.GG.', '....']);
    expect(await at(N | E | NE)).toEqual(['.GGG', '.GGG', '.GGG', '....']);
    expect(await at(S | E | SE)).toEqual(['....', '.GGG', '.GGG', '.GGG']);
    expect(await at(255 & ~NW)).toEqual(['.GGG', 'GGGG', 'GGGG', 'GGGG']);
    expect((await t.pixels(set)).at(31, 23)[3]).toBe(0); // the 48th slot stays empty
  });

  it('the 16 set: tile number = N + 2E + 4S + 8W, no inner corners', async () => {
    const t = await harness();
    const o = await t.run('autotile', { layout: 'edge16' }, { image: pieces(t) });
    const set = o.image as ImageValue;
    expect([set.width, set.height, o.tiles]).toEqual([16, 16, 16]);
    expect(await tile(t, set, 0, 0, 4)).toEqual(['....', '.GG.', '.GG.', '....']);
    expect(await tile(t, set, 1, 0, 4)).toEqual(['.GG.', '.GG.', '.GG.', '....']);
    expect(await tile(t, set, 2, 0, 4)).toEqual(['....', '.GGG', '.GGG', '....']);
    expect(await tile(t, set, 3, 3, 4)).toEqual(['GGGG', 'GGGG', 'GGGG', 'GGGG']);
  });

  it('spacing leaves empty rows and columns between tiles; a bad picture is refused with a reason', async () => {
    const t = await harness();
    const o = await t.run('autotile', { layout: 'edge16', spacing: 1 }, { image: pieces(t) });
    expect([(o.image as ImageValue).width, (o.image as ImageValue).height]).toEqual([4 * 4 + 3, 4 * 4 + 3]);
    const px = await t.pixels(o.image as ImageValue);
    for (let y = 0; y < px.height; y++) expect(px.at(4, y)[3]).toBe(0);
    await expect(t.run('autotile', {}, { image: t.solid(10, 4, [255, 0, 0, 255]) })).rejects.toThrow(/five 4x4 pieces/);
  });
});

describe('tileset-map', () => {
  /** The tileset as a retained picture (the engine recycles results). */
  async function tileset(t: Harness, layout: string): Promise<ImageValue> {
    const o = await t.run('autotile', { layout }, { image: pieces(t) });
    const px = await t.pixels(o.image as ImageValue);
    return t.fromFn(px.width, px.height, (x, y) => px.at(x, y));
  }
  const WHITE: Px = [255, 255, 255, 255];
  const BLACK: Px = [0, 0, 0, 255];

  it('paints a 2x2 block of terrain with the right tile in every cell', async () => {
    const t = await harness();
    const set = await tileset(t, 'blob47');
    const map = t.fromFn(4, 4, (x, y) => (x >= 1 && x <= 2 && y >= 1 && y <= 2 ? WHITE : BLACK));
    const o = await t.run('tileset-map', { layout: 'blob47' }, { terrain: map, tileset: set });
    const img = o.image as ImageValue;
    expect([img.width, img.height, o.cellsX, o.cellsY]).toEqual([16, 16, 4, 4]);
    expect(await tile(t, img, 1, 1, 4)).toEqual(['....', '.GGG', '.GGG', '.GGG']);
    expect(await tile(t, img, 2, 1, 4)).toEqual(['....', 'GGG.', 'GGG.', 'GGG.']);
    expect(await tile(t, img, 1, 2, 4)).toEqual(['.GGG', '.GGG', '.GGG', '....']);
    expect(await tile(t, img, 2, 2, 4)).toEqual(['GGG.', 'GGG.', 'GGG.', '....']);
    expect(await tile(t, img, 0, 0, 4)).toEqual(['....', '....', '....', '....']);
    expect(await tile(t, img, 3, 3, 4)).toEqual(['....', '....', '....', '....']);
  });

  it('a lone cell is the single tile; a plus shape gets inner corners in the middle and ends on the arms', async () => {
    const t = await harness();
    const set = await tileset(t, 'blob47');
    const lone = t.fromFn(3, 3, (x, y) => (x === 1 && y === 1 ? WHITE : BLACK));
    expect(await tile(t, (await t.run('tileset-map', {}, { terrain: lone, tileset: set })).image as ImageValue, 1, 1, 4)).toEqual(['....', '.GG.', '.GG.', '....']);
    const plus = t.fromFn(3, 3, (x, y) => (x === 1 || y === 1 ? WHITE : BLACK));
    const img = (await t.run('tileset-map', {}, { terrain: plus, tileset: set })).image as ImageValue;
    expect(await tile(t, img, 1, 1, 4)).toEqual(['.GG.', 'GGGG', 'GGGG', '.GG.']);
    expect(await tile(t, img, 1, 0, 4)).toEqual(['....', '.GG.', '.GG.', '.GG.']);
    expect(await tile(t, img, 0, 0, 4)).toEqual(['....', '....', '....', '....']);
  });

  it('mask cells larger than one pixel, the 16 set, and terrain beyond the border', async () => {
    const t = await harness();
    const set = await tileset(t, 'edge16');
    const map = t.fromFn(8, 8, (x) => (x < 4 ? WHITE : BLACK)); // left half terrain; 4 px cells -> a 2 x 2 map
    const o = await t.run('tileset-map', { layout: 'edge16', mapCell: 4 }, { terrain: map, tileset: set });
    expect([(o.image as ImageValue).width, o.cellsX, o.cellsY]).toEqual([8, 2, 2]);
    expect(await tile(t, o.image as ImageValue, 0, 0, 4)).toEqual(['....', '.GG.', '.GG.', '.GG.']);
    expect(await tile(t, o.image as ImageValue, 1, 0, 4)).toEqual(['....', '....', '....', '....']);
    const wrap = await t.run('tileset-map', { layout: 'edge16', mapCell: 4, outside: 'terrain' }, { terrain: map, tileset: set });
    expect(await tile(t, wrap.image as ImageValue, 0, 0, 4)).toEqual(['GGG.', 'GGG.', 'GGG.', 'GGG.']);
  });
});

/** A smooth non-tiling picture: a diagonal ramp plus a hash-like ripple. */
function ramp(t: Harness, n: number): ImageValue {
  return t.fromFn(n, n, (x, y) => [Math.round((x / (n - 1)) * 255), Math.round((y / (n - 1)) * 255), 40 + (((x + y) & 7) * 2), 255]);
}

describe('make-seamless', () => {
  const edgeGap = async (t: Harness, img: ImageValue) => {
    const px = await t.pixels(img);
    let worstX = 0;
    let worstY = 0;
    for (let k = 0; k < px.height; k++) for (let c = 0; c < 3; c++) worstX = Math.max(worstX, Math.abs(px.at(0, k)[c] - px.at(px.width - 1, k)[c]));
    for (let k = 0; k < px.width; k++) for (let c = 0; c < 3; c++) worstY = Math.max(worstY, Math.abs(px.at(k, 0)[c] - px.at(k, px.height - 1)[c]));
    return { x: worstX, y: worstY };
  };

  it('offset blend: the picture went from a hard seam to borders that continue into each other', async () => {
    const t = await harness();
    const src = ramp(t, 32);
    const before = await edgeGap(t, src);
    expect(before.x).toBeGreaterThan(200);
    const o = (await t.run('make-seamless', { method: 'offset' }, { image: src })).image as ImageValue;
    expect([o.width, o.height, o.unit]).toEqual([32, 32, 1]);
    const after = await edgeGap(t, o);
    expect(after.x).toBeLessThanOrEqual(16); // neighbouring source pixels (one ramp step is 8)
    expect(after.y).toBeLessThanOrEqual(16);
  });

  it('mirror: opposite borders are the same pixels', async () => {
    const t = await harness();
    const o = (await t.run('make-seamless', { method: 'mirror' }, { image: ramp(t, 16) })).image as ImageValue;
    expect(await edgeGap(t, o)).toEqual({ x: 0, y: 0 });
  });

  it('edge match: borders agree to within a level, the middle of the picture is untouched', async () => {
    const t = await harness();
    const src = ramp(t, 32);
    const o = (await t.run('make-seamless', { method: 'edge', width: 8 }, { image: src })).image as ImageValue;
    const gap = await edgeGap(t, o);
    expect(gap.x).toBeLessThanOrEqual(2);
    expect(gap.y).toBeLessThanOrEqual(2);
    const a = await t.pixels(src);
    const b = await t.pixels(o);
    expect(b.at(16, 16)).toEqual(a.at(16, 16));
  });

  it('one axis only leaves the other borders alone', async () => {
    const t = await harness();
    const src = ramp(t, 32);
    const o = (await t.run('make-seamless', { method: 'offset', axis: 'x' }, { image: src })).image as ImageValue;
    const gap = await edgeGap(t, o);
    expect(gap.x).toBeLessThanOrEqual(16);
    expect(gap.y).toBeGreaterThan(200);
  });

  it('pixel art mode never makes a new color', async () => {
    const t = await harness();
    const palette: Px[] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [250, 250, 20, 255]];
    const art = t.fromFn(24, 24, (x, y) => palette[((x * 5 + y * 3) ^ (x >> 2)) & 3]);
    const allowed = new Set(palette.map((c) => c.join(',')));
    for (const params of [{ method: 'offset', hard: true }, { method: 'edge', hard: true, width: 6 }, { method: 'mirror' }]) {
      const px = await t.pixels((await t.run('make-seamless', params, { image: art })).image as ImageValue);
      const bad: string[] = [];
      for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (!allowed.has(px.at(x, y).join(','))) bad.push(`${x},${y}`);
      expect(bad, JSON.stringify(params)).toEqual([]);
    }
  });

  it('works on an art grid: same size, the grid stays, no new colors, borders match on the grid', async () => {
    const t = await harness();
    const palette: Px[] = [[255, 0, 0, 255], [0, 0, 255, 255]];
    const art = t.fromFn(16, 16, (x, y) => palette[(x + y * 2) & 1]);
    const big = { ...crispResize(t.gpu as never, art, { width: 64, height: 64, unit: 1 }), cell: 4 };
    t.gpu.retain(big.texture);
    const o = (await t.run('make-seamless', { method: 'offset' }, { image: big })).image as ImageValue;
    expect([o.width, o.height, o.cell]).toEqual([64, 64, 4]);
    const px = await t.pixels(o);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) expect(['255,0,0', '0,0,255']).toContain(px.at(x, y).slice(0, 3).join(','));
    expect(px.at(0, 0).join()).toBe(px.at(3, 3).join()); // 4 x 4 texels per art pixel
  });
});
