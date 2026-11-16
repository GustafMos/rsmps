/**
 * Page decoration that is NOT part of the machine-readable format: frame boxes, frame numbers, timing marks and
 * drawing guides inside the frames. Everything is drawn in light greys / thin lines and outside or on top of areas the
 * scanner treats as paper, so scanning and the "keep only what I drew" clean-up are unaffected (guides are faint enough
 * for the threshold fallback; the frame box and numbers sit outside the cut).
 * Pure: draws into a RasterImage.
 */
import { FONT_ADVANCE, FONT_HEIGHT, textWidthPx } from './font';
import { mmToPx, type FrameGuide } from './layout';
import { fillRectAA, drawText } from './render';
import type { RasterImage } from './raster';

type Rgb = [number, number, number];
const GREY = (v: number): Rgb => [v, v, v];
export const BOX_GREY = 150;
export const GUIDE_GREY = 205;
const BOX_OFFSET_MM = 0.5;
const BOX_THICK_MM = 0.2;

export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

function hline(img: RasterImage, dpi: number, x0: number, x1: number, y: number, thick: number, c: Rgb): void {
  const t = mmToPx(thick, dpi) / 2;
  fillRectAA(img, mmToPx(x0, dpi), mmToPx(y, dpi) - t, mmToPx(x1, dpi), mmToPx(y, dpi) + t, c);
}
function vline(img: RasterImage, dpi: number, x: number, y0: number, y1: number, thick: number, c: Rgb): void {
  const t = mmToPx(thick, dpi) / 2;
  fillRectAA(img, mmToPx(x, dpi) - t, mmToPx(y0, dpi), mmToPx(x, dpi) + t, mmToPx(y1, dpi), c);
}

/** Dashed horizontal / vertical lines (dash and gap in mm) keep dense guides visually quiet. */
function dashed(img: RasterImage, dpi: number, horizontal: boolean, fixed: number, a: number, b: number, c: Rgb, thick = 0.15, dash = 2, gap = 1.5): void {
  for (let p = a; p < b; p += dash + gap) {
    const e = Math.min(b, p + dash);
    if (horizontal) hline(img, dpi, p, e, fixed, thick, c);
    else vline(img, dpi, fixed, p, e, thick, c);
  }
}

function rectOutline(img: RasterImage, dpi: number, r: RectMm, thick: number, c: Rgb): void {
  hline(img, dpi, r.x - thick / 2, r.x + r.w + thick / 2, r.y, thick, c);
  hline(img, dpi, r.x - thick / 2, r.x + r.w + thick / 2, r.y + r.h, thick, c);
  vline(img, dpi, r.x, r.y, r.y + r.h, thick, c);
  vline(img, dpi, r.x + r.w, r.y, r.y + r.h, thick, c);
}

function ring(img: RasterImage, dpi: number, cx: number, cy: number, radius: number, thick: number, c: Rgb): void {
  const n = Math.max(24, Math.round(radius * 14));
  const t = mmToPx(thick, dpi) / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = mmToPx(cx + Math.cos(a) * radius, dpi);
    const y = mmToPx(cy + Math.sin(a) * radius, dpi);
    fillRectAA(img, x - t, y - t, x + t, y + t, c);
  }
}

/** A thin box just OUTSIDE the cell (the scanner cuts the cell itself, so the box never lands in a recovered frame). */
export function drawFrameBox(img: RasterImage, dpi: number, cell: RectMm): void {
  rectOutline(img, dpi, { x: cell.x - BOX_OFFSET_MM, y: cell.y - BOX_OFFSET_MM, w: cell.w + 2 * BOX_OFFSET_MM, h: cell.h + 2 * BOX_OFFSET_MM }, BOX_THICK_MM, GREY(BOX_GREY));
}

/** Height in mm available for text in the gutter above a frame; 0 when the gutter is too narrow for it. */
export function gutterTextMm(gutterMm: number): number {
  const h = Math.min(2.2, gutterMm - 2.6);
  return h >= 1.2 ? h : 0;
}

/** "1+04"-style time code: whole seconds, then the frame within the second. */
export function timecode(frame: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  return `${Math.floor(frame / rate)}+${String(frame % rate).padStart(2, '0')}`;
}

export interface FrameLabel {
  /** Absolute 0-based frame index. */
  frame: number;
  fps: number;
  /** Frames this drawing is shot for (1 = on ones). Shown as "x2" when above 1. */
  hold?: number;
  /** A beat falls on this frame. */
  beat?: boolean;
}

/**
 * Frame number at the left of the gutter above the frame and, when there is room, time code / hold / beat dot at the
 * right. Returns false when the gutter is too narrow (nothing drawn).
 */
