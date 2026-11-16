/**
 * Paper clean-up: estimating the paper white (illumination) from the blank margin and gutters, flattening
 * frames to white, removing the printed guide, and extracting the drawing as ink on transparent. Pure.
 */
import { BAND_MM } from '../format';
import { markCenterMm, type SheetGeometry } from '../layout';
import { guideAppearance } from '../render';
import { createRaster, resizeRaster, type RasterImage } from '../raster';
import type { GuideMode } from '../format';

/** Coarse per-channel map of what "paper white" looks like at every point of the rectified page. */
export interface WhiteField {
  blockPx: number;
  bw: number;
  bh: number;
  /** Interleaved r,g,b per block. */
  rgb: Float32Array;
}

const BLOCK_MM = 3;

/**
 * Estimate the paper white of a rectified page (RGBA at `pxPerMm`). Reference pixels are the blank margin
 * strips and the gutters between frames (never frames, marks, finders, strip or caption). Two passes: the
 * second rejects pixels darker than 80% of the first estimate (pen strokes, fingers, shadows). Returns null
 * when there is not enough blank paper.
 */
export function estimateWhiteField(rect: RasterImage, g: SheetGeometry, pxPerMm: number): WhiteField | null {
  const { width: w, height: h, data } = rect;
  const colCell = new Uint8Array(w);
  const nearMarkX = new Uint8Array(w);
  const inX = new Uint8Array(w);
  const rowCell = new Uint8Array(h);
  const nearMarkY = new Uint8Array(h);
  const inY = new Uint8Array(h);
  const near = g.markHalfMm + 0.9;
  for (let x = 0; x < w; x++) {
    const mm = (x + 0.5) / pxPerMm;
    inX[x] = mm >= 2 && mm <= g.pageWidthMm - 2 ? 1 : 0;
    for (let c = 0; c < g.columns; c++) {
      const x0 = g.gridX0Mm + c * g.pitchXMm;
      if (mm >= x0 - 0.5 && mm <= x0 + g.cellWMm + 0.5) colCell[x] = 1;
    }
    for (let c = 0; c <= g.columns; c++) if (Math.abs(mm - markCenterMm(g, c, 0).x) < near) nearMarkX[x] = 1;
  }
  for (let y = 0; y < h; y++) {
    const mm = (y + 0.5) / pxPerMm;
    inY[y] = mm >= BAND_MM && mm <= g.pageHeightMm - BAND_MM ? 1 : 0;
    for (let r = 0; r < g.rows; r++) {
      const y0 = g.gridY0Mm + r * g.pitchYMm;
      if (mm >= y0 - 0.5 && mm <= y0 + g.cellHMm + 0.5) rowCell[y] = 1;
    }
    for (let r = 0; r <= g.rows; r++) if (Math.abs(mm - markCenterMm(g, 0, r).y) < near) nearMarkY[y] = 1;
  }
  const blockPx = BLOCK_MM * pxPerMm;
  const bw = Math.ceil(w / blockPx);
  const bh = Math.ceil(h / blockPx);

  const accumulate = (prev: Float32Array | null): { sum: Float64Array; cnt: Float64Array } => {
    const sum = new Float64Array(bw * bh * 3);
    const cnt = new Float64Array(bw * bh);
    for (let y = 0; y < h; y++) {
      if (!inY[y]) continue;
      const by = Math.min(bh - 1, Math.floor(y / blockPx));
      for (let x = 0; x < w; x++) {
        if (!inX[x]) continue;
        if (colCell[x] && rowCell[y]) continue;
        if (nearMarkX[x] && nearMarkY[y]) continue;
        const i = (y * w + x) * 4;
        const bx = Math.min(bw - 1, Math.floor(x / blockPx));
        const b = by * bw + bx;
        if (prev) {
          const lum = data[i] + data[i + 1] + data[i + 2];
          const ref = prev[b * 3] + prev[b * 3 + 1] + prev[b * 3 + 2];
          if (lum < 0.8 * ref) continue;
        }
        sum[b * 3] += data[i];
        sum[b * 3 + 1] += data[i + 1];
        sum[b * 3 + 2] += data[i + 2];
        cnt[b]++;
      }
    }
    return { sum, cnt };
  };

  const smooth = (sum: Float64Array, cnt: Float64Array): Float32Array | null => {
    // 2D prefix sums over the block grid.
    const W = bw + 1;
    const ps = new Float64Array(W * (bh + 1) * 3);
    const pc = new Float64Array(W * (bh + 1));
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const k = y * bw + x;
        const p = (y + 1) * W + x + 1;
        for (let c = 0; c < 3; c++) ps[p * 3 + c] = sum[k * 3 + c] + ps[(p - 1) * 3 + c] + ps[(p - W) * 3 + c] - ps[(p - W - 1) * 3 + c];
        pc[p] = cnt[k] + pc[p - 1] + pc[p - W] - pc[p - W - 1];
      }
    }
    if (pc[W * (bh + 1) - 1] < 200) return null;
    const out = new Float32Array(bw * bh * 3);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        for (let R = 3; R <= bw + bh; R *= 2) {
          const x0 = Math.max(0, x - R);
          const x1 = Math.min(bw, x + R + 1);
          const y0 = Math.max(0, y - R);
          const y1 = Math.min(bh, y + R + 1);
          const n = pc[y1 * W + x1] - pc[y0 * W + x1] - pc[y1 * W + x0] + pc[y0 * W + x0];
          if (n < 100) continue;
          for (let c = 0; c < 3; c++) {
            const s = ps[(y1 * W + x1) * 3 + c] - ps[(y0 * W + x1) * 3 + c] - ps[(y1 * W + x0) * 3 + c] + ps[(y0 * W + x0) * 3 + c];
            out[(y * bw + x) * 3 + c] = s / n;
          }
          break;
        }
        const k = (y * bw + x) * 3;
        if (out[k] === 0 && out[k + 1] === 0 && out[k + 2] === 0) {
          // No support anywhere nearby: fall back to the global mean.
          const n = pc[W * (bh + 1) - 1];
          for (let c = 0; c < 3; c++) out[k + c] = ps[(W * (bh + 1) - 1) * 3 + c] / n;
        }
      }
    }
    return out;
  };

  const a = accumulate(null);
  const f1 = smooth(a.sum, a.cnt);
  if (!f1) return null;
  const b = accumulate(f1);
  const f2 = smooth(b.sum, b.cnt) ?? f1;
  return { blockPx, bw, bh, rgb: f2 };
}

