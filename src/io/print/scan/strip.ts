/** Data-strip decoding from a brightness sampler in page millimetres. Pure. */
import { STRIP_COLS, STRIP_MODULE_MM, STRIP_ROWS, decodeHeader, stripBytes, stripOriginMm, type SheetHeader } from '../format';

const SHIFTS: [number, number][] = [
  [0, 0],
  [0.25, 0],
  [-0.25, 0],
  [0, 0.25],
  [0, -0.25],
  [0.25, 0.25],
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
];

/**
 * Sample every module of the strip (3x3 sub-samples), self-calibrate the threshold from the timing row and
 * column, and verify the CRC. `sample(xMm, yMm)` returns brightness (any scale) at a page position.
 * A few sub-module shifts are tried to absorb small alignment errors. Returns null when nothing decodes.
 */
export function decodeStrip(sample: (xMm: number, yMm: number) => number, pageWidthMm: number): SheetHeader | null {
  const o = stripOriginMm(pageWidthMm);
  const m = STRIP_MODULE_MM;
  for (const [sx, sy] of SHIFTS) {
    const vals = new Float32Array(STRIP_COLS * STRIP_ROWS);
    for (let r = 0; r < STRIP_ROWS; r++) {
      for (let c = 0; c < STRIP_COLS; c++) {
        const cx = o.x + (c + 0.5 + sx) * m;
        const cy = o.y + (r + 0.5 + sy) * m;
        let s = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += sample(cx + i * 0.22 * m, cy + j * 0.22 * m);
        vals[r * STRIP_COLS + c] = s / 9;
      }
    }
    let bs = 0;
    let bn = 0;
    let ws = 0;
    let wn = 0;
    const timing = (idx: number, black: boolean) => {
      if (black) {
        bs += vals[idx];
        bn++;
      } else {
        ws += vals[idx];
        wn++;
      }
    };
    for (let c = 0; c < STRIP_COLS; c++) timing(c, c % 2 === 0);
    for (let r = 1; r < STRIP_ROWS; r++) timing(r * STRIP_COLS, r % 2 === 0);
    const black = bs / bn;
    const white = ws / wn;
    if (white - black < 15) continue;
    const thr = (black + white) / 2;
    const grid = new Uint8Array(STRIP_COLS * STRIP_ROWS);
    for (let i = 0; i < grid.length; i++) grid[i] = vals[i] < thr ? 1 : 0;
    const header = decodeHeader(stripBytes(grid));
    if (header) return header;
  }
  return null;
}
