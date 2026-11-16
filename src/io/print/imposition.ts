/**
 * Output-only layouts that are not the scan-back grid: flipbook pages (frames in reading order with a binding margin, cut
 * lines, frame numbers, thumb index, optional duplex with frame N + half on the back) and the 8-page single-sheet zine fold
 * (correct rotation and order, fold and cut marks). These pages carry NO scan markers; they are meant to be cut and folded,
 * not photographed back. Pure.
 */
import { FONT_HEIGHT, textWidthPx } from './font';
import { PAPER_MM, type PaperId } from './format';
import { mmToPx } from './layout';
import { createRaster, resizeRaster, type RasterImage } from './raster';
import { drawText, fillRectAA } from './render';

export interface ImposedPage {
  bitmap: RasterImage;
  widthMm: number;
  heightMm: number;
  /** Human-readable description for logs and file names ("sheet 1 front"). */
  label: string;
}

type Side = 'left' | 'right' | 'top' | 'bottom';

export interface FlipbookOptions {
  paper?: PaperId;
  orientation?: 'portrait' | 'landscape';
  dpi?: number;
  /** Width of the printed frame in mm (default 40). */
  frameWidthMm?: number;
  marginMm?: number;
  /** Binding margin per frame in mm (default 10). */
  bindingMm?: number;
  binding?: 'left' | 'right' | 'top';
  thumbIndex?: boolean;
  /** Frame N + half on the back of frame N (long-edge duplex), so the book reads both ways. */
  duplex?: boolean;
  title?: string;
}

export interface FlipbookPlan {
  columns: number;
  rows: number;
  cellWMm: number;
  cellHMm: number;
  frameWMm: number;
  frameHMm: number;
  perPage: number;
  /** Physical sheets (front + back when duplex) and total pages. */
  sheets: number;
  pages: number;
}

const NUMBER_BAND_MM = 5;

function pageSize(paper: PaperId, orientation: 'portrait' | 'landscape'): { w: number; h: number } {
  const [w, h] = PAPER_MM[paper];
  return orientation === 'landscape' ? { w: h, h: w } : { w, h };
}

export function planFlipbook(count: number, aspect: number, o: FlipbookOptions = {}): FlipbookPlan {
  if (count < 1) throw new Error('No frames to print.');
  const { w: W, h: H } = pageSize(o.paper ?? 'a4', o.orientation ?? 'portrait');
  const margin = Math.max(5, o.marginMm ?? 8);
  const binding = Math.max(4, o.bindingMm ?? 10);
  const side = o.binding ?? 'left';
  const fw = Math.max(15, o.frameWidthMm ?? 40);
  const fh = fw / aspect;
  const cellW = side === 'top' ? fw : fw + binding;
  const cellH = (side === 'top' ? fh + binding : fh) + NUMBER_BAND_MM;
  const columns = Math.floor((W - 2 * margin) / cellW + 1e-9);
  const rows = Math.floor((H - 2 * margin) / cellH + 1e-9);
  if (columns < 1 || rows < 1) throw new Error('A flipbook frame that wide does not fit on this paper. Use a smaller frame width or larger paper.');
  const perPage = columns * rows;
  const front = o.duplex ? Math.ceil(count / 2) : count;
  const sheets = Math.ceil(front / perPage);
  return { columns, rows, cellWMm: cellW, cellHMm: cellH, frameWMm: fw, frameHMm: fh, perPage, sheets, pages: sheets * (o.duplex ? 2 : 1) };
}

const mirrorSide = (s: Side, axis: 'x' | 'y'): Side => (axis === 'x' ? (s === 'left' ? 'right' : s === 'right' ? 'left' : s) : s === 'top' ? 'bottom' : s === 'bottom' ? 'top' : s);

function dashedLine(img: RasterImage, dpi: number, x0: number, y0: number, x1: number, y1: number, grey = 120): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const dash = 2.2;
  const gap = 1.4;
  const t = Math.max(0.5, mmToPx(0.15, dpi) / 2);
  for (let p = 0; p < len; p += dash + gap) {
    const e = Math.min(len, p + dash);
    const ax = mmToPx(x0 + ((x1 - x0) * p) / len, dpi);
    const ay = mmToPx(y0 + ((y1 - y0) * p) / len, dpi);
    const bx = mmToPx(x0 + ((x1 - x0) * e) / len, dpi);
    const by = mmToPx(y0 + ((y1 - y0) * e) / len, dpi);
    fillRectAA(img, Math.min(ax, bx) - t, Math.min(ay, by) - t, Math.max(ax, bx) + t, Math.max(ay, by) + t, [grey, grey, grey]);
  }
}

