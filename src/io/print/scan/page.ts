/**
 * Scan one photo of one printed sheet: finder detection, orientation, strip decoding, homography,
 * refinement against the "+" marks, and cutting the frames. Pure: operates on RGBA typed arrays.
 */
import type { ScanCorners, ScanLayoutInfo, ScanManualInput, ScanMarkResult, ScanPageReport, ScanPoint } from '../../api';
import {
  PAPER_CODES,
  formatProjectId,
  finderCentersMm,
  pageSizeMm,
  type PaperId,
  type SheetHeader,
} from '../format';
import { applyH, bilerp, dist, fitHomography, invert3, type Mat3, type Pt } from '../geometry';
import { framesOnHeaderPage, geometryFromHeader, markCenterMm, pageHeader, planSheet, type SheetGeometry } from '../layout';
import { createRaster, resizeRaster, sampleGray, toGray8, type RasterImage } from '../raster';
import { estimateWhiteField, whiteAt, type WhiteField } from './clean';
import { adaptiveBinarize, downscaleGray, findFinders, selectQuad } from './finder';
import { finderTemplate, markTemplate, matchTemplate } from './refine';
import { photoPixelsPerMm, rectify } from './rectify';
import { decodeStrip } from './strip';

export interface PageScanOptions {
  manual?: ScanManualInput;
  /** Cut frames to this size (default: original frame size from the strip, else cell size at 300 dpi). */
  outputWidth?: number;
  outputHeight?: number;
  /** Flatten uneven lighting to white using the blank paper (default true). */
  flatten?: boolean;
}

export interface PageScan {
  report: ScanPageReport;
  header: SheetHeader | null;
  /** True when the layout did not come from a strip (totals may need to be derived across pages). */
  manualLayout: boolean;
  frames: { index: number; image: RasterImage }[];
  /** The rectified page (analysis resolution), or null. */
  rectified: RasterImage | null;
  /** Lower is better; used to choose between two photos of the same page. */
  quality: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const PAPER_TRIES: { paper: PaperId; landscape: boolean }[] = PAPER_CODES.flatMap((paper) => [
  { paper, landscape: false },
  { paper, landscape: true },
]);

function blankReport(index: number, fileName: string, photo: RasterImage): ScanPageReport {
  return {
    index,
    fileName,
    photoWidth: photo.width,
    photoHeight: photo.height,
    status: 'failed',
    corners: null,
    foundCorners: [],
    cornersSource: null,
    rotation: 0,
    skewDeg: 0,
    layout: null,
    layoutSource: null,
    pageIndex: null,
    frameRange: null,
    reprojectionErrorPx: null,
    marksFound: 0,
    marksExpected: 0,
    marks: [],
    cells: [],
    used: false,
    thumbnailUrl: null,
    thumbnailKind: 'photo',
    photoUrl: null,
    photoScale: 1,
    warnings: [],
  };
}

/** Circular mean (mod 90 degrees) of the directions from `p` to its two neighbours: the finder's local axis angle. */
function localAxisAngle(p: Pt, a: Pt, b: Pt): number {
  const a1 = Math.atan2(a.y - p.y, a.x - p.x);
  const a2 = Math.atan2(b.y - p.y, b.x - p.x);
  return Math.atan2(Math.sin(4 * a1) + Math.sin(4 * a2), Math.cos(4 * a1) + Math.cos(4 * a2)) / 4;
}

/** How dark the white-ring corner modules are relative to the finder contrast: ~0.7 for the top-left finder (it has a notch), ~0 for the others. */
function notchDarkness(gray: Uint8Array, w: number, h: number, c: Pt & { module: number }, theta: number): number {
  const u = c.module;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const at = (mx: number, my: number) => {
    let s = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ox = (mx + i * 0.25) * u;
        const oy = (my + j * 0.25) * u;
        s += sampleGray(gray, w, h, c.x + ct * ox - st * oy, c.y + st * ox + ct * oy);
      }
    }
    return s / 9;
  };
  const white = (at(2, 0) + at(-2, 0) + at(0, 2) + at(0, -2)) / 4;
  const black = (at(3, 0) + at(-3, 0) + at(0, 3) + at(0, -3)) / 4;
  const range = white - black;
  if (range < 20) return 0;
  let best = 0;
  for (const sx of [-2, 2]) for (const sy of [-2, 2]) best = Math.max(best, (white - at(sx, sy)) / range);
  return best;
}

