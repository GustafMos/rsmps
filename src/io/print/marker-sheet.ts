/**
 * The printable sheet for Marker Camera: one marker at an exact physical size, with the white margin the detector needs, its
 * number, which edge is the top, and a line of known length to check that the printer did not scale the page. Pure.
 */
import { MARKER_CELLS, MARKER_COUNT, markerCellWhite } from '../../engine/lib/marker-code';
import { textWidthPx } from './font';
import { PdfBuilder } from './pdf';
import { encodePng } from './png';
import { createRaster, type RasterImage } from './raster';
import { drawText, fillRectAA } from './render';

export type MarkerPaper = 'a4' | 'letter';
const PAPER: Record<MarkerPaper, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };

export interface MarkerSheetOptions {
  /** 0-based marker number. */
  id: number;
  /** Width of the black square in millimetres. */
  sizeMm: number;
  paper?: MarkerPaper;
  dpi?: number;
}

/** The largest black square that still leaves the white margin and room for the captions on this paper. */
export function maxMarkerMm(paper: MarkerPaper = 'a4'): number {
  return Math.floor((PAPER[paper][0] - 24) / (1 + 2 / MARKER_CELLS) / 5) * 5;
}

export interface MarkerSheet {
  image: RasterImage;
  widthMm: number;
  heightMm: number;
  /** The black square on the page, in millimetres from the top-left. */
  square: { x: number; y: number; size: number };
}

export function renderMarkerSheet(o: MarkerSheetOptions): MarkerSheet {
  const paper = o.paper ?? 'a4';
  const [widthMm, heightMm] = PAPER[paper];
  const dpi = o.dpi ?? 300;
  const size = Math.max(20, Math.min(maxMarkerMm(paper), o.sizeMm));
  const id = ((Math.round(o.id) % MARKER_COUNT) + MARKER_COUNT) % MARKER_COUNT;
  const px = (mm: number): number => (mm * dpi) / 25.4;
  const image = createRaster(Math.round(px(widthMm)), Math.round(px(heightMm)));
  const cell = size / MARKER_CELLS;
  const x = (widthMm - size) / 2;
  const y = Math.min((heightMm - size) / 2, 45 + cell);
  // The outer edges are exact to a fraction of a pixel (they set the printed size). The lines between cells are put on whole
  // pixels, so two black cells side by side leave no hairline between them.
  const edge = (origin: number, i: number): number => (i === 0 || i === MARKER_CELLS ? px(origin + i * cell) : Math.round(px(origin + i * cell)));
  for (let cy = 0; cy < MARKER_CELLS; cy++)
    for (let cx = 0; cx < MARKER_CELLS; cx++) {
      if (markerCellWhite(id, cx, cy)) continue;
      fillRectAA(image, edge(x, cx), edge(y, cy), edge(x, cx + 1), edge(y, cy + 1));
    }
  // captions sit outside the white margin (one cell wide all round), in grey so they are never mistaken for part of the marker
  const grey: [number, number, number] = [90, 90, 90];
  const centred = (text: string, yMm: number, fontMm: number): void => {
    const f = px(fontMm) / 7;
    drawText(image, text, (image.width - textWidthPx(text) * f) / 2, px(yMm), f, grey);
  };
  const top = y - cell - 10;
  // an arrow pointing up, then the words
  const ax = px(widthMm / 2);
  for (let r = 0; r < 12; r++) fillRectAA(image, ax - (r + 1) * px(0.35), px(top - 9) + r * px(0.5), ax + (r + 1) * px(0.35), px(top - 9) + (r + 1) * px(0.5), grey);
  centred('TOP: THIS EDGE POINTS AWAY', top, 4);
  const below = y + size + cell + 6;
  centred(`MARKER ${id + 1}`, below, 6);
  centred(`BLACK SQUARE ${Math.round(size)} MM WIDE. KEEP THE WHITE MARGIN AROUND IT.`, below + 11, 3);
  centred('PRINT AT 100% (ACTUAL SIZE, NOT FIT TO PAGE). LAY IT FLAT.', below + 17, 3);
  // a line of known length: measure it to see whether the printer scaled the page
  const lineMm = size >= 100 ? 100 : 50;
  const lx = (widthMm - lineMm) / 2;
  const ly = below + 28;
  fillRectAA(image, px(lx), px(ly), px(lx + lineMm), px(ly + 0.4), grey);
  for (const e of [lx, lx + lineMm - 0.4]) fillRectAA(image, px(e), px(ly - 2), px(e + 0.4), px(ly + 2.4), grey);
  centred(`CHECK: THIS LINE IS ${lineMm} MM LONG`, ly + 4, 3);
  return { image, widthMm, heightMm, square: { x, y, size } };
}

export function markerSheetPdf(o: MarkerSheetOptions): Uint8Array {
  const s = renderMarkerSheet(o);
  const pdf = new PdfBuilder(`Marker ${o.id + 1}`);
  pdf.addImagePage(s.image, s.widthMm, s.heightMm, { grey: true });
  return pdf.finish();
}

export function markerSheetPng(o: MarkerSheetOptions): Uint8Array {
  return encodePng(renderMarkerSheet(o).image, { opaque: true });
}

export function markerSheetName(o: MarkerSheetOptions, ext: 'pdf' | 'png'): string {
  return `marker-${o.id + 1}-${Math.round(o.sizeMm)}mm.${ext}`;
}
