/**
 * Autotile tables and the shared WGSL that composes a tile from five source pieces.
 *
 * Neighbour bitmask (8 bits, clockwise from north): N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128. A bit is set when that neighbour is terrain.
 * A diagonal bit only matters when both of its orthogonal neighbours are terrain ("reduced" mask), which leaves 47 distinct tiles: the blob set.
 * The 16-tile set uses the four orthogonal bits only (edge set): index = N + 2 E + 4 S + 8 W.
 *
 * Layouts (written by Autotile, read by Tileset Map):
 *   blob47  8 columns x 6 rows, tile i = the i-th reduced mask in ascending order (`BLOB47`), the last slot empty
 *   edge16  4 columns x 4 rows, tile i = the tile for the 4-bit mask i
 */

export const N = 1;
export const NE = 2;
export const E = 4;
export const SE = 8;
export const S = 16;
export const SW = 32;
export const W = 64;
export const NW = 128;

export type TileLayout = 'blob47' | 'edge16';

/** Clear every diagonal bit whose two orthogonal neighbours are not both set. */
export function reduceMask(m: number): number {
  let r = m & (N | E | S | W);
  if (m & NE && m & N && m & E) r |= NE;
  if (m & SE && m & S && m & E) r |= SE;
  if (m & SW && m & S && m & W) r |= SW;
  if (m & NW && m & N && m & W) r |= NW;
  return r;
}

/** The 47 reduced masks, ascending. */
export const BLOB47: readonly number[] = (() => {
  const set = new Set<number>();
  for (let m = 0; m < 256; m++) set.add(reduceMask(m));
  return [...set].sort((a, b) => a - b);
})();

/** Reduced mask -> tile index in the blob set (-1 for masks that are not reduced). */
export const BLOB47_INDEX: readonly number[] = (() => {
  const t = new Array<number>(256).fill(-1);
  BLOB47.forEach((m, i) => (t[m] = i));
  return t;
})();

/** Index of the 16-set tile for an 8-bit mask: N=1, E=2, S=4, W=8. */
export function edge16Index(m: number): number {
  return (m & N ? 1 : 0) | (m & E ? 2 : 0) | (m & S ? 4 : 0) | (m & W ? 8 : 0);
}

/** The full 8-bit mask a 16-set tile stands for (a diagonal counts as terrain when both its orthogonal neighbours are). */
export function edge16Mask(i: number): number {
  let m = (i & 1 ? N : 0) | (i & 2 ? E : 0) | (i & 4 ? S : 0) | (i & 8 ? W : 0);
  if (m & N && m & E) m |= NE;
  if (m & S && m & E) m |= SE;
  if (m & S && m & W) m |= SW;
  if (m & N && m & W) m |= NW;
  return m;
}

export interface LayoutInfo {
  count: number;
  columns: number;
  rows: number;
}
export const LAYOUTS: Record<TileLayout, LayoutInfo> = { blob47: { count: 47, columns: 8, rows: 6 }, edge16: { count: 16, columns: 4, rows: 4 } };

/** Tile index for a neighbour mask in a layout. */
export function tileIndex(layout: TileLayout, mask: number): number {
  return layout === 'blob47' ? BLOB47_INDEX[reduceMask(mask)] : edge16Index(mask);
}

/** The reduced 8-bit mask each tile index of a layout stands for. */
export function layoutMasks(layout: TileLayout): number[] {
  return layout === 'blob47' ? BLOB47.slice() : Array.from({ length: 16 }, (_, i) => edge16Mask(i));
}

/** Mask from the eight neighbours (true = terrain). */
export function maskOf(n: { n: boolean; ne: boolean; e: boolean; se: boolean; s: boolean; sw: boolean; w: boolean; nw: boolean }): number {
  return (n.n ? N : 0) | (n.ne ? NE : 0) | (n.e ? E : 0) | (n.se ? SE : 0) | (n.s ? S : 0) | (n.sw ? SW : 0) | (n.w ? W : 0) | (n.nw ? NW : 0);
}

/**
 * WGSL: `composeTile(mask, lx, ly, T)` builds one tile of a set from five pieces laid side by side in the texture `src` (each T x T):
 * 0 center, 1 edge (terrain below, empty above), 2 outer corner (convex, empty to the north and west), 3 inner corner (terrain all around except
 * the north-west diagonal), 4 single (an isolated tile). Every quarter of a tile is taken from a piece rotated by whole quarter turns:
 *   both orthogonal neighbours empty                  -> outer corner turned to this quarter
 *   one empty                                         -> edge turned to face the empty side
 *   both terrain, diagonal empty                      -> inner corner turned to this quarter
 *   both terrain, diagonal terrain                    -> center
 * A tile with no terrain neighbour at all is the single piece as it is. Needs the texture `src` in the pass.
 */
export const COMPOSE_TILE_WGSL = /* wgsl */ `
fn srcPoint(p: vec2i, k: i32, t: i32) -> vec2i {
  if (k == 0) { return p; }
  if (k == 1) { return vec2i(p.y, t - 1 - p.x); }
  if (k == 2) { return vec2i(t - 1 - p.x, t - 1 - p.y); }
  return vec2i(t - 1 - p.y, p.x);
}
fn pieceAt(i: i32, p: vec2i, k: i32, t: i32) -> vec4f {
  let q = srcPoint(p, k, t);
  return textureLoad(src, vec2i(i * t + q.x, q.y), 0);
}
fn composeTile(mask: i32, lx: i32, ly: i32, t: i32) -> vec4f {
  let p = vec2i(lx, ly);
  if (mask == 0) { return pieceAt(4, p, 0, t); }
  let right = lx * 2 >= t;
  let low = ly * 2 >= t;
  var q = 0;
  if (!low && right) { q = 1; }
  if (low && right) { q = 2; }
  if (low && !right) { q = 3; }
  var bitA = 1;   // N
  var bitB = 64;  // W
  var bitD = 128; // NW
  var dirA = 0;
  var dirB = 3;
  if (q == 1) { bitB = 4; bitD = 2; dirB = 1; }
  if (q == 2) { bitA = 16; bitB = 4; bitD = 8; dirA = 2; dirB = 1; }
  if (q == 3) { bitA = 16; bitD = 32; dirA = 2; }
  let fa = (mask & bitA) != 0;
  let fb = (mask & bitB) != 0;
  let fd = (mask & bitD) != 0;
  if (!fa && !fb) { return pieceAt(2, p, q, t); }
  if (fa && fb) {
    if (fd) { return pieceAt(0, p, 0, t); }
    return pieceAt(3, p, q, t);
  }
  if (fa) { return pieceAt(1, p, dirB, t); }
  return pieceAt(1, p, dirA, t);
}
`;