/** The four rotations of a clockwise-ordered quad as [tl, tr, br, bl], best (most notch-like top-left) first. */
function rankRotations(q: (Pt & { module: number })[], gray: Uint8Array, w: number, h: number): { corners: Pt[]; ambiguous: boolean }[] {
  const scores = q.map((p, i) => notchDarkness(gray, w, h, p, localAxisAngle(p, q[(i + 3) % 4], q[(i + 1) % 4])));
  const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a]);
  const ambiguous = scores[order[0]] < 0.3 || scores[order[0]] - scores[order[1]] < 0.15;
  return order.map((i) => ({ corners: [0, 1, 2, 3].map((k) => ({ x: q[(i + k) % 4].x, y: q[(i + k) % 4].y })), ambiguous }));
}

function decodeAny(gray: Uint8Array, w: number, h: number, corners: Pt[]): SheetHeader | null {
  const tl = corners[0];
  const tr = corners[1];
  const bl = corners[3];
  const aspectQuad = dist(tl, tr) / Math.max(1e-6, dist(tl, bl));
  const tries = PAPER_TRIES.map((t) => {
    const s = pageSizeMm(t.paper, t.landscape);
    const f = finderCentersMm(s.width, s.height);
    const asp = (f[1].x - f[0].x) / (f[3].y - f[0].y);
    return { ...t, s, f, d: Math.abs(Math.log(aspectQuad / asp)) };
  }).sort((a, b) => a.d - b.d);
  for (const t of tries) {
    const H = fitHomography(t.f, corners);
    if (!H) continue;
    const header = decodeStrip((x, y) => {
      const p = applyH(H, x, y);
      return sampleGray(gray, w, h, p.x, p.y);
    }, t.s.width);
    if (header) return header;
  }
  return null;
}

interface Aligned {
  W: number;
  HH: number;
  H1: Mat3;
  Hinv: Mat3;
  fidPhoto: Pt[];
  fidFound: number;
  rect: RasterImage;
  grayR: Float32Array;
  ppm: number;
  warnings: string[];
}

/** Homography from the four finder centres, refined by template matching on the rectified page, plus the rectified page. */
export function alignToPage(photo: RasterImage, corners: Pt[], W: number, HH: number): Aligned | null {
  const fidMm = finderCentersMm(W, HH);
  const H0 = fitHomography(fidMm, corners);
  if (!H0) return null;
  const ppm = clamp(photoPixelsPerMm(H0, W / 2, HH / 2), 4, 9);
  const rect0 = rectify(photo, H0, W, HH, ppm);
  const gray0 = toGrayF(rect0);
  const fidPhoto: Pt[] = [];
  const warnings: string[] = [];
  let fidFound = 0;
  for (let i = 0; i < 4; i++) {
    const tpl = finderTemplate(ppm, i === 0);
    const m = matchTemplate(gray0, rect0.width, rect0.height, tpl, fidMm[i].x * ppm, fidMm[i].y * ppm, 4 * ppm);
    if (m && m.score >= 0.5) {
      fidPhoto.push(applyH(H0, m.x / ppm, m.y / ppm));
      fidFound++;
    } else {
      fidPhoto.push(corners[i]);
      warnings.push(`Corner marker ${['top-left', 'top-right', 'bottom-right', 'bottom-left'][i]} could not be refined (${m ? `match ${m.score.toFixed(2)}` : 'outside the image'}); using the coarse position.`);
    }
  }
  const H1 = fitHomography(fidMm, fidPhoto) ?? H0;
  const Hinv = invert3(H1);
  if (!Hinv) return null;
  const rect = fidFound > 0 ? rectify(photo, H1, W, HH, ppm) : rect0;
  const grayR = fidFound > 0 ? toGrayF(rect) : gray0;
  return { W, HH, H1, Hinv, fidPhoto, fidFound, rect, grayR, ppm, warnings };
}

