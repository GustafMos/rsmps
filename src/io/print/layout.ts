/**
 * Sheet layout: how animation frames are arranged on paper. Pure. The same geometry is rebuilt from the
 * decoded data strip by the scanner, so everything here works in integer tenths of a millimetre.
 */
import {
  BAND_MM,
  FORMAT_VERSION,
  PAPER_MM,
  pageSizeMm,
  type GuideMode,
  type PaperId,
  type SheetHeader,
  formatProjectId,
  projectIdFromString,
} from './format';

export interface PrintOptions {
  paper?: PaperId;
  orientation?: 'portrait' | 'landscape';
  /** Raster resolution of the rendered pages (default 300). */
  dpi?: number;
  /** Side margin of the frame area in mm (default 10, at least 5). Top and bottom also keep the 20 mm furniture bands. */
  marginMm?: number;
  /** Gap between frames in mm (default 5, clamped to 3..20); the "+" marks live in it. */
  gutterMm?: number;
  /** Frames per row / column. 0 or undefined = derive (see `frameWidthMm`). */
  columns?: number;
  rows?: number;
  /** Target frame width in mm when columns and rows are both auto (default 50). */
  frameWidthMm?: number;
  guide?: GuideMode;
  /** Percent of ink kept in 'faded' guide mode (default 35). */
  guideOpacity?: number;
  /** Title in the caption. */
  name?: string;
  /** 32-bit project id; derived from `name` when absent. */
  projectId?: number;
  /** Absolute number of the first printed frame (0-based). Onion-skin rounds continue an existing animation. Default 0. */
  frameOffset?: number;
  /** Paper layer (0-based) and number of layers in the set (version 2 strip when > 1). */
  layer?: number;
  layerCount?: number;
  /** Onion-skin round (0 = first). */
  round?: number;
  /** The printed picture uses the blue guide tone (scan-back removes it by colour). */
  blueGuide?: boolean;
  /** Page furniture that does not change what the scanner reads (frame boxes, numbers, drawing guides). */
  decor?: SheetDecor;
}

/** Drawing guides printed inside every frame (never part of the strip). */
export type FrameGuide = 'cross' | 'thirds' | 'safe' | 'grid' | 'horizon' | 'pegs';
export const FRAME_GUIDES: FrameGuide[] = ['cross', 'thirds', 'safe', 'grid', 'horizon', 'pegs'];

export interface SheetDecor {
  /** Thin box just outside every frame (outside the area the scanner cuts). */
  boxes?: boolean;
  /** Frame number in the gutter above every frame. */
  numbers?: boolean;
  /** Very faint large frame number inside the frame (onion-skin placeholder). */
  ghostNumbers?: boolean;
  guides?: FrameGuide[];
  /** Time code, hold counts and beat dots printed beside the frame number (needs `numbers`). */
  timing?: { holds?: number[]; beats?: number[] };
  /** Small label naming the paper layer in the caption area. */
  layerName?: string;
}

/** What is being printed. */
export interface SheetSource {
  /** Pixel size of one frame (all frames are equal). */
  width: number;
  height: number;
  /** Number of frames to print. */
  count: number;
  fps: number;
}

/** Geometry that both the printer and the scanner derive: millimetres, from the header integers. */
export interface SheetGeometry {
  paper: PaperId;
  landscape: boolean;
  pageWidthMm: number;
  pageHeightMm: number;
  columns: number;
  rows: number;
  cellWMm: number;
  cellHMm: number;
  pitchXMm: number;
  pitchYMm: number;
  /** Top-left corner of cell (0,0). */
  gridX0Mm: number;
  gridY0Mm: number;
  gutterMm: number;
  /** Half arm length and line thickness of the "+" marks. */
  markHalfMm: number;
  markThickMm: number;
}

export interface SheetLayout {
  geometry: SheetGeometry;
  dpi: number;
  guide: GuideMode;
  guideOpacity: number;
  frameWidthPx: number;
  frameHeightPx: number;
  totalFrames: number;
  fpsX100: number;
  perPage: number;
  pageCount: number;
  projectId: number;
  name: string;
  /** Absolute index of the first frame of page 0. */
  frameOffset: number;
  layer: number;
  layerCount: number;
  round: number;
  blueGuide: boolean;
  decor: SheetDecor;
}