function fitText(img: RasterImage, text: string, cxPx: number, topPx: number, px: number): void {
  drawText(img, text, cxPx - (textWidthPx(text) * px) / 2, topPx, px);
}

/** Flipbook pages. `frames[i]` is picture i (all the same size). */
export function renderFlipbook(frames: readonly RasterImage[], o: FlipbookOptions = {}): { pages: ImposedPage[]; plan: FlipbookPlan } {
  if (frames.length === 0) throw new Error('No frames to print.');
  const dpi = Math.max(72, Math.min(600, Math.round(o.dpi ?? 300)));
  const aspect = frames[0].width / frames[0].height;
  const plan = planFlipbook(frames.length, aspect, o);
  const { w: W, h: H } = pageSize(o.paper ?? 'a4', o.orientation ?? 'portrait');
  const binding = Math.max(4, o.bindingMm ?? 10);
  const bindSide: Side = o.binding ?? 'left';
  const count = frames.length;
  const half = o.duplex ? Math.ceil(count / 2) : count;
  const gridW = plan.columns * plan.cellWMm;
  const gridH = plan.rows * plan.cellHMm;
  const x0 = (W - gridW) / 2;
  const y0 = (H - gridH) / 2;
  const px = Math.max(1, Math.round(mmToPx(2.0, dpi) / FONT_HEIGHT));
  const pages: ImposedPage[] = [];
  const fwPx = Math.round(mmToPx(plan.frameWMm, dpi));
  const fhPx = Math.round(mmToPx(plan.frameHMm, dpi));
  const sized = new Map<number, RasterImage>();
  const picture = (i: number): RasterImage => {
    let r = sized.get(i);
    if (!r) {
      r = resizeRaster(frames[i], fwPx, fhPx, 'auto');
      sized.set(i, r);
      if (sized.size > 64) sized.delete(sized.keys().next().value as number);
    }
    return r;
  };

  const drawSide = (sheet: number, back: boolean): RasterImage => {
    const img = createRaster(Math.round(mmToPx(W, dpi)), Math.round(mmToPx(H, dpi)));
    // cut lines first, over the whole grid, with a short overshoot so they read as lines to cut along
    // only the rows that carry frames (all rows when the back mirrors the rows)
    const onSide = Math.min(plan.perPage, half - sheet * plan.perPage);
    const usedRows = bindSide === 'top' ? plan.rows : Math.max(1, Math.ceil(onSide / plan.columns));
    for (let c = 0; c <= plan.columns; c++) dashedLine(img, dpi, x0 + c * plan.cellWMm, Math.max(1, y0 - 3), x0 + c * plan.cellWMm, Math.min(H - 1, y0 + usedRows * plan.cellHMm + 3));
    for (let r = 0; r <= usedRows; r++) dashedLine(img, dpi, Math.max(1, x0 - 3), y0 + r * plan.cellHMm, Math.min(W - 1, x0 + gridW + 3), y0 + r * plan.cellHMm);
    for (let r = 0; r < plan.rows; r++) {
      for (let c = 0; c < plan.columns; c++) {
        // which frame sits at this physical spot on this side
        // long-edge duplex mirrors the columns, short-edge (top binding) mirrors the rows
        const physCol = back && bindSide !== 'top' ? plan.columns - 1 - c : c;
        const physRow = back && bindSide === 'top' ? plan.rows - 1 - r : r;
        const frontIndex = sheet * plan.perPage + physRow * plan.columns + physCol;
        const index = back ? frontIndex + half : frontIndex;
        if (frontIndex >= half || index >= count) continue;
        const side: Side = back ? mirrorSide(bindSide, bindSide === 'top' ? 'y' : 'x') : bindSide;
        const cx = x0 + c * plan.cellWMm;
        const cy = y0 + r * plan.cellHMm;
        let fx = cx;
        let fy = cy;
        if (side === 'left') fx = cx + binding;
        if (side === 'bottom') fy = cy;
        if (side === 'top') fy = cy + binding;
        const pic = picture(index);
        const fxPx = Math.round(mmToPx(fx, dpi));
        const fyPx = Math.round(mmToPx(fy, dpi));
        for (let y = 0; y < pic.height; y++) {
          const dy = fyPx + y;
          if (dy < 0 || dy >= img.height) continue;
          img.data.set(pic.data.subarray(y * pic.width * 4, (y + 1) * pic.width * 4), (dy * img.width + fxPx) * 4);
        }
        // frame outline
        const t = Math.max(0.5, mmToPx(0.12, dpi) / 2);
        const a = fxPx;
        const b = fyPx;
        const e = fxPx + pic.width;
        const f = fyPx + pic.height;
        fillRectAA(img, a - t, b - t, e + t, b + t, [60, 60, 60]);
        fillRectAA(img, a - t, f - t, e + t, f + t, [60, 60, 60]);
        fillRectAA(img, a - t, b - t, a + t, f + t, [60, 60, 60]);
        fillRectAA(img, e - t, b - t, e + t, f + t, [60, 60, 60]);
        // page number under the frame
        fitText(img, `${index + 1}/${count}`, (a + e) / 2, f + mmToPx(1.2, dpi), px);
        // binding side hint
        if (o.thumbIndex) {
          const prog = count > 1 ? index / (count - 1) : 0;
          const bar = mmToPx(3, dpi);
          const barLen = mmToPx(2.4, dpi);
          if (side === 'left' || side === 'right') {
            const edgeX = side === 'left' ? e - bar : a;
            const room = pic.height - barLen;
            fillRectAA(img, edgeX, b + room * prog, edgeX + bar, b + room * prog + barLen);
          } else {
            const room = pic.width - barLen;
            const yy = side === 'top' ? f - bar : b;
            fillRectAA(img, a + room * prog, yy, a + room * prog + barLen, yy + bar);
          }
        }
      }
    }
    const label = `${o.title ? o.title.toUpperCase().replace(/[^A-Z0-9 ._()#%+/:=-]/g, '').slice(0, 24) + '  ' : ''}FLIPBOOK  SHEET ${sheet + 1}/${plan.sheets}${o.duplex ? (back ? ' BACK' : ' FRONT') : ''}`;
    drawText(img, label, mmToPx(x0, dpi), mmToPx(Math.max(2, y0 - 5.5), dpi), px);
    return img;
  };

  for (let s = 0; s < plan.sheets; s++) {
    pages.push({ bitmap: drawSide(s, false), widthMm: W, heightMm: H, label: `sheet ${s + 1}${o.duplex ? ' front' : ''}` });
    if (o.duplex) pages.push({ bitmap: drawSide(s, true), widthMm: W, heightMm: H, label: `sheet ${s + 1} back` });
  }
  return { pages, plan };
}