export function drawFrameLabel(img: RasterImage, dpi: number, cell: RectMm, gutterMm: number, label: FrameLabel, withTiming: boolean): boolean {
  const textMm = gutterTextMm(gutterMm);
  if (textMm <= 0) return false;
  const px = Math.max(1, Math.floor(mmToPx(textMm, dpi) / FONT_HEIGHT));
  const hPx = FONT_HEIGHT * px;
  const yPx = mmToPx(cell.y - BOX_OFFSET_MM - 0.3, dpi) - hPx;
  const num = String(label.frame + 1);
  const x0 = mmToPx(cell.x + 1.5, dpi);
  drawText(img, num, x0, yPx, px);
  if (withTiming) {
    const parts = [timecode(label.frame, label.fps)];
    if ((label.hold ?? 1) > 1) parts.push(`X${label.hold}`);
    const txt = parts.join(' ');
    const w = textWidthPx(txt) * px;
    const right = mmToPx(cell.x + cell.w - 1.5, dpi);
    const leftEdge = x0 + textWidthPx(num) * px + 2 * FONT_ADVANCE * px;
    let x = right - w;
    if (label.beat) x -= hPx * 1.4;
    if (x >= leftEdge) {
      drawText(img, txt, x, yPx, px);
      if (label.beat) {
        const r = hPx * 0.45;
        const cx = right - r;
        const cy = yPx + hPx / 2;
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) fillRectAA(img, cx - Math.sqrt(Math.max(0, r * r - dy * dy)), cy + dy, cx + Math.sqrt(Math.max(0, r * r - dy * dy)), cy + dy + 1);
      }
    }
  }
  return true;
}

/** Very faint big frame number in the middle of the frame (placeholder for the drawing that goes here). */
export function drawGhostNumber(img: RasterImage, dpi: number, cell: RectMm, frame: number): void {
  const text = String(frame + 1);
  const hPx = mmToPx(cell.h, dpi) * 0.38;
  const wUnits = textWidthPx(text);
  const maxW = mmToPx(cell.w, dpi) * 0.7;
  const px = Math.max(1, Math.floor(Math.min(hPx / FONT_HEIGHT, maxW / wUnits)));
  const w = wUnits * px;
  const x = mmToPx(cell.x + cell.w / 2, dpi) - w / 2;
  const y = mmToPx(cell.y + cell.h / 2, dpi) - (FONT_HEIGHT * px) / 2;
  drawText(img, text, x, y, px, GREY(238));
}

/** Drawing guides inside a frame, all light grey so pencil and ink dominate. */
export function drawFrameGuides(img: RasterImage, dpi: number, cell: RectMm, guides: readonly FrameGuide[]): void {
  const c = GREY(GUIDE_GREY);
  const { x, y, w, h } = cell;
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (const g of guides) {
    switch (g) {
      case 'cross': {
        const a = Math.min(5, Math.min(w, h) * 0.06);
        hline(img, dpi, cx - a, cx + a, cy, 0.2, GREY(185));
        vline(img, dpi, cx, cy - a, cy + a, 0.2, GREY(185));
        break;
      }
      case 'thirds':
        for (const f of [1 / 3, 2 / 3]) {
          dashed(img, dpi, false, x + w * f, y, y + h, c);
          dashed(img, dpi, true, y + h * f, x, x + w, c);
        }
        break;
      case 'safe':
        rectOutline(img, dpi, { x: x + w * 0.05, y: y + h * 0.05, w: w * 0.9, h: h * 0.9 }, 0.15, c);
        rectOutline(img, dpi, { x: x + w * 0.1, y: y + h * 0.1, w: w * 0.8, h: h * 0.8 }, 0.15, GREY(225));
        break;
      case 'grid': {
        const step = Math.min(w, h) / 8;
        for (let gx = x + step; gx < x + w - step / 2; gx += step) vline(img, dpi, gx, y, y + h, 0.1, GREY(225));
        for (let gy = y + step; gy < y + h - step / 2; gy += step) hline(img, dpi, x, x + w, gy, 0.1, GREY(225));
        break;
      }
      case 'horizon': {
        const hy = y + h * 0.4;
        hline(img, dpi, x, x + w, hy, 0.2, GREY(190));
        const a = Math.min(3, h * 0.04);
        for (const s of [-1, 1]) {
          // a small x at the vanishing point, centred on the horizon
          for (let t = -a; t <= a; t += a / 6) {
            const px = mmToPx(cx + t, dpi);
            const py = mmToPx(hy + s * t, dpi);
            fillRectAA(img, px - 0.8, py - 0.8, px + 0.8, py + 0.8, GREY(170));
          }
        }
        break;
      }
      case 'pegs': {
        const r = Math.min(2.4, Math.min(w, h) * 0.04);
        const y0 = y + h - r * 2.6;
        for (const f of [-0.32, 0, 0.32]) ring(img, dpi, cx + w * f, y0, r, 0.18, GREY(175));
        break;
      }
    }
  }
}
