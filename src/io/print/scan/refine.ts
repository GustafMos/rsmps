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
  for (let dy = -R; dy <= R; dy++) {
    const y0 = baseY + dy;
    if (y0 < 0 || y0 + th > h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x0 = baseX + dx;
      if (x0 < 0 || x0 + tw > w) continue;
      let sum = 0;
      let sum2 = 0;
      let dot = 0;
      for (let j = 0; j < th; j++) {
        const row = (y0 + j) * w + x0;
        const trow = j * tw;
        for (let i = 0; i < tw; i++) {
          const v = img[row + i];
          sum += v;
          sum2 += v * v;
          dot += v * tpl.data[trow + i];
        }
      }
      const varr = sum2 - (sum * sum) / n;
      if (varr < 1e-6) continue;
      const s = dot / (Math.sqrt(varr) * tpl.norm);
      const k = (dy + R) * size + (dx + R);
      scores[k] = s;
      if (s > best) {
        best = s;
        bi = k;
      }
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
