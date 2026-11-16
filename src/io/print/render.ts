/**
 * Page rendering: turns frames plus a sheet layout into RGBA page bitmaps. Pure (no canvas).
 */
import { FID_INSET_MM, FID_MODULE_MM, FID_SIZE_MM, FID_CENTER_MM, STRIP_COLS, STRIP_MODULE_MM, STRIP_ROWS, encodeHeader, stripModules, stripOriginMm, type GuideMode } from './format';
import { FONT_ADVANCE, FONT_HEIGHT, glyph, textWidthPx } from './font';
import { captionFor, cellRectMm, framesOnPage, markCenterMm, mmToPx, pageHeader, type SheetLayout } from './layout';
import { createRaster, resizeRaster, type RasterImage } from './raster';
import { drawFrameBox, drawFrameGuides, drawFrameLabel, drawGhostNumber } from './guides';

export type PrintFrame = RasterImage;

/**
 * Darken a rectangle with fractional edges (anti-aliased by exact coverage) towards `color`.
 * Coordinates are continuous page pixels.
 */
export function fillRectAA(img: RasterImage, x0: number, y0: number, x1: number, y1: number, color: [number, number, number] = [0, 0, 0]): void {
  const { width: w, height: h, data } = img;
  const ix0 = Math.max(0, Math.floor(x0));
  const iy0 = Math.max(0, Math.floor(y0));
  const ix1 = Math.min(w, Math.ceil(x1));
  const iy1 = Math.min(h, Math.ceil(y1));
  for (let y = iy0; y < iy1; y++) {
    const cy = Math.min(y + 1, y1) - Math.max(y, y0);
    if (cy <= 0) continue;
    for (let x = ix0; x < ix1; x++) {
      const cov = cy * (Math.min(x + 1, x1) - Math.max(x, x0));
      if (cov <= 0) continue;
      const i = (y * w + x) * 4;
      data[i] = data[i] * (1 - cov) + color[0] * cov;
      data[i + 1] = data[i + 1] * (1 - cov) + color[1] * cov;
      data[i + 2] = data[i + 2] * (1 - cov) + color[2] * cov;
    }
  }
}

/** Draw a "+" registration mark centred at page mm (cx, cy). */
export function drawMark(img: RasterImage, dpi: number, cxMm: number, cyMm: number, halfMm: number, thickMm: number): void {
  const cx = mmToPx(cxMm, dpi);
  const cy = mmToPx(cyMm, dpi);
  const a = mmToPx(halfMm, dpi);
  const t = mmToPx(thickMm, dpi) / 2;
  fillRectAA(img, cx - a, cy - t, cx + a, cy + t);
  fillRectAA(img, cx - t, cy - a, cx + t, cy + a);
}

/** Draw a finder pattern whose outer top-left corner is at page mm (x, y). `notch` marks the top-left finder. */
export function drawFinder(img: RasterImage, dpi: number, xMm: number, yMm: number, notch: boolean): void {
  const m = FID_MODULE_MM;
  const rect = (mx0: number, my0: number, mx1: number, my1: number, color: [number, number, number]) =>
    fillRectAA(img, mmToPx(xMm + mx0 * m, dpi), mmToPx(yMm + my0 * m, dpi), mmToPx(xMm + mx1 * m, dpi), mmToPx(yMm + my1 * m, dpi), color);
  rect(0, 0, 7, 7, [0, 0, 0]);
  rect(1, 1, 6, 6, [255, 255, 255]);
  rect(2, 2, 5, 5, [0, 0, 0]);
  if (notch) rect(1, 1, 2, 2, [0, 0, 0]);
}

export function drawFinders(img: RasterImage, dpi: number, widthMm: number, heightMm: number): void {
  const far = FID_INSET_MM;
  drawFinder(img, dpi, far, far, true);
  drawFinder(img, dpi, widthMm - far - FID_SIZE_MM, far, false);
  drawFinder(img, dpi, widthMm - far - FID_SIZE_MM, heightMm - far - FID_SIZE_MM, false);
  drawFinder(img, dpi, far, heightMm - far - FID_SIZE_MM, false);
}

