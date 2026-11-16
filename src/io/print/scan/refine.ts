/**
 * Sub-pixel template matching (normalised cross-correlation) used to locate the corner finders and the
 * "+" registration marks in the rectified page. Pure.
 */
import { FID_MODULE_MM } from '../format';
import { drawFinder, drawMark } from '../render';
import { createRaster, toGray8 } from '../raster';

export interface Template {
  width: number;
  height: number;
  /** Zero-mean template values. */
  data: Float32Array;
  /** sqrt(sum of squares) of `data`. */
  norm: number;
}

export interface Match {
  /** Centre of the match in image coordinates (continuous). */
  x: number;
  y: number;
  /** NCC score in -1..1. */
  score: number;
}

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += src[Math.min(h - 1, Math.max(0, y + j)) * w + Math.min(w - 1, Math.max(0, x + i))];
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

function toTemplate(gray: Float32Array, w: number, h: number): Template {
  const b = blur3(gray, w, h);
  let mean = 0;
  for (const v of b) mean += v;
  mean /= b.length;
  let n2 = 0;
  for (let i = 0; i < b.length; i++) {
    b[i] -= mean;
    n2 += b[i] * b[i];
  }
  return { width: w, height: h, data: b, norm: Math.sqrt(n2) };
}

function grayOf(img: ReturnType<typeof createRaster>): Float32Array {
  const g = toGray8(img);
  return Float32Array.from(g);
}

/** Template of a "+" mark at `pxPerMm`, with `padMm` of paper around the arms. */
export function markTemplate(pxPerMm: number, halfMm: number, thickMm: number, padMm = 0.5): Template {
  const side = Math.max(8, Math.round(2 * (halfMm + padMm) * pxPerMm));
  const mm = side / pxPerMm;
  const img = createRaster(side, side);
  drawMark(img, pxPerMm * 25.4, mm / 2, mm / 2, halfMm, thickMm);
  return toTemplate(grayOf(img), side, side);
}

/** Template of a corner finder (with one module of quiet zone). */
export function finderTemplate(pxPerMm: number, notch: boolean): Template {
  const mm = FID_MODULE_MM * 9;
  const side = Math.round(mm * pxPerMm);
  const img = createRaster(side, side);
  drawFinder(img, pxPerMm * 25.4, FID_MODULE_MM + ((side / pxPerMm - mm) / 2), FID_MODULE_MM + ((side / pxPerMm - mm) / 2), notch);
  return toTemplate(grayOf(img), side, side);
}

/** Templates with at least this many pixels (64 x 64) are matched coarse-to-fine inside big search windows. */
const COARSE_MIN_PIXELS = 4096;
/** Number of distinct coarse peaks that are scored exactly. */
const COARSE_KEEP = 3;

/**
 * Find `tpl` in `img` (w x h) near the expected centre (cx, cy), searching +-radius pixels. Returns null when
 * the window leaves the image or the image is flat.
 */
