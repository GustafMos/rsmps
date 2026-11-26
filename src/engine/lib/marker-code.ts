/**
 * The square marker of Marker Camera (pure). Our own small code, not a copy of any library's dictionary.
 *
 * A marker is a grid of 6 x 6 cells: a black border one cell thick and 4 x 4 data cells inside (1 = white). It is meant to be
 * printed with a white margin of at least one cell around it (the "quiet zone"): the detector looks for a dark square on a light
 * ground.
 *
 * The data cells are read row by row from the top-left, most significant bit first. The codes below were found by a greedy search
 * over all 16-bit patterns with these rules, which the unit test re-checks:
 *  - every code differs from every other code, in every rotation AND mirrored, in at least 6 cells;
 *  - every code differs from its own three other rotations and from its own mirror images in at least 6 cells. That is what makes
 *    "which side is up" certain, and lets the detector tell a mirrored picture (a front camera) from a true one;
 *  - between 6 and 10 of the 16 cells are white, so every marker has clear detail inside.
 * With 6 cells between any two readings, one wrongly read cell can be corrected safely.
 */
export const MARKER_CELLS = 6;
export const MARKER_DATA = 4;
export const MARKER_CODES: readonly number[] = [0x47d0, 0x84f8, 0xce0f, 0xef14, 0x7845, 0xac2c];
export const MARKER_COUNT = MARKER_CODES.length;
/** Cells that may be read wrongly and still be accepted. */
export const MARKER_MAX_ERRORS = 1;

const bitAt = (code: number, x: number, y: number): number => (code >> (15 - (y * 4 + x))) & 1;

/** The code turned a quarter turn clockwise (as the eye sees the picture turn). */
export function rotateCode(code: number): number {
  let o = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (bitAt(code, y, 3 - x)) o |= 1 << (15 - (y * 4 + x));
  return o;
}

/** The code flipped left to right. */
export function mirrorCode(code: number): number {
  let o = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (bitAt(code, 3 - x, y)) o |= 1 << (15 - (y * 4 + x));
  return o;
}

export function bitCount(v: number): number {
  let n = 0;
  for (let b = v & 0xffff; b; b >>= 1) n += b & 1;
  return n;
}

/** Is cell (x, y) of marker `id` white? (0, 0) is the top-left cell of the 6 x 6 grid; the border is black. */
export function markerCellWhite(id: number, x: number, y: number): boolean {
  if (x < 1 || y < 1 || x > MARKER_DATA || y > MARKER_DATA) return false;
  return bitAt(MARKER_CODES[((id % MARKER_COUNT) + MARKER_COUNT) % MARKER_COUNT], x - 1, y - 1) === 1;
}

export interface CodeMatch {
  id: number;
  /** Quarter turns clockwise by which the read grid is turned against the upright marker (0..3). */
  turns: number;
  /** The read grid is a mirror image (a mirrored camera picture). */
  mirrored: boolean;
  /** Cells that differ from the perfect marker. */
  errors: number;
}

interface Variant extends Omit<CodeMatch, 'errors'> {
  code: number;
}
let variants: Variant[] | null = null;
function allVariants(): Variant[] {
  if (variants) return variants;
  variants = [];
  for (let id = 0; id < MARKER_COUNT; id++) {
    let a = MARKER_CODES[id];
    // a mirrored picture of the upright marker, then turned: the detector undoes the mirror first, then the turns
    let b = mirrorCode(MARKER_CODES[id]);
    for (let turns = 0; turns < 4; turns++) {
      variants.push({ id, turns, mirrored: false, code: a }, { id, turns, mirrored: true, code: b });
      a = rotateCode(a);
      b = rotateCode(b);
    }
  }
  return variants;
}

/**
 * Which marker is this 16-bit grid, as read row by row from the picture? Null when it is not one of ours.
 * `mirrored` variants are "the upright marker flipped left to right, then turned `turns` quarter turns clockwise".
 */
export function matchCode(read: number, allowMirror = true): CodeMatch | null {
  let best: CodeMatch | null = null;
  for (const v of allVariants()) {
    if (v.mirrored && !allowMirror) continue;
    const errors = bitCount(v.code ^ read);
    if (errors <= MARKER_MAX_ERRORS && (!best || errors < best.errors)) best = { id: v.id, turns: v.turns, mirrored: v.mirrored, errors };
  }
  return best;
}

/**
 * The marker as a greyscale picture (0 = black, 255 = white), `cell` pixels per cell, with `quiet` white cells around it.
 * Used by the printable sheet and by tests; the Marker node draws the same cells on the GPU.
 */
export function markerBitmap(id: number, cell: number, quiet = 1): { data: Uint8Array; size: number } {
  const n = MARKER_CELLS + quiet * 2;
  const size = n * cell;
  const data = new Uint8Array(size * size).fill(255);
  for (let cy = 0; cy < MARKER_CELLS; cy++)
    for (let cx = 0; cx < MARKER_CELLS; cx++) {
      if (markerCellWhite(id, cx, cy)) continue;
      for (let y = 0; y < cell; y++) data.fill(0, ((cy + quiet) * cell + y) * size + (cx + quiet) * cell, ((cy + quiet) * cell + y) * size + (cx + quiet + 1) * cell);
    }
  return { data, size };
}