/** Paper white (per channel) at rectified pixel (x, y), bilinearly interpolated between block centres. */
export function whiteAt(f: WhiteField, x: number, y: number, out: number[]): void {
  const gx = x / f.blockPx - 0.5;
  const gy = y / f.blockPx - 0.5;
  let x0 = Math.floor(gx);
  let y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  x0 = Math.min(f.bw - 1, Math.max(0, x0));
  x1 = Math.min(f.bw - 1, Math.max(0, x1));
  y0 = Math.min(f.bh - 1, Math.max(0, y0));
  y1 = Math.min(f.bh - 1, Math.max(0, y1));
  for (let c = 0; c < 3; c++) {
    const a = f.rgb[(y0 * f.bw + x0) * 3 + c] * (1 - tx) + f.rgb[(y0 * f.bw + x1) * 3 + c] * tx;
    const b = f.rgb[(y1 * f.bw + x0) * 3 + c] * (1 - tx) + f.rgb[(y1 * f.bw + x1) * 3 + c] * tx;
    out[c] = Math.max(30, a * (1 - ty) + b * ty);
  }
}

/**
 * Divide out the printed guide: `frame` is a scanned (already flattened) frame, `original` the source frame.
 * Where the guide was printed ink, the scanned value is c = guide * drawing, so drawing = c / guide. Where the
 * guide is too dark to tell (< 15% brightness) the pixel is left white. Edits `frame` in place.
 */