/**
 * Second chance for small photos: align precisely for the most plausible paper sizes first (finder centres refined
 * to sub-pixel), then read the strip through the refined homography.
 */
function decodeRefined(gray: Uint8Array, photo: RasterImage, corners: Pt[]): { header: SheetHeader; aligned: Aligned } | null {
  const aspectQuad = dist(corners[0], corners[1]) / Math.max(1e-6, dist(corners[0], corners[3]));
  const tries = PAPER_TRIES.map((t) => {
    const s = pageSizeMm(t.paper, t.landscape);
    const f = finderCentersMm(s.width, s.height);
    return { s, d: Math.abs(Math.log(aspectQuad / ((f[1].x - f[0].x) / (f[3].y - f[0].y)))) };
  })
    .filter((t) => t.d < 0.25)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  for (const t of tries) {
    const al = alignToPage(photo, corners, t.s.width, t.s.height);
    if (!al) continue;
    const header = decodeStrip((x, y) => {
      const p = applyH(al.H1, x, y);
      return sampleGray(gray, photo.width, photo.height, p.x, p.y);
    }, t.s.width);
    if (header) return { header, aligned: al };
  }
  return null;
}

function layoutInfo(header: SheetHeader, g: SheetGeometry): ScanLayoutInfo {
  return {
    paper: header.paper,
    landscape: header.landscape,
    pageWidthMm: g.pageWidthMm,
    pageHeightMm: g.pageHeightMm,
    pageIndex: header.pageIndex,
    pageCount: header.pageCount,
    columns: header.columns,
    rows: header.rows,
    cellWidthMm: g.cellWMm,
    cellHeightMm: g.cellHMm,
    gutterMm: g.gutterMm,
    firstFrame: header.firstFrame,
    framesOnPage: framesOnHeaderPage(header),
    totalFrames: header.totalFrames,
    fps: header.fpsX100 / 100,
    frameWidthPx: header.frameW,
    frameHeightPx: header.frameH,
    guide: header.guide,
    guideOpacity: header.guideOpacity,
    projectId: formatProjectId(header.projectId),
  };
}

function manualHeader(manual: ScanManualInput, fallbackIndex: number): SheetHeader {
  const ml = manual.layout!;
  const aspect = ml.frameAspect && ml.frameAspect > 0 ? ml.frameAspect : 1;
  const pageIndex = manual.pageIndex ?? fallbackIndex;
  const perPage = Math.max(1, Math.round(ml.columns)) * Math.max(1, Math.round(ml.rows));
  const firstFrame = manual.firstFrame ?? pageIndex * perPage;
  const total = manual.totalFrames ?? firstFrame + perPage;
  const sheet = planSheet(
    { paper: ml.paper, orientation: ml.landscape ? 'landscape' : 'portrait', columns: ml.columns, rows: ml.rows, gutterMm: ml.gutterMm, marginMm: ml.marginMm },
    { width: Math.round(aspect * 1000), height: 1000, count: Math.max(1, total), fps: manual.fps ?? 12 },
  );
  const h = pageHeader(sheet, 0);
  return {
    ...h,
    pageIndex,
    pageCount: Math.max(sheet.pageCount, pageIndex + 1),
    firstFrame,
    totalFrames: Math.max(total, firstFrame + 1),
    frameW: manual.frameWidthPx ?? 0,
    frameH: manual.frameHeightPx ?? 0,
    projectId: 0,
    fpsX100: Math.round((manual.fps ?? 12) * 100),
  };
}

function toGrayF(img: RasterImage): Float32Array {
  return Float32Array.from(toGray8(img));
}

interface MarkInfo {
  photo: Pt;
  found: boolean;
  score: number;
  residual: number;
}

