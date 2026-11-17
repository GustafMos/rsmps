/**
 * Sprite sheet assembly. Pure and deterministic (same frames and options give the same bytes), used by the app exporter and the CLI.
 *
 * Input: frames as straight RGBA8 bitmaps. Output: one or more page bitmaps and the placement of every frame.
 * Options: layout (grid / row / column / packed), trim of transparent borders, padding (gap between cells), extrude (edge pixels repeated
 * around every frame so texture filtering cannot pull in a neighbour), power-of-two pages, a maximum page size (more pages when needed) and
 * "bleed" (colour under fully transparent pixels = the nearest opaque colour, so bilinear filtering shows no dark fringe).
 *
 * With the default options the grid is exactly `layoutSheet` of `spritesheet.ts` (a test pins it).
 */
import { opaqueBounds } from '../engine/lib/sprite-sheet';

export interface Bitmap {
  width: number;
  height: number;
  /** Straight RGBA8, row 0 on top. */
  data: Uint8ClampedArray | Uint8Array;
}

export type SheetLayoutMode = 'grid' | 'row' | 'column' | 'pack';

export interface SheetBuildOptions {
  layout: SheetLayoutMode;
  /** Grid only: 0 = about square (ceil of the square root of the count). */
  columns: number;
  /** Gap between cells, texels. */
  padding: number;
  /** Edge pixels repeated around each frame, texels. */
  extrude: number;
  /** Cut away fully transparent borders (the frame's offset is kept in the metadata). */
  trim: boolean;
  powerOfTwo: boolean;
  /** Largest page width / height, 0 = unlimited. More pages are made when the frames do not fit. */
  maxSize: number;
  /** Fill the colour channels of fully transparent pixels with the nearest opaque colour. */
  bleed: boolean;
}

export const DEFAULT_SHEET_OPTIONS: SheetBuildOptions = { layout: 'grid', columns: 0, padding: 0, extrude: 0, trim: false, powerOfTwo: false, maxSize: 0, bleed: false };

export interface PlacedFrame {
  index: number;
  page: number;
  /** Rectangle of the frame's pixels on its page (without extrude). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where that rectangle sits inside the original frame. */
  offX: number;
  offY: number;
  srcW: number;
  srcH: number;
}

