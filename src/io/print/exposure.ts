/**
 * Exposure sheet (X-sheet / dope sheet): one printed row per timeline frame with frame number, time code, which drawing is
 * on screen, holds and beat marks, plus blank columns for action and notes. Pure: returns page bitmaps.
 */
import { FONT_HEIGHT } from './font';
import { PAPER_MM, type PaperId } from './format';
import { timecode } from './guides';
import { startFrames, totalFrames } from './holds';
import { mmToPx } from './layout';
import { createRaster, type RasterImage } from './raster';
import { drawText, fillRectAA } from './render';

export interface ExposureOptions {
  title: string;
  fps: number;
  /** Hold count per drawing (see `resolveHolds`). */
  holds: readonly number[];
  /** Timeline frames (0-based) that carry a beat mark, e.g. from `beatFrames`. Empty = blank column to fill in by hand. */
  beats?: readonly number[];
  /** True when the beats come from audio (header says so), false for a hand-fill column. */
  beatsFromAudio?: boolean;
  /** First drawing number printed (1-based; for onion rounds that continue). Default 1. */
  firstDrawing?: number;
  paper?: PaperId;
  dpi?: number;
}

export interface ExposurePages {
  pages: RasterImage[];
  widthMm: number;
  heightMm: number;
  rowsPerPage: number;
}

const ROW_MM = 5.5;
const MARGIN_MM = 12;
const COLS: { id: string; label: string; w: number }[] = [
  { id: 'frame', label: 'FRAME', w: 15 },
  { id: 'time', label: 'TIME', w: 17 },
  { id: 'draw', label: 'DRAWING', w: 20 },
  { id: 'hold', label: 'HOLD', w: 12 },
  { id: 'beat', label: 'BEAT', w: 13 },
  { id: 'action', label: 'ACTION / SOUND', w: 0 },
];

export function renderExposureSheet(o: ExposureOptions): ExposurePages {
  const paper = o.paper ?? 'a4';
  const [W, H] = PAPER_MM[paper];
  const dpi = Math.max(72, Math.min(600, Math.round(o.dpi ?? 300)));
  const total = Math.max(0, totalFrames(o.holds));
  const topMm = MARGIN_MM + 14;
  const rowsPerPage = Math.max(1, Math.floor((H - topMm - MARGIN_MM - ROW_MM) / ROW_MM));
  const pageCount = Math.max(1, Math.ceil(total / rowsPerPage));
  const fixed = COLS.reduce((s, c) => s + c.w, 0);
  const widths = COLS.map((c) => (c.w > 0 ? c.w : W - 2 * MARGIN_MM - fixed));
  const xs: number[] = [MARGIN_MM];
  for (const w of widths) xs.push(xs[xs.length - 1] + w);
  const starts = startFrames(o.holds);
  const startOf = new Map<number, number>();
  starts.forEach((t, i) => startOf.set(t, i));
  const beats = new Set(o.beats ?? []);
  const px = Math.max(1, Math.round(mmToPx(ROW_MM * 0.42, dpi) / FONT_HEIGHT));
  const textH = FONT_HEIGHT * px;
  const rowPx = (mm: number) => mmToPx(mm, dpi);
  const line = (img: RasterImage, x0: number, y0: number, x1: number, y1: number, thickMm: number, grey = 0) => {
    const t = rowPx(thickMm) / 2;
    fillRectAA(img, rowPx(x0) - t, rowPx(y0) - t, rowPx(x1) + t, rowPx(y1) + t, [grey, grey, grey]);
  };
  const pages: RasterImage[] = [];
  for (let p = 0; p < pageCount; p++) {
    const img = createRaster(Math.round(mmToPx(W, dpi)), Math.round(mmToPx(H, dpi)));
    const title = `${o.title.toUpperCase().replace(/[^A-Z0-9 ._()#%+/:=-]/g, '').slice(0, 40) || 'ANIMATION'}  EXPOSURE SHEET  ${o.fps} FPS  PAGE ${p + 1}/${pageCount}`;
    drawText(img, title, rowPx(MARGIN_MM), rowPx(MARGIN_MM), Math.max(1, px + 1));
    const sub = o.beatsFromAudio ? 'BEAT MARKS FROM THE CHOSEN AUDIO' : 'BEAT COLUMN: FILL IN BY HAND';
    drawText(img, sub, rowPx(MARGIN_MM), rowPx(MARGIN_MM + 6), px);
    // header row
    const hy = topMm;
    COLS.forEach((c, i) => drawText(img, c.label, rowPx(xs[i] + 1), rowPx(hy + ROW_MM / 2) - textH / 2, px));
    line(img, xs[0], hy, xs[xs.length - 1], hy, 0.4);
    line(img, xs[0], hy + ROW_MM, xs[xs.length - 1], hy + ROW_MM, 0.4);
    const rows = Math.min(rowsPerPage, total - p * rowsPerPage);
    for (let r = 0; r < rows; r++) {
      const t = p * rowsPerPage + r;
      const y = hy + ROW_MM * (r + 1);
      const cy = rowPx(y + ROW_MM / 2) - textH / 2;
      const sec = Math.round(o.fps) > 0 && t % Math.round(o.fps) === 0;
      line(img, xs[0], y + ROW_MM, xs[xs.length - 1], y + ROW_MM, sec ? 0.3 : 0.1, sec ? 60 : 170);
      drawText(img, String(t + 1), rowPx(xs[0] + 1), cy, px);
      drawText(img, timecode(t, o.fps), rowPx(xs[1] + 1), cy, px);
      const di = startOf.get(t);
      if (di !== undefined) {
        drawText(img, String(di + (o.firstDrawing ?? 1)), rowPx(xs[2] + 1), cy, px);
        if (o.holds[di] > 1) drawText(img, `X${o.holds[di]}`, rowPx(xs[3] + 1), cy, px);
      } else {
        const x = rowPx(xs[2] + 3);
        fillRectAA(img, x, rowPx(y) + 1, x + Math.max(1, rowPx(0.3)), rowPx(y + ROW_MM) + 1, [90, 90, 90]);
      }
      if (beats.has(t)) {
        const r2 = rowPx(ROW_MM * 0.28);
        const cx = rowPx(xs[4] + widths[4] / 2);
        const cyy = rowPx(y + ROW_MM / 2);
        for (let dy = -Math.ceil(r2); dy <= Math.ceil(r2); dy++) {
          const dx = Math.sqrt(Math.max(0, r2 * r2 - dy * dy));
          fillRectAA(img, cx - dx, cyy + dy, cx + dx, cyy + dy + 1);
        }
      }
    }
    for (let i = 0; i < xs.length; i++) line(img, xs[i], hy, xs[i], hy + ROW_MM * (rows + 1), 0.2, 90);
    pages.push(img);
  }
  return { pages, widthMm: W, heightMm: H, rowsPerPage };
}