/** Cut one cell using the four refined marks around it (bilinear in photo space), optionally flattening paper white. */
export function cutCell(
  photo: RasterImage,
  P: Pt[][],
  R: Pt[][],
  g: SheetGeometry,
  col: number,
  row: number,
  outW: number,
  outH: number,
  field: WhiteField | null,
): RasterImage {
  const out = createRaster(outW, outH);
  const o = out.data;
  const pd = photo.data;
  const pw = photo.width;
  const ph = photo.height;
  const u0 = g.gutterMm / 2 / g.pitchXMm;
  const u1 = 1 - u0;
  const v0 = g.gutterMm / 2 / g.pitchYMm;
  const v1 = 1 - v0;
  const p00 = P[row][col];
  const p10 = P[row][col + 1];
  const p01 = P[row + 1][col];
  const p11 = P[row + 1][col + 1];
  const r00 = R[row][col];
  const r10 = R[row][col + 1];
  const r01 = R[row + 1][col];
  const r11 = R[row + 1][col + 1];
  const srcW = dist(bilerp(p00, p10, p01, p11, u0, 0.5), bilerp(p00, p10, p01, p11, u1, 0.5));
  const srcH = dist(bilerp(p00, p10, p01, p11, 0.5, v0), bilerp(p00, p10, p01, p11, 0.5, v1));
  const ssx = clamp(Math.ceil(srcW / outW), 1, 4);
  const ssy = clamp(Math.ceil(srcH / outH), 1, 4);
  const white = [255, 255, 255];
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let sj = 0; sj < ssy; sj++) {
        const v = v0 + (v1 - v0) * ((y + (sj + 0.5) / ssy) / outH);
        for (let si = 0; si < ssx; si++) {
          const u = u0 + (u1 - u0) * ((x + (si + 0.5) / ssx) / outW);
          const p = bilerp(p00, p10, p01, p11, u, v);
          const sx = p.x - 0.5;
          const sy = p.y - 0.5;
          let x0 = Math.floor(sx);
          let y0 = Math.floor(sy);
          const tx = sx - x0;
          const ty = sy - y0;
          let x1 = x0 + 1;
          let y1 = y0 + 1;
          x0 = x0 < 0 ? 0 : x0 >= pw ? pw - 1 : x0;
          x1 = x1 < 0 ? 0 : x1 >= pw ? pw - 1 : x1;
          y0 = y0 < 0 ? 0 : y0 >= ph ? ph - 1 : y0;
          y1 = y1 < 0 ? 0 : y1 >= ph ? ph - 1 : y1;
          const a = (1 - tx) * (1 - ty);
          const bb = tx * (1 - ty);
          const c = (1 - tx) * ty;
          const d = tx * ty;
          const i00 = (y0 * pw + x0) * 4;
          const i10 = (y0 * pw + x1) * 4;
          const i01 = (y1 * pw + x0) * 4;
          const i11 = (y1 * pw + x1) * 4;
          let pr = pd[i00] * a + pd[i10] * bb + pd[i01] * c + pd[i11] * d;
          let pg = pd[i00 + 1] * a + pd[i10 + 1] * bb + pd[i01 + 1] * c + pd[i11 + 1] * d;
          let pb = pd[i00 + 2] * a + pd[i10 + 2] * bb + pd[i01 + 2] * c + pd[i11 + 2] * d;
          if (field) {
            const rp = bilerp(r00, r10, r01, r11, u, v);
            whiteAt(field, rp.x, rp.y, white);
            pr = Math.min(255, (pr * 255) / white[0]);
            pg = Math.min(255, (pg * 255) / white[1]);
            pb = Math.min(255, (pb * 255) / white[2]);
          }
          r += pr;
          gg += pg;
          b += pb;
        }
      }
      const n = ssx * ssy;
      const j = (y * outW + x) * 4;
      o[j] = r / n;
      o[j + 1] = gg / n;
      o[j + 2] = b / n;
    }
  }
  return out;
}