export function matchTemplate(img: Float32Array, w: number, h: number, tpl: Template, cx: number, cy: number, radius: number): Match | null {
  const tw = tpl.width;
  const th = tpl.height;
  const baseX = Math.round(cx - tw / 2);
  const baseY = Math.round(cy - th / 2);
  const R = Math.max(1, Math.round(radius));
  const size = 2 * R + 1;
  const scores = new Float32Array(size * size).fill(-2);
  const n = tw * th;
  let best = -2;
  let bi = -1;
  // Window sums by integral images (big templates only). Exact for integer-valued images (greyscale bytes), so the scores are
  // bit-identical to summing inside the loop; it removes two of the three multiply-adds per template pixel.
  let winX = 0;
  let winY = 0;
  let winW = 0;
  let I1: Float64Array | null = null;
  let I2: Float64Array | null = null;
  if (n >= 1024) {
    winX = Math.max(0, baseX - R);
    winY = Math.max(0, baseY - R);
    const wx1 = Math.min(w, baseX + R + tw);
    const wy1 = Math.min(h, baseY + R + th);
    winW = wx1 - winX;
    const winH = wy1 - winY;
    if (winW > 0 && winH > 0) {
      const S = winW + 1;
      I1 = new Float64Array(S * (winH + 1));
      I2 = new Float64Array(S * (winH + 1));
      for (let y = 0; y < winH; y++) {
        let r1 = 0;
        let r2 = 0;
        for (let x = 0; x < winW; x++) {
          const v = img[(winY + y) * w + winX + x];
          r1 += v;
          r2 += v * v;
          I1[(y + 1) * S + x + 1] = I1[y * S + x + 1] + r1;
          I2[(y + 1) * S + x + 1] = I2[y * S + x + 1] + r2;
        }
      }
    }
  }
  const tdata = tpl.data;
  /** Exact NCC at offset (dx, dy), stored in `scores`; -2 where the window leaves the image or is flat. */
  const evalAt = (dx: number, dy: number): void => {
    const k = (dy + R) * size + (dx + R);
    if (scores[k] !== -2) return;
    const y0 = baseY + dy;
    const x0 = baseX + dx;
    if (y0 < 0 || y0 + th > h || x0 < 0 || x0 + tw > w) return;
    let sum = 0;
    let sum2 = 0;
    let dot = 0;
    if (I1 && I2) {
      const S = winW + 1;
      const a0 = x0 - winX;
      const b0 = y0 - winY;
      const a1 = a0 + tw;
      const b1 = b0 + th;
      sum = I1[b1 * S + a1] - I1[b0 * S + a1] - I1[b1 * S + a0] + I1[b0 * S + a0];
      sum2 = I2[b1 * S + a1] - I2[b0 * S + a1] - I2[b1 * S + a0] + I2[b0 * S + a0];
      for (let j = 0; j < th; j++) {
        const row = (y0 + j) * w + x0;
        const trow = j * tw;
        for (let i = 0; i < tw; i++) dot += img[row + i] * tdata[trow + i];
      }
    } else {
      for (let j = 0; j < th; j++) {
        const row = (y0 + j) * w + x0;
        const trow = j * tw;
        for (let i = 0; i < tw; i++) {
          const v = img[row + i];
          sum += v;
          sum2 += v * v;
          dot += v * tdata[trow + i];
        }
      }
    }
    const varr = sum2 - (sum * sum) / n;
    if (varr < 1e-6) return;
    scores[k] = dot / (Math.sqrt(varr) * tpl.norm);
  };

  if (n >= COARSE_MIN_PIXELS && R >= 8) {
    // Big template, big window (the corner finders): rank every second position on a half-resolution copy of the
    // template, then score the neighbourhood of the best few exactly. The finder is a very sharp peak (modules of 5+ px),
    // so the exact maximum is always among them; this is about 10x cheaper than scoring all (2R+1)^2 positions.
    const sw = tw >> 1;
    const sh = th >> 1;
    const sub = new Float32Array(sw * sh);
    let mean = 0;
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) mean += (sub[j * sw + i] = tdata[2 * j * tw + 2 * i]);
    mean /= sub.length;
    let n2 = 0;
    for (let q = 0; q < sub.length; q++) {
      sub[q] -= mean;
      n2 += sub[q] * sub[q];
    }
    const subNorm = Math.sqrt(n2);
    const m = sub.length;
    const coarse: { dx: number; dy: number; s: number }[] = [];
    for (let dy = -R; dy <= R; dy += 2) {
      const y0 = baseY + dy;
      if (y0 < 0 || y0 + th > h) continue;
      for (let dx = -R; dx <= R; dx += 2) {
        const x0 = baseX + dx;
        if (x0 < 0 || x0 + tw > w) continue;
        let sum = 0;
        let sum2 = 0;
        let dot = 0;
        for (let j = 0; j < sh; j++) {
          const row = (y0 + 2 * j) * w + x0;
          const trow = j * sw;
          for (let i = 0; i < sw; i++) {
            const v = img[row + 2 * i];
            sum += v;
            sum2 += v * v;
            dot += v * sub[trow + i];
          }
        }
        const varr = sum2 - (sum * sum) / m;
        if (varr < 1e-6) continue;
        coarse.push({ dx, dy, s: dot / (Math.sqrt(varr) * subNorm) });
      }
    }
    coarse.sort((p, q) => q.s - p.s);
    const picked: { dx: number; dy: number }[] = [];
    for (const c of coarse) {
      if (picked.length >= COARSE_KEEP) break;
      if (picked.some((p) => Math.abs(p.dx - c.dx) < 5 && Math.abs(p.dy - c.dy) < 5)) continue;
      picked.push(c);
    }
    for (const p of picked) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (Math.abs(p.dx + dx) <= R && Math.abs(p.dy + dy) <= R) evalAt(p.dx + dx, p.dy + dy);
  } else {
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) evalAt(dx, dy);
  }
  for (let k = 0; k < scores.length; k++) {
    if (scores[k] > best) {
      best = scores[k];
      bi = k;
    }
  }
  if (bi < 0) return null;
  const bx = (bi % size) - R;
  const by = Math.floor(bi / size) - R;
  const at = (x: number, y: number) => (x < -R || y < -R || x > R || y > R ? -2 : scores[(y + R) * size + (x + R)]);
  const parab = (a: number, b: number, c: number) => {
    if (a < -1 || c < -1) return 0;
    const d = a - 2 * b + c;
    return d >= -1e-9 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
  };
  const sx = parab(at(bx - 1, by), best, at(bx + 1, by));
  const sy = parab(at(bx, by - 1), best, at(bx, by + 1));
  return { x: baseX + bx + sx + tw / 2, y: baseY + by + sy + th / 2, score: best };
}