export function mmToPx(mm: number, dpi: number): number {
  return (mm * dpi) / 25.4;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function markHalfFor(gutterMm: number): number {
  return Math.max(0.8, Math.min(2.0, gutterMm / 2 - 0.3));
}

export function geometryFromHeader(h: SheetHeader): SheetGeometry {
  const { width, height } = pageSizeMm(h.paper, h.landscape);
  const gutter = (h.pitchX - h.cellW) / 10;
  return {
    paper: h.paper,
    landscape: h.landscape,
    pageWidthMm: width,
    pageHeightMm: height,
    columns: h.columns,
    rows: h.rows,
    cellWMm: h.cellW / 10,
    cellHMm: h.cellH / 10,
    pitchXMm: h.pitchX / 10,
    pitchYMm: h.pitchY / 10,
    gridX0Mm: h.gridX0 / 10,
    gridY0Mm: h.gridY0 / 10,
    gutterMm: gutter,
    markHalfMm: markHalfFor(gutter),
    markThickMm: 0.4,
  };
}

/** Centre of "+" mark number (col 0..columns, row 0..rows), shared by the neighbouring cells. */
export function markCenterMm(g: SheetGeometry, col: number, row: number): { x: number; y: number } {
  return { x: g.gridX0Mm + col * g.pitchXMm - g.gutterMm / 2, y: g.gridY0Mm + row * g.pitchYMm - g.gutterMm / 2 };
}

/** Cell rectangle in page mm. */
export function cellRectMm(g: SheetGeometry, col: number, row: number): { x: number; y: number; w: number; h: number } {
  return { x: g.gridX0Mm + col * g.pitchXMm, y: g.gridY0Mm + row * g.pitchYMm, w: g.cellWMm, h: g.cellHMm };
}

/** Plan the sheet. Throws a readable error when the settings cannot fit even one frame. */
export function planSheet(opts: PrintOptions, src: SheetSource): SheetLayout {
  if (src.count < 1) throw new Error('No frames to print.');
  if (!(src.width > 0 && src.height > 0)) throw new Error('Frame size is invalid.');
  const paper: PaperId = opts.paper && PAPER_MM[opts.paper] ? opts.paper : 'a4';
  const landscape = opts.orientation === 'landscape';
  const { width: W, height: H } = pageSizeMm(paper, landscape);
  const dpi = clamp(Math.round(opts.dpi ?? 300), 72, 1200);
  const margin = clamp(opts.marginMm ?? 10, 5, 40);
  const gutter = clamp(Math.round((opts.gutterMm ?? 5) * 10) / 10, 3, 20);
  const aspect = src.width / src.height;

  const areaX = margin;
  const areaY = Math.max(margin, BAND_MM);
  const AW = W - 2 * areaX;
  const AH = H - 2 * areaY;
  if (AW <= gutter + 5 || AH <= gutter + 5) throw new Error('The margins leave no room on this paper.');

  let cols = clamp(Math.round(opts.columns ?? 0), 0, 63);
  let rows = clamp(Math.round(opts.rows ?? 0), 0, 63);
  let cellW: number;
  if (cols > 0 && rows > 0) {
    cellW = Math.min(AW / cols - gutter, (AH / rows - gutter) * aspect);
  } else if (cols > 0) {
    cellW = AW / cols - gutter;
    if (cellW / aspect + gutter > AH) cellW = (AH - gutter) * aspect;
    rows = Math.max(1, Math.floor(AH / (cellW / aspect + gutter) + 1e-9));
  } else if (rows > 0) {
    cellW = Math.min((AH / rows - gutter) * aspect, AW - gutter);
    cols = Math.max(1, Math.floor(AW / (cellW + gutter) + 1e-9));
  } else {
    cellW = clamp(opts.frameWidthMm && opts.frameWidthMm > 0 ? opts.frameWidthMm : 50, 8, AW - gutter);
    if (cellW / aspect + gutter > AH) cellW = (AH - gutter) * aspect;
    cols = Math.max(1, Math.floor(AW / (cellW + gutter) + 1e-9));
    rows = Math.max(1, Math.floor(AH / (cellW / aspect + gutter) + 1e-9));
  }
  cols = Math.min(cols, 63);
  rows = Math.min(rows, 63);
  if (cellW < 8) throw new Error('Frames would be smaller than 8 mm. Use fewer columns/rows or a larger paper.');

  const cellW10 = Math.floor(cellW * 10 + 1e-6);
  const cellH10 = Math.max(1, Math.floor((cellW10 / aspect) + 1e-6));
  const gutter10 = Math.round(gutter * 10);
  const pitchX10 = cellW10 + gutter10;
  const pitchY10 = cellH10 + gutter10;
  const W10 = Math.round(W * 10);
  const H10 = Math.round(H * 10);
  const blockLeft = (W10 - cols * pitchX10) / 2;
  const areaTop = Math.round(areaY * 10);
  const areaH = H10 - 2 * areaTop;
  const blockTop = areaTop + (areaH - rows * pitchY10) / 2;
  const gridX0 = Math.round(blockLeft + gutter10 / 2);
  const gridY0 = Math.round(blockTop + gutter10 / 2);

  const perPage = cols * rows;
  const pageCount = Math.ceil(src.count / perPage);
  if (pageCount > 4095) throw new Error('Too many pages (limit 4095). Print every Nth frame or use more frames per page.');
  if (src.count > 65535) throw new Error('Too many frames to print (limit 65535).');
  const name = (opts.name ?? '').trim();
  const guideOpacity = clamp(Math.round(opts.guideOpacity ?? 35), 5, 100);
  const frameOffset = clamp(Math.round(opts.frameOffset ?? 0), 0, 65535);
  const layerCount = clamp(Math.round(opts.layerCount ?? 1), 1, 63);
  const layer = clamp(Math.round(opts.layer ?? 0), 0, layerCount - 1);
  if (frameOffset + src.count > 65535) throw new Error('Too many frames to print (limit 65535).');
  const header = headerFor(
    { paper, landscape, cols, rows, cellW10, cellH10, pitchX10, pitchY10, gridX0, gridY0 },
    0,
    pageCount,
    0,
    frameOffset + src.count,
  );
  const geometry = geometryFromHeader(header);
  return {
    geometry,
    dpi,
    guide: opts.guide ?? 'full',
    guideOpacity,
    frameWidthPx: Math.min(16383, Math.round(src.width)),
    frameHeightPx: Math.min(16383, Math.round(src.height)),
    totalFrames: frameOffset + src.count,
    fpsX100: clamp(Math.round(src.fps * 100), 1, 16383),
    perPage,
    pageCount,
    projectId: (opts.projectId ?? projectIdFromString(`${name}|${src.width}x${src.height}|${src.count}|${src.fps}`)) >>> 0,
    name,
    frameOffset,
    layer,
    layerCount,
    round: clamp(Math.round(opts.round ?? 0), 0, 63),
    blueGuide: !!opts.blueGuide,
    decor: opts.decor ?? {},
  };
}

function headerFor(
  g: { paper: PaperId; landscape: boolean; cols: number; rows: number; cellW10: number; cellH10: number; pitchX10: number; pitchY10: number; gridX0: number; gridY0: number },
  pageIndex: number,
  pageCount: number,
  firstFrame: number,
  totalFrames: number,
): SheetHeader {
  return {
    version: FORMAT_VERSION,
    paper: g.paper,
    landscape: g.landscape,
    pageIndex,
    pageCount,
    columns: g.cols,
    rows: g.rows,
    cellW: g.cellW10,
    cellH: g.cellH10,
    pitchX: g.pitchX10,
    pitchY: g.pitchY10,
    gridX0: g.gridX0,
    gridY0: g.gridY0,
    firstFrame,
    totalFrames,
    fpsX100: 0,
    frameW: 0,
    frameH: 0,
    guide: 'full',
    guideOpacity: 0,
    projectId: 0,
  };
}

/** Header (the data strip content) for page `pageIndex`. */
export function pageHeader(sheet: SheetLayout, pageIndex: number): SheetHeader {
  const g = sheet.geometry;
  return {
    version: FORMAT_VERSION,
    paper: g.paper,
    landscape: g.landscape,
    pageIndex,
    pageCount: sheet.pageCount,
    columns: g.columns,
    rows: g.rows,
    cellW: Math.round(g.cellWMm * 10),
    cellH: Math.round(g.cellHMm * 10),
    pitchX: Math.round(g.pitchXMm * 10),
    pitchY: Math.round(g.pitchYMm * 10),
    gridX0: Math.round(g.gridX0Mm * 10),
    gridY0: Math.round(g.gridY0Mm * 10),
    firstFrame: sheet.frameOffset + pageIndex * sheet.perPage,
    totalFrames: sheet.totalFrames,
    fpsX100: sheet.fpsX100,
    frameW: sheet.frameWidthPx,
    frameH: sheet.frameHeightPx,
    guide: sheet.guide,
    guideOpacity: sheet.guide === 'faded' ? sheet.guideOpacity : 100,
    projectId: sheet.projectId,
    ...(sheet.layerCount > 1 || sheet.round > 0 || sheet.blueGuide ? { layer: sheet.layer, layerCount: sheet.layerCount, round: sheet.round, blueGuide: sheet.blueGuide } : {}),
  };
}

/** Number of frames printed on a page. */
export function framesOnPage(sheet: SheetLayout, pageIndex: number): number {
  return Math.max(0, Math.min(sheet.perPage, sheet.totalFrames - sheet.frameOffset - pageIndex * sheet.perPage));
}

/** Frames on a page per decoded header. */
export function framesOnHeaderPage(h: SheetHeader): number {
  return Math.max(0, Math.min(h.columns * h.rows, h.totalFrames - h.firstFrame));
}

/** Human-readable caption printed at the foot of each page. */
export function captionFor(sheet: SheetLayout, pageIndex: number): string {
  const first = sheet.frameOffset + pageIndex * sheet.perPage;
  const last = first + framesOnPage(sheet, pageIndex) - 1;
  const fps = sheet.fpsX100 / 100;
  const name = sheet.name ? sheet.name.toUpperCase().replace(/[^A-Z0-9 ._()#%+/:=-]/g, '').slice(0, 28) : 'PRINT';
  const lay = sheet.layerCount > 1 ? `  LAYER ${sheet.layer + 1}/${sheet.layerCount}` : '';
  const rnd = sheet.round > 0 ? `  ROUND ${sheet.round + 1}` : '';
  return `${name}${lay}${rnd}  PAGE ${pageIndex + 1}/${sheet.pageCount}  FRAMES ${first + 1}-${last + 1} OF ${sheet.totalFrames}  ${Number.isInteger(fps) ? fps : fps.toFixed(2)} FPS  ID ${formatProjectId(sheet.projectId).slice(0, 6)}`;
}