/* ---------------------------------------------------------------------------------------------- */
/* Zine                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Where each booklet page (1..8) sits on a landscape sheet folded into 8: [row, column, upside down]. Top row (rotated half a
 * turn): 5 4 3 2. Bottom row: 6 7 8 1. Page 1 is the cover, 8 the back; folding on the middle line joins 1-2, 8-3, 7-4 and 6-5.
 */
export const ZINE_SLOTS: { page: number; row: 0 | 1; col: 0 | 1 | 2 | 3; rotated: boolean }[] = [
  { page: 5, row: 0, col: 0, rotated: true },
  { page: 4, row: 0, col: 1, rotated: true },
  { page: 3, row: 0, col: 2, rotated: true },
  { page: 2, row: 0, col: 3, rotated: true },
  { page: 6, row: 1, col: 0, rotated: false },
  { page: 7, row: 1, col: 1, rotated: false },
  { page: 8, row: 1, col: 2, rotated: false },
  { page: 1, row: 1, col: 3, rotated: false },
];

export interface ZineOptions {
  paper?: PaperId;
  dpi?: number;
  title?: string;
  /** Print the folding steps on the sheet (default true). */
  instructions?: boolean;
}

function rotate180(src: RasterImage): RasterImage {
  const out = createRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const j = ((src.height - 1 - y) * src.width + (src.width - 1 - x)) * 4;
      out.data[j] = src.data[i];
      out.data[j + 1] = src.data[i + 1];
      out.data[j + 2] = src.data[i + 2];
      out.data[j + 3] = 255;
    }
  }
  return out;
}