/** Draw the data strip for a page. */
export function drawStrip(img: RasterImage, dpi: number, widthMm: number, modules: Uint8Array): void {
  const o = stripOriginMm(widthMm);
  for (let r = 0; r < STRIP_ROWS; r++) {
    for (let c = 0; c < STRIP_COLS; c++) {
      if (!modules[r * STRIP_COLS + c]) continue;
      const x = o.x + c * STRIP_MODULE_MM;
      const y = o.y + r * STRIP_MODULE_MM;
      fillRectAA(img, mmToPx(x, dpi), mmToPx(y, dpi), mmToPx(x + STRIP_MODULE_MM, dpi), mmToPx(y + STRIP_MODULE_MM, dpi));
    }
  }
}

/** Draw text with the built-in 5x7 font. `px` is the edge of one font pixel in page pixels; (x, y) is the top-left. */
export function drawText(img: RasterImage, text: string, x: number, y: number, px: number, color: [number, number, number] = [0, 0, 0]): void {
  let cx = x;
  for (const ch of text) {
    const cols = glyph(ch);
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < FONT_HEIGHT; r++) {
        if ((cols[c] >> r) & 1) fillRectAA(img, cx + c * px, y + r * px, cx + (c + 1) * px, y + (r + 1) * px, color);
      }
    }
    cx += FONT_ADVANCE * px;
  }
}

/** How a frame looks when printed as a drawing guide. Same size as the input, opaque. */
/** Non-photo blue: bright in green and blue, so a scan drops it by colour (see `removeBlueGuide`). */
export const NON_PHOTO_BLUE: [number, number, number] = [130, 200, 240];

export function guideAppearance(frame: RasterImage, mode: GuideMode, opacityPercent: number, blue = false): RasterImage {
  const { width: w, height: h } = frame;
  const out = createRaster(w, h);
  if (mode === 'blank') return out;
  const s = frame.data;
  const o = out.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = s[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) o[i * 4 + c] = s[i * 4 + c] * a + 255 * (1 - a);
    lum[i] = 0.299 * o[i * 4] + 0.587 * o[i * 4 + 1] + 0.114 * o[i * 4 + 2];
  }
  if (mode === 'faded') {
    const k = Math.min(1, Math.max(0, opacityPercent / 100));
    if (blue) {
      // the picture's darkness becomes blue ink: white where the picture is white, non-photo blue where it is black
      for (let i = 0; i < w * h; i++) {
        const dark = (1 - lum[i] / 255) * k;
        for (let c = 0; c < 3; c++) o[i * 4 + c] = 255 - dark * (255 - NON_PHOTO_BLUE[c]);
      }
    } else for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) o[i * 4 + c] = 255 - (255 - o[i * 4 + c]) * k;
  } else if (mode === 'outline') {
    const at = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        const e = Math.min(1, Math.hypot(gx, gy) / 4 / 80);
        const v = 255 * (1 - 0.85 * e);
        const i = (y * w + x) * 4;
        if (blue) for (let c = 0; c < 3; c++) o[i + c] = 255 - e * (255 - NON_PHOTO_BLUE[c]);
        else o[i] = o[i + 1] = o[i + 2] = v;
      }
    }
  }
  return out;
}

/** Resample a frame to the pixel size of its printed cell (so memory stays bounded for big frames). */
export function fitFrameToCell(frame: RasterImage, sheet: SheetLayout): RasterImage {
  const g = sheet.geometry;
  const w = Math.max(1, Math.round(mmToPx(g.cellWMm, sheet.dpi)));
  const h = Math.max(1, Math.round(mmToPx(g.cellHMm, sheet.dpi)));
  if (frame.width === w && frame.height === h) return frame;
  return resizeRaster(frame, w, h, 'auto');
}

export function pagePixelSize(sheet: SheetLayout): { width: number; height: number } {
  return {
    width: Math.round(mmToPx(sheet.geometry.pageWidthMm, sheet.dpi)),
    height: Math.round(mmToPx(sheet.geometry.pageHeightMm, sheet.dpi)),
  };
}

