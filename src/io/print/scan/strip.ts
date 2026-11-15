/** Data-strip location and decoding. Pure. */
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
  return decodeStripGrid(sample, o.x, o.y, STRIP_MODULE_MM, STRIP_MODULE_MM);
}

/** Like `decodeStrip` with the strip's top-left corner and module size given in the sampler's own units. */
export function decodeStripGrid(sample: (x: number, y: number) => number, ox: number, oy: number, mx: number, my: number): SheetHeader | null {
  for (const [sx, sy] of SHIFTS) {
    const vals = new Float32Array(STRIP_COLS * STRIP_ROWS);
    for (let r = 0; r < STRIP_ROWS; r++) {
      for (let c = 0; c < STRIP_COLS; c++) {
        const cx = ox + (c + 0.5 + sx) * mx;
        const cy = oy + (r + 0.5 + sy) * my;
        let s = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += sample(cx + i * 0.22 * mx, cy + j * 0.22 * my);
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

/** Otsu threshold of values in 0..255. */
export function otsu(values: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, Math.round(values[i])))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0;
  let sB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += t * hist[t];
    const d = sB / wB - (sum - sB) / wF;
    const v = wB * wF * d * d;
    if (v > best) {
      best = v;
      thr = t;
    }
  }
  return thr;
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) {
      if (src[row + x]) last = x;
      if (x - last <= r) tmp[row + x] = 1;
    }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (src[row + x]) last = x;
      if (last - x <= r) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Find the data strip in a greyscale crop (`ppm` pixels per mm): threshold, bridge the gaps between modules by
 * dilation, take the blob with the most ink. Returns the ink's bounding box in px. A decoy blob (a "+" mark) may
 * touch the strip from below, so callers rely only on left, top and width.
 */
export function findStripBox(gray: ArrayLike<number>, w: number, h: number, ppm: number): { x0: number; y0: number; x1: number; y1: number; mask: Uint8Array } | null {
  const thr = otsu(gray);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < thr ? 1 : 0;
  const dil = dilate(ink, w, h, Math.max(1, Math.round(1.0 * ppm)));
  const label = new Int32Array(w * h);
  let best: { x0: number; y0: number; x1: number; y1: number; mass: number; id: number } | null = null;
  const stack: number[] = [];
  let id = 0;
  for (let i = 0; i < w * h; i++) {
    if (!dil[i] || label[i]) continue;
    id++;
    stack.push(i);
    label[i] = id;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let mass = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      if (ink[p]) {
        mass++;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      const nb: number[] = [];
      if (px > 0) nb.push(p - 1);
      if (px < w - 1) nb.push(p + 1);
      if (py > 0) nb.push(p - w);
      if (py < h - 1) nb.push(p + w);
      for (const q of nb) {
        if (label[q] || !dil[q]) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    if (mass > 0 && (!best || mass > best.mass)) best = { x0, y0, x1, y1, mass, id };
  }
  if (!best) return null;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (ink[i] && label[i] === best.id) mask[i] = 1;
  return { x0: best.x0, y0: best.y0, x1: best.x1 + 1, y1: best.y1 + 1, mask };
}

export interface StripPlacement {
  /** Top-left corner of the strip's ink, px. */
  ox: number;
  oy: number;
  /** Module size, px. */
  m: number;
  /** Tilt of the top edge (dy/dx) and of the left edge (dx/dy). */
  slopeY: number;
  slopeX: number;
}

/**
 * Place the strip precisely: its left, top and right ink edges (the timing row/column are black at the corners)
 * give origin, module size and the small shear a curled sheet leaves after rectification.
 */
export function placeStrip(gray: ArrayLike<number>, w: number, h: number, ppm: number): StripPlacement | null {
  const box = findStripBox(gray, w, h, ppm);
  if (!box) return null;
  const { mask } = box;
  const bw = box.x1 - box.x0;
  const quart = (arr: number[]) => {
    const v = [...arr].sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length * 0.2)] : NaN;
  };
  const topAt = (xa: number, xb: number) => {
    const ys: number[] = [];
    for (let x = xa; x < xb; x++) for (let y = box.y0; y < box.y1; y++) if (mask[y * w + x]) { ys.push(y); break; }
    return quart(ys);
  };
  const g = Math.max(3, Math.round(bw * 0.12));
  const yL = topAt(box.x0, box.x0 + g);
  const yR = topAt(box.x1 - g, box.x1);
  const xl = box.x0 + g / 2;
  const xr = box.x1 - g / 2;
  const slopeY = (yR - yL) / (xr - xl);
  const m0 = bw / 41;
  const rowsAt = (ya: number, yb: number) => {
    const xs: number[] = [];
    for (let y = ya; y < yb; y++) for (let x = box.x0; x < box.x1; x++) if (mask[y * w + x]) { xs.push(x); break; }
    return quart(xs);
  };
  const ya = Math.round(box.y0 + 0.2 * m0);
  const yb = Math.round(box.y0 + 2.2 * m0);
  const yc = Math.round(box.y0 + 4.2 * m0);
  const yd = Math.round(box.y0 + 6.2 * m0);
  const xT = rowsAt(ya, yb);
  const xB = rowsAt(yc, yd);
  const slopeX = Number.isFinite(xT) && Number.isFinite(xB) ? (xB - xT) / (((yc + yd) / 2) - ((ya + yb) / 2)) : 0;
  if (!Number.isFinite(slopeY) || Math.abs(slopeY) > 0.12 || Math.abs(slopeX) > 0.12) return null;
  const oy = yL - slopeY * (xl - box.x0);
  const ox = (Number.isFinite(xT) ? xT : box.x0) - slopeX * (((ya + yb) / 2) - box.y0);
  return { ox, oy, m: (box.x1 - ox) / 41, slopeY, slopeX };
}