/** Zine sheets: every 8 frames make one landscape sheet. Missing frames of the last sheet stay blank panels. */
export function renderZine(frames: readonly RasterImage[], o: ZineOptions = {}): { pages: ImposedPage[]; sheets: number } {
  if (frames.length === 0) throw new Error('No frames to print.');
  const dpi = Math.max(72, Math.min(600, Math.round(o.dpi ?? 300)));
  const { w: W, h: H } = pageSize(o.paper ?? 'a4', 'landscape');
  const margin = 7;
  const pw = (W - 2 * margin) / 4;
  const ph = (H - 2 * margin) / 2;
  const sheets = Math.ceil(frames.length / 8);
  const pages: ImposedPage[] = [];
  const px = Math.max(1, Math.round(mmToPx(1.9, dpi) / FONT_HEIGHT));
  const panelW = Math.round(mmToPx(pw, dpi));
  const panelH = Math.round(mmToPx(ph, dpi));
  for (let s = 0; s < sheets; s++) {
    const img = createRaster(Math.round(mmToPx(W, dpi)), Math.round(mmToPx(H, dpi)));
    for (const slot of ZINE_SLOTS) {
      const idx = s * 8 + slot.page - 1;
      const panel = createRaster(panelW, panelH);
      if (idx < frames.length) {
        const pad = mmToPx(4, dpi);
        const availW = panelW - 2 * pad;
        const availH = panelH - 2 * pad - mmToPx(6, dpi);
        const f = frames[idx];
        const k = Math.min(availW / f.width, availH / f.height);
        const fw = Math.max(1, Math.round(f.width * k));
        const fh = Math.max(1, Math.round(f.height * k));
        const pic = resizeRaster(f, fw, fh, 'auto');
        const ox = Math.round((panelW - fw) / 2);
        const oy = Math.round(pad + (availH - fh) / 2);
        for (let y = 0; y < fh; y++) panel.data.set(pic.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((oy + y) * panelW + ox) * 4);
        const t = Math.max(0.5, mmToPx(0.12, dpi) / 2);
        for (const [a, b, c, d] of [[ox, oy, ox + fw, oy], [ox, oy + fh, ox + fw, oy + fh], [ox, oy, ox, oy + fh], [ox + fw, oy, ox + fw, oy + fh]]) fillRectAA(panel, Math.min(a, c) - t, Math.min(b, d) - t, Math.max(a, c) + t, Math.max(b, d) + t, [60, 60, 60]);
        fitText(panel, `${idx + 1}`, panelW / 2, oy + fh + mmToPx(1.6, dpi), px);
      }
      const placed = slot.rotated ? rotate180(panel) : panel;
      const dx = Math.round(mmToPx(margin + slot.col * pw, dpi));
      const dy = Math.round(mmToPx(margin + slot.row * ph, dpi));
      for (let y = 0; y < panelH; y++) img.data.set(placed.data.subarray(y * panelW * 4, (y + 1) * panelW * 4), ((dy + y) * img.width + dx) * 4);
    }
    // fold lines: three vertical across the whole panel area, one horizontal on the outer panels; the middle is CUT
    for (let c = 1; c < 4; c++) dashedLine(img, dpi, margin + c * pw, margin - 4, margin + c * pw, H - margin + 4);
    dashedLine(img, dpi, margin - 4, margin + ph, margin + pw, margin + ph);
    dashedLine(img, dpi, margin + 3 * pw, margin + ph, W - margin + 4, margin + ph);
    const cut = mmToPx(0.35, dpi) / 2;
    fillRectAA(img, mmToPx(margin + pw, dpi), mmToPx(margin + ph, dpi) - cut, mmToPx(margin + 3 * pw, dpi), mmToPx(margin + ph, dpi) + cut);
    const cutLabel = 'CUT';
    drawText(img, cutLabel, mmToPx(W / 2, dpi) - (textWidthPx(cutLabel) * px) / 2, mmToPx(margin + ph, dpi) + mmToPx(0.8, dpi), px);
    // outer edge ticks so the sheet can be trimmed
    for (const [x, y, w, h] of [[margin - 4, margin, 3, 0], [margin, margin - 4, 0, 3], [W - margin + 1, margin, 3, 0], [W - margin, margin - 4, 0, 3], [margin - 4, H - margin, 3, 0], [margin, H - margin + 1, 0, 3], [W - margin + 1, H - margin, 3, 0], [W - margin, H - margin + 1, 0, 3]])
      fillRectAA(img, mmToPx(x, dpi), mmToPx(y, dpi), mmToPx(x + Math.max(w, 0.2), dpi), mmToPx(y + Math.max(h, 0.2), dpi));
    const title = `${o.title ? o.title.toUpperCase().replace(/[^A-Z0-9 ._()#%+/:=-]/g, '').slice(0, 24) + '  ' : ''}ZINE SHEET ${s + 1}/${sheets}  FRAMES ${s * 8 + 1}-${Math.min(frames.length, s * 8 + 8)}`;
    drawText(img, title, mmToPx(margin, dpi), mmToPx(1.5, dpi), px);
    if (o.instructions !== false) drawText(img, 'FOLD IN HALF, CUT THE SLIT ON THE MIDDLE LINE, FOLD THE ENDS TOGETHER', mmToPx(margin, dpi), mmToPx(H - 5.5, dpi), px);
    pages.push({ bitmap: img, widthMm: W, heightMm: H, label: `zine sheet ${s + 1}` });
  }
  return { pages, sheets };
}