export function removeGuide(frame: RasterImage, original: RasterImage, mode: GuideMode, opacityPercent: number, blue = false): void {
  if (mode === 'blank') return;
  const guide = guideAppearance(resizeRaster(original, frame.width, frame.height, 'auto'), mode, opacityPercent, blue);
  const d = frame.data;
  const gd = guide.data;
  for (let i = 0; i < frame.width * frame.height * 4; i += 4) {
    for (let c = 0; c < 3; c++) {
      const gv = gd[i + c] / 255;
      d[i + c] = gv < 0.15 ? 255 : Math.min(255, (d[i + c] / gv));
    }
  }
}

export interface DrawingOptions {
  /** Darkness (0..1, relative to paper white) below which a pixel is paper. Default 0.12. */
  threshold?: number;
  /** Width of the soft edge above the threshold. Default 0.1. */
  softness?: number;
}

/**
 * Ink on transparent: alpha comes from how far the darkest channel is below paper white (smoothstep between
 * threshold and threshold + softness) and the colour is un-mixed from white. `frame` should be flattened.
 */
export function extractDrawing(frame: RasterImage, opts: DrawingOptions = {}): RasterImage {
  const t0 = opts.threshold ?? 0.12;
  const t1 = t0 + Math.max(0.001, opts.softness ?? 0.1);
  const out = createRaster(frame.width, frame.height, [0, 0, 0, 0]);
  const s = frame.data;
  const o = out.data;
  for (let i = 0; i < frame.width * frame.height * 4; i += 4) {
    const dark = 1 - Math.min(s[i], s[i + 1], s[i + 2]) / 255;
    const k = Math.min(1, Math.max(0, (dark - t0) / (t1 - t0)));
    const a = k * k * (3 - 2 * k);
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) o[i + c] = Math.min(255, Math.max(0, (s[i + c] - (1 - a) * 255) / a));
    o[i + 3] = a * 255;
  }
  return out;
}

/**
 * "Keep only what I drew", no original needed, for sheets whose guide is non-photo blue: the blue guide is bright in the
 * green and blue channels, graphite and dark inks are not, so darkness is measured on the blue channel and anything lighter
 * than `threshold` becomes paper. Edits `frame` in place (flattened frames expected).
 */
export function removeBlueGuide(frame: RasterImage, opts: { threshold?: number; softness?: number } = {}): void {
  const t0 = opts.threshold ?? 0.2;
  const t1 = t0 + Math.max(0.01, opts.softness ?? 0.12);
  const d = frame.data;
  for (let i = 0; i < frame.width * frame.height * 4; i += 4) {
    const dark = 1 - d[i + 2] / 255;
    const k = Math.min(1, Math.max(0, (dark - t0) / (t1 - t0)));
    const keep = k * k * (3 - 2 * k);
    for (let c = 0; c < 3; c++) d[i + c] = 255 - (255 - d[i + c]) * keep;
  }
}

/**
 * Fallback for faint / outline guides when the original frame is not available: the printed guide is never darker than
 * `guideDarkness` (0..1, for faint sheets the percent of ink kept), so everything lighter than that plus a margin is paper.
 */
export function removeFaintGuide(frame: RasterImage, guideDarkness: number, softness = 0.08): void {
  const t0 = Math.min(0.9, Math.max(0.03, guideDarkness) + 0.04);
  const t1 = t0 + Math.max(0.01, softness);
  const d = frame.data;
  for (let i = 0; i < frame.width * frame.height * 4; i += 4) {
    const dark = 1 - Math.min(d[i], d[i + 1], d[i + 2]) / 255;
    const k = Math.min(1, Math.max(0, (dark - t0) / (t1 - t0)));
    const keep = k * k * (3 - 2 * k);
    for (let c = 0; c < 3; c++) d[i + c] = 255 - (255 - d[i + c]) * keep;
  }
}

/** Remove the printed guide of a scanned frame with the best method available: original when known, else by colour / threshold. */
export function keepOnlyDrawing(frame: RasterImage, how: { mode: GuideMode; opacityPercent: number; blue: boolean; original?: RasterImage | null }): void {
  if (how.mode === 'blank') return;
  if (how.original) removeGuide(frame, how.original, how.mode, how.opacityPercent, how.blue);
  else if (how.blue) removeBlueGuide(frame);
  else removeFaintGuide(frame, how.mode === 'faded' ? how.opacityPercent / 100 : 0.2);
}