export interface SheetPage {
  index: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface SheetBuild {
  pages: SheetPage[];
  frames: PlacedFrame[];
  /** Grid layouts: columns / rows of the FIRST page and the cell size (including extrude). 0 for packed sheets. */
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

interface Piece {
  index: number;
  w: number;
  h: number;
  offX: number;
  offY: number;
  srcW: number;
  srcH: number;
  data: Uint8ClampedArray;
}

function cropPieces(frames: Bitmap[], trim: boolean): Piece[] {
  return frames.map((f, index) => {
    let rect = { x: 0, y: 0, w: f.width, h: f.height };
    if (trim) rect = opaqueBounds(f.data, f.width, f.height, 0) ?? { x: 0, y: 0, w: 1, h: 1 };
    const data = new Uint8ClampedArray(rect.w * rect.h * 4);
    for (let y = 0; y < rect.h; y++) {
      const from = ((rect.y + y) * f.width + rect.x) * 4;
      data.set(f.data.subarray(from, from + rect.w * 4), y * rect.w * 4);
    }
    return { index, w: rect.w, h: rect.h, offX: rect.x, offY: rect.y, srcW: f.width, srcH: f.height, data };
  });
}

interface Slot {
  piece: Piece;
  page: number;
  /** Top-left of the OUTER cell (extrude included). */
  x: number;
  y: number;
}

function placeGrid(pieces: Piece[], o: SheetBuildOptions): { slots: Slot[]; pageSizes: { w: number; h: number }[]; columns: number; rows: number; cellW: number; cellH: number } {
  const n = pieces.length;
  const e = o.extrude;
  const pad = o.padding;
  const cellW = Math.max(...pieces.map((p) => p.w)) + 2 * e;
  const cellH = Math.max(...pieces.map((p) => p.h)) + 2 * e;
  let cols = o.layout === 'row' ? n : o.layout === 'column' ? 1 : o.columns > 0 ? Math.min(n, Math.floor(o.columns)) : Math.min(n, Math.ceil(Math.sqrt(n)));
  let maxRows = Infinity;
  if (o.maxSize > 0) {
    const fitCols = Math.floor((o.maxSize + pad) / (cellW + pad));
    maxRows = Math.floor((o.maxSize + pad) / (cellH + pad));
    if (fitCols < 1 || maxRows < 1) throw new Error(`A frame (${cellW}x${cellH} with extrude) does not fit in a ${o.maxSize} texel sheet. Raise the maximum sheet size.`);
    cols = Math.min(cols, fitCols);
  }
  const perPage = Number.isFinite(maxRows) ? cols * maxRows : n;
  const slots: Slot[] = [];
  const pageSizes: { w: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    const page = Math.floor(i / perPage);
    const k = i - page * perPage;
    slots.push({ piece: pieces[i], page, x: (k % cols) * (cellW + pad), y: Math.floor(k / cols) * (cellH + pad) });
  }
  const pages = Math.ceil(n / perPage);
  for (let p = 0; p < pages; p++) {
    const count = Math.min(perPage, n - p * perPage);
    const c = Math.min(cols, count);
    const r = Math.ceil(count / cols);
    pageSizes.push({ w: c * cellW + (c - 1) * pad, h: r * cellH + (r - 1) * pad });
  }
  return { slots, pageSizes, columns: Math.min(cols, n), rows: Math.ceil(Math.min(n, perPage) / cols), cellW, cellH };
}

/** Shelf packer: tallest first, left to right, a new shelf when the row is full. Deterministic (ties by input order). */
function placePack(pieces: Piece[], o: SheetBuildOptions): { slots: Slot[]; pageSizes: { w: number; h: number }[] } {
  const e = o.extrude;
  const pad = o.padding;
  const outer = pieces.map((p) => ({ p, w: p.w + 2 * e, h: p.h + 2 * e }));
  const order = outer.slice().sort((a, b) => b.h - a.h || b.w - a.w || a.p.index - b.p.index);
  const maxW = Math.max(...outer.map((i) => i.w));
  let limitW: number;
  if (o.maxSize > 0) {
    if (maxW > o.maxSize || Math.max(...outer.map((i) => i.h)) > o.maxSize) throw new Error(`A frame does not fit in a ${o.maxSize} texel sheet. Raise the maximum sheet size.`);
    limitW = o.maxSize;
  } else {
    const area = outer.reduce((s, i) => s + (i.w + pad) * (i.h + pad), 0);
    limitW = Math.max(maxW, Math.ceil(Math.sqrt(area * 1.1)));
    if (o.powerOfTwo) limitW = nextPow2(limitW);
  }
  const limitH = o.maxSize > 0 ? o.maxSize : Infinity;
  const slots: Slot[] = [];
  const extents: { w: number; h: number }[] = [];
  let page = 0;
  let x = 0;
  let y = 0;
  let shelfH = 0;
  let usedW = 0;
  const closePage = () => {
    extents[page] = { w: usedW, h: y + shelfH };
  };
  for (const it of order) {
    if (x > 0 && x + it.w > limitW) {
      y += shelfH + pad;
      x = 0;
      shelfH = 0;
    }
    if (y + it.h > limitH) {
      closePage();
      page++;
      x = 0;
      y = 0;
      shelfH = 0;
      usedW = 0;
    }
    slots.push({ piece: it.p, page, x, y });
    x += it.w + pad;
    usedW = Math.max(usedW, x - pad);
    shelfH = Math.max(shelfH, it.h);
  }
  closePage();
  return { slots, pageSizes: extents };
}

/** Colour under transparency: every pixel with alpha 0 takes the RGB of the nearest opaque pixel (4-connected flood, deterministic). */
export function bleedTransparent(data: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
  const n = width * height;
  const queue = new Int32Array(n);
  const seen = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 0) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  if (tail === 0 || tail === n) return;
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    const r = data[p * 4];
    const g = data[p * 4 + 1];
    const b = data[p * 4 + 2];
    const visit = (q: number) => {
      if (seen[q]) return;
      seen[q] = 1;
      data[q * 4] = r;
      data[q * 4 + 1] = g;
      data[q * 4 + 2] = b;
      queue[tail++] = q;
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }
}

export function buildSheets(frames: Bitmap[], options: Partial<SheetBuildOptions> = {}): SheetBuild {
  if (!frames.length) throw new Error('A sprite sheet needs at least one frame.');
  const o: SheetBuildOptions = { ...DEFAULT_SHEET_OPTIONS, ...options };
  o.padding = Math.max(0, Math.floor(o.padding));
  o.extrude = Math.max(0, Math.floor(o.extrude));
  const pieces = cropPieces(frames, o.trim);

  let slots: Slot[];
  let sizes: { w: number; h: number }[];
  let columns = 0;
  let rows = 0;
  let cellWidth = 0;
  let cellHeight = 0;
  if (o.layout === 'pack') ({ slots, pageSizes: sizes } = placePack(pieces, o));
  else {
    const g = placeGrid(pieces, o);
    slots = g.slots;
    sizes = g.pageSizes;
    columns = g.columns;
    rows = g.rows;
    cellWidth = g.cellW;
    cellHeight = g.cellH;
  }
  if (o.powerOfTwo) sizes = sizes.map((s) => ({ w: nextPow2(s.w), h: nextPow2(s.h) }));
  const pages: SheetPage[] = sizes.map((s, index) => ({ index, width: s.w, height: s.h, data: new Uint8ClampedArray(s.w * s.h * 4) }));

  const placed: PlacedFrame[] = new Array(frames.length);
  const e = o.extrude;
  for (const s of slots) {
    const pg = pages[s.page];
    const { piece } = s;
    const x0 = s.x + e;
    const y0 = s.y + e;
    for (let y = -e; y < piece.h + e; y++) {
      const sy = Math.min(piece.h - 1, Math.max(0, y));
      for (let x = -e; x < piece.w + e; x++) {
        const sx = Math.min(piece.w - 1, Math.max(0, x));
        const from = (sy * piece.w + sx) * 4;
        const to = ((y0 + y) * pg.width + x0 + x) * 4;
        pg.data[to] = piece.data[from];
        pg.data[to + 1] = piece.data[from + 1];
        pg.data[to + 2] = piece.data[from + 2];
        pg.data[to + 3] = piece.data[from + 3];
      }
    }
    placed[piece.index] = { index: piece.index, page: s.page, x: x0, y: y0, w: piece.w, h: piece.h, offX: piece.offX, offY: piece.offY, srcW: piece.srcW, srcH: piece.srcH };
  }
  if (o.bleed) for (const pg of pages) bleedTransparent(pg.data, pg.width, pg.height);
  return { pages, frames: placed, columns, rows, cellWidth, cellHeight };
}

/**
 * Cut the frames back out of built pages, restoring trimmed borders (transparent). The inverse of `buildSheets` for the pixels that carry alpha
 * (bleed colour under alpha 0 is not restored: it is not part of the picture). Used by the round-trip tests and by tools that re-pack sheets.
 */
export function extractFrames(build: Pick<SheetBuild, 'pages' | 'frames'>): Bitmap[] {
  return build.frames.map((f) => {
    const pg = build.pages[f.page];
    const data = new Uint8ClampedArray(f.srcW * f.srcH * 4);
    for (let y = 0; y < f.h; y++) {
      const from = ((f.y + y) * pg.width + f.x) * 4;
      data.set(pg.data.subarray(from, from + f.w * 4), ((f.offY + y) * f.srcW + f.offX) * 4);
    }
    return { width: f.srcW, height: f.srcH, data };
  });
}