function fail(report: ScanPageReport, message: string, extra: Partial<ScanPageReport> = {}): PageScan {
  Object.assign(report, extra);
  report.status = 'failed';
  report.warnings.push(message);
  return { report, header: null, manualLayout: false, frames: [], rectified: null, quality: Infinity };
}

/** Scan one photo. `index` is its position in the caller's list (kept in the report). Never throws on bad photos. */
export function scanPage(photo: RasterImage, fileName: string, index: number, opts: PageScanOptions = {}): PageScan {
  const report = blankReport(index, fileName, photo);
  const manual = opts.manual;
  const w = photo.width;
  const h = photo.height;
  if (w < 64 || h < 64) return fail(report, 'The image is too small to contain a printed sheet.');
  const gray = toGray8(photo);

  /* ---- 1. corner hypotheses ---- */
  let hyps: Pt[][];
  let ambiguous = false;
  if (manual?.corners) {
    const c = manual.corners;
    hyps = [[c.tl, c.tr, c.br, c.bl]];
    report.cornersSource = 'manual';
  } else {
    const f = Math.max(1, Math.ceil(Math.max(w, h) / 1800));
    const small = downscaleGray(gray, w, h, f);
    const radius = clamp(Math.round(Math.min(small.width, small.height) / 10), 12, 120);
    const bin = adaptiveBinarize(small.data, small.width, small.height, radius);
    const finders = findFinders(bin, small.width, small.height).sort((a, b) => b.hits - a.hits);
    report.foundCorners = finders.slice(0, 8).map((c): ScanPoint => ({ x: c.x * f, y: c.y * f }));
    const quad = selectQuad(finders);
    if (!quad) {
      return fail(
        report,
        `Not all four corner markers were found (${finders.length} candidate${finders.length === 1 ? '' : 's'} detected): one is probably covered, cut off or too blurred. Photograph the whole sheet flat, in good light, with all four corner markers visible, or mark the corners by hand.`,
      );
    }
    const q = quad.map((c) => ({ x: c.x * f, y: c.y * f, module: c.module * f }));
    const ranked = rankRotations(q, gray, w, h);
    ambiguous = ranked[0].ambiguous;
    hyps = ranked.map((r) => r.corners);
    report.cornersSource = 'auto';
  }

  /* ---- 2. layout ---- */
  let corners: Pt[] = hyps[0];
  let header: SheetHeader | null = null;
  let manualLayout = false;
  let aligned: Aligned | null = null;
  if (manual?.layout) {
    try {
      header = manualHeader(manual, index);
    } catch (err) {
      return fail(report, `The manual layout is not valid: ${err instanceof Error ? err.message : String(err)}`);
    }
    manualLayout = true;
    report.layoutSource = 'manual';
    if (ambiguous) report.warnings.push('The top-left corner marker could not be told apart from the others; check the orientation.');
  } else {
    for (const c of hyps) {
      header = decodeAny(gray, w, h, c);
      if (header) {
        corners = c;
        break;
      }
    }
    if (!header) {
      for (const c of hyps) {
        const r = decodeRefined(gray, photo, c);
        if (r) {
          header = r.header;
          aligned = r.aligned;
          corners = c;
          break;
        }
      }
    }
    if (!header) {
      report.corners = cornersObject(hyps[0]);
      return fail(
        report,
        'The corner markers were found but the printed data strip could not be read (blurred, too small or damaged). Enter the page layout by hand (paper, columns, rows).',
        { corners: report.corners },
      );
    }
    report.layoutSource = 'strip';
  }
  report.corners = cornersObject(corners);
  const geo = geometryFromHeader(header);
  report.layout = layoutInfo(header, geo);
  report.pageIndex = header.pageIndex;
  const framesHere = framesOnHeaderPage(header) || header.columns * header.rows;
  report.frameRange = [header.firstFrame, header.firstFrame + framesHere - 1];
  const angle = (Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180) / Math.PI;
  const quarter = Math.round(angle / 90);
  report.rotation = ((((quarter * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  report.skewDeg = Math.round((angle - quarter * 90) * 10) / 10;

  /* ---- 3. homography from the four finders, refined on the rectified page ---- */
  const W = geo.pageWidthMm;
  const HH = geo.pageHeightMm;
  const al = aligned && Math.abs(aligned.W - W) < 1e-6 && Math.abs(aligned.HH - HH) < 1e-6 ? aligned : alignToPage(photo, corners, W, HH);
  if (!al) return fail(report, 'The corner markers do not form a usable quadrilateral.');
  report.warnings.push(...al.warnings);
  const { H1, Hinv, fidPhoto, fidFound, rect, grayR, ppm } = al;
  const fidMm = finderCentersMm(W, HH);

  /* ---- 4. refine every "+" mark ---- */
  const cols = geo.columns;
  const rows = geo.rows;
  const tpl = markTemplate(ppm, geo.markHalfMm, geo.markThickMm);
  const grid: MarkInfo[][] = [];
  const radii = [1.3 * ppm, Math.min(2.4, geo.gutterMm / 2 - 0.2) * ppm];
  for (let r = 0; r <= rows; r++) {
    const rowInfo: MarkInfo[] = [];
    for (let c = 0; c <= cols; c++) {
      const mm = markCenterMm(geo, c, r);
      const predicted = applyH(H1, mm.x, mm.y);
      let info: MarkInfo = { photo: predicted, found: false, score: 0, residual: 0 };
      for (const radius of radii) {
        const m = matchTemplate(grayR, rect.width, rect.height, tpl, mm.x * ppm, mm.y * ppm, radius);
        if (m && m.score >= 0.5) {
          const p = applyH(H1, m.x / ppm, m.y / ppm);
          info = { photo: p, found: true, score: m.score, residual: dist(p, predicted) };
          break;
        }
        if (m) info.score = Math.max(info.score, m.score);
      }
      rowInfo.push(info);
    }
    grid.push(rowInfo);
  }
  // Marks that were not found follow the displacement of their nearest found neighbours.
  const foundList: { r: number; c: number }[] = [];
  grid.forEach((row, r) => row.forEach((m, c) => m.found && foundList.push({ r, c })));
  if (foundList.length < Math.max(4, Math.ceil(0.25 * (rows + 1) * (cols + 1)))) {
    return fail(report, 'Too few registration marks could be located on this page (covered by drawing, or the photo is too blurred).', {
      marksFound: foundList.length,
      marksExpected: (rows + 1) * (cols + 1),
    });
  }
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (grid[r][c].found) continue;
      const mm = markCenterMm(geo, c, r);
      const predicted = applyH(H1, mm.x, mm.y);
      const near = foundList
        .map((f) => ({ f, d: Math.hypot(f.r - r, f.c - c) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (const { f, d } of near) {
        const fm = markCenterMm(geo, f.c, f.r);
        const fp = applyH(H1, fm.x, fm.y);
        const wgt = 1 / (d * d + 0.25);
        sx += (grid[f.r][f.c].photo.x - fp.x) * wgt;
        sy += (grid[f.r][f.c].photo.y - fp.y) * wgt;
        sw += wgt;
      }
      grid[r][c].photo = { x: predicted.x + sx / sw, y: predicted.y + sy / sw };
      grid[r][c].residual = Math.hypot(sx / sw, sy / sw);
    }
  }
  const P = grid.map((row) => row.map((m) => m.photo));
  const R = P.map((row) => row.map((p) => {
    const mm = applyH(Hinv, p.x, p.y);
    return { x: mm.x * ppm, y: mm.y * ppm };
  }));

  // How far is the page from one flat perspective? RMS of found marks around the best-fit homography.
  const srcMm: Pt[] = [...fidMm];
  const dstPh: Pt[] = [...fidPhoto];
  grid.forEach((row, r) => row.forEach((m, c) => {
    if (!m.found) return;
    srcMm.push(markCenterMm(geo, c, r));
    dstPh.push(m.photo);
  }));
  const H2 = fitHomography(srcMm, dstPh);
  let reproj: number | null = null;
  if (H2) {
    let s = 0;
    for (let i = 0; i < srcMm.length; i++) {
      const p = applyH(H2, srcMm[i].x, srcMm[i].y);
      s += (p.x - dstPh[i].x) ** 2 + (p.y - dstPh[i].y) ** 2;
    }
    reproj = Math.sqrt(s / srcMm.length);
  }
  report.reprojectionErrorPx = reproj === null ? null : Math.round(reproj * 100) / 100;
  report.marksExpected = (rows + 1) * (cols + 1);
  report.marksFound = foundList.length;
  report.marks = grid.flatMap((row, r) =>
    row.map((m, c): ScanMarkResult => ({ column: c, row: r, found: m.found, score: Math.round(Math.max(0, m.score) * 1000) / 1000, residualPx: Math.round(m.residual * 100) / 100 })),
  );
  if (report.marksFound < report.marksExpected) {
    report.warnings.push(`${report.marksExpected - report.marksFound} of ${report.marksExpected} registration marks could not be located; their positions were interpolated, so nearby frames may be slightly misaligned.`);
  }
  const scale = photoPixelsPerMm(H1, W / 2, HH / 2);
  if (reproj !== null && reproj > 0.6 * scale) {
    report.warnings.push(`The sheet is strongly curved or the lens distorts a lot (${reproj.toFixed(1)} px); frames were registered mark by mark but may be soft near the edges.`);
  }

  /* ---- 5. cut frames ---- */
  const field = opts.flatten === false ? null : estimateWhiteField(rect, geo, ppm);
  if (opts.flatten !== false && !field) report.warnings.push('There was not enough blank paper to correct the lighting; frames were not flattened.');
  let outW = opts.outputWidth ?? (header.frameW || Math.round((geo.cellWMm * 300) / 25.4));
  let outH = opts.outputHeight ?? (header.frameH || Math.round((geo.cellHMm * 300) / 25.4));
  if (opts.outputWidth && !opts.outputHeight) outH = Math.max(1, Math.round((outW * geo.cellHMm) / geo.cellWMm));
  if (opts.outputHeight && !opts.outputWidth) outW = Math.max(1, Math.round((outH * geo.cellWMm) / geo.cellHMm));
  outW = clamp(Math.round(outW), 1, 4096);
  outH = clamp(Math.round(outH), 1, 4096);
  const frames: PageScan['frames'] = [];
  for (let k = 0; k < framesHere; k++) {
    const col = k % cols;
    const row = Math.floor(k / cols);
    frames.push({ index: header.firstFrame + k, image: cutCell(photo, P, R, geo, col, row, outW, outH, field) });
    const corner = [grid[row][col], grid[row][col + 1], grid[row + 1][col], grid[row + 1][col + 1]];
    report.cells.push({
      frame: header.firstFrame + k,
      column: col,
      row,
      marksFound: corner.filter((m) => m.found).length,
      maxResidualPx: Math.round(Math.max(...corner.map((m) => m.residual)) * 100) / 100,
    });
  }
  if (frames.length === 0) return fail(report, 'This page carries no frames.');
  const small = Math.max(rect.width, rect.height) > 480 ? resizeRaster(rect, Math.round((rect.width * 480) / Math.max(rect.width, rect.height)), Math.round((rect.height * 480) / Math.max(rect.width, rect.height)), 'area') : rect;
  report.status = report.warnings.length > 0 ? 'warning' : 'ok';
  report.thumbnailKind = 'rectified';
  const missingPenalty = (report.marksExpected - report.marksFound) * 5;
  return { report, header, manualLayout, frames, rectified: small, quality: (reproj ?? 99) + missingPenalty + (fidFound < 4 ? 20 : 0) };
}

function cornersObject(c: Pt[]): ScanCorners {
  return { tl: { x: c[0].x, y: c[0].y }, tr: { x: c[1].x, y: c[1].y }, br: { x: c[2].x, y: c[2].y }, bl: { x: c[3].x, y: c[3].y } };
}