/**
 * Render one page. `getFrame(i)` supplies frame `i` (absolute index, 0-based); it is called only for frames on
 * this page. Frames are resampled to the cell and styled by the sheet's guide mode.
 */
export function renderPage(sheet: SheetLayout, pageIndex: number, getFrame: (index: number) => PrintFrame, target?: RasterImage): RasterImage {
  const g = sheet.geometry;
  const { width, height } = pagePixelSize(sheet);
  // `target` lets a caller reuse one page buffer for a whole set (no 35 MB allocation per page).
  let page: RasterImage;
  if (target && target.width === width && target.height === height) {
    page = target;
    (page.data as Uint8ClampedArray).fill(255);
  } else page = createRaster(width, height);
  const dpi = sheet.dpi;
  const count = framesOnPage(sheet, pageIndex);

  if (sheet.guide !== 'blank') {
    for (let k = 0; k < count; k++) {
      const col = k % g.columns;
      const row = Math.floor(k / g.columns);
      const r = cellRectMm(g, col, row);
      const x0 = Math.round(mmToPx(r.x, dpi));
      const y0 = Math.round(mmToPx(r.y, dpi));
      const x1 = Math.round(mmToPx(r.x + r.w, dpi));
      const y1 = Math.round(mmToPx(r.y + r.h, dpi));
      const guide = guideAppearance(getFrame(pageIndex * sheet.perPage + k), sheet.guide, sheet.guideOpacity, sheet.blueGuide);
      const cell = resizeRaster(guide, x1 - x0, y1 - y0, 'auto');
      for (let y = 0; y < cell.height; y++) {
        const dy = y0 + y;
        if (dy < 0 || dy >= height) continue;
        page.data.set(cell.data.subarray(y * cell.width * 4, (y + 1) * cell.width * 4), (dy * width + x0) * 4);
      }
    }
  }

  drawDecor(page, sheet, pageIndex, count);

  for (let r = 0; r <= g.rows; r++) {
    for (let c = 0; c <= g.columns; c++) {
      const p = markCenterMm(g, c, r);
      drawMark(page, dpi, p.x, p.y, g.markHalfMm, g.markThickMm);
    }
  }
  drawFinders(page, dpi, g.pageWidthMm, g.pageHeightMm);
  drawStrip(page, dpi, g.pageWidthMm, stripModules(encodeHeader(pageHeader(sheet, pageIndex))));

  const caption = captionFor(sheet, pageIndex);
  const availPx = mmToPx(g.pageWidthMm - 2 * (FID_INSET_MM + FID_SIZE_MM + 3), dpi);
  const px = Math.max(1, Math.min(Math.round(dpi / 75), Math.floor(availPx / textWidthPx(caption))));
  const tw = textWidthPx(caption) * px;
  drawText(page, caption, (width - tw) / 2, mmToPx(g.pageHeightMm - FID_CENTER_MM, dpi) - (FONT_HEIGHT * px) / 2, px);
  return page;
}

/** Frame boxes, numbers, timing and drawing guides requested by `sheet.decor`. */
function drawDecor(page: RasterImage, sheet: SheetLayout, pageIndex: number, count: number): void {
  const d = sheet.decor;
  if (!d.boxes && !d.numbers && !d.ghostNumbers && !(d.guides && d.guides.length)) return;
  const g = sheet.geometry;
  for (let k = 0; k < count; k++) {
    const r = cellRectMm(g, k % g.columns, Math.floor(k / g.columns));
    const frame = sheet.frameOffset + pageIndex * sheet.perPage + k;
    if (d.ghostNumbers) drawGhostNumber(page, sheet.dpi, r, frame);
    if (d.guides && d.guides.length) drawFrameGuides(page, sheet.dpi, r, d.guides);
    if (d.boxes) drawFrameBox(page, sheet.dpi, r);
    if (d.numbers) {
      const t = d.timing;
      drawFrameLabel(page, sheet.dpi, r, g.gutterMm, { frame, fps: sheet.fpsX100 / 100, hold: t?.holds?.[frame], beat: t?.beats?.includes(frame) }, !!t);
    }
  }
}
