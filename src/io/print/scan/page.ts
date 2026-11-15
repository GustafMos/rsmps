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
import { applyH, bilerp, dist, fitHomography, invert3, mul3, type Mat3, type Pt } from '../geometry';
import { framesOnHeaderPage, geometryFromHeader, markCenterMm, markHalfFor, pageHeader, planSheet, type SheetGeometry } from '../layout';
import { createRaster, resizeRaster, sampleGray, toGray8, type RasterImage } from '../raster';
import { estimateWhiteField, whiteAt, type WhiteField } from './clean';
import { adaptiveBinarize, downscaleGray, findFinders, rankQuads } from './finder';
import { finderTemplate, markTemplate, matchTemplate } from './refine';
import { photoPixelsPerMm, rectify } from './rectify';
import { decodeStrip, decodeStripGrid, placeStrip } from './strip';
import { findPlusPeaks, inferLattice, trackLattice, type Peak } from './lattice';

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
  /** True when the layout was inferred from the + lattice because the strip was unreadable. */
  latticeLayout: boolean;
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
  /** Candidate "+" centres on the rectified page (rect px), computed on demand. */
  peaks: Peak[] | null;
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
  return { W, HH, H1, Hinv, fidPhoto, fidFound, rect, grayR, ppm, warnings, peaks: null };
}

/**
 * Read the strip from a crop rectified at 12 px/mm around where it should be: find its ink blob (the sheet may be
 * curled so the strip sits a few mm away from where the corner homography puts it), then sample its module grid.
 */
export function decodeStripLocated(photo: RasterImage, H1: Mat3, W: number): SheetHeader | null {
  const ppmS = 12;
  const cw = 64;
  const ch = 19;
  const x0 = W / 2 - cw / 2;
  const y0 = 2.5;
  const Hs = mul3(H1, [1, 0, x0, 0, 1, y0, 0, 0, 1]);
  const crop = rectify(photo, Hs, cw, ch, ppmS);
  const g = toGrayF(crop);
  const pl = placeStrip(g, crop.width, crop.height, ppmS);
  if (!pl) return null;
  const mx0 = pl.m / ppmS;
  if (mx0 < 0.6 || mx0 > 1.3) return null;
  // The sampler receives ideal axis-aligned coordinates (mm in the crop) and applies the measured shear.
  const ox = pl.ox / ppmS;
  const oy = pl.oy / ppmS;
  const sample = (x: number, y: number) => sampleGray(g, crop.width, crop.height, (x + pl.slopeX * (y - oy)) * ppmS, (y + pl.slopeY * (x - ox)) * ppmS);
  for (const k of [1, 0.985, 1.015]) {
    const header = decodeStripGrid(sample, ox, oy, mx0 * k, mx0 * k);
    if (header) return header;
  }
  return null;
}

/** Finder module size (px) per corner set, so the paper size can be judged from the markers' known 1.4 mm modules. */
const moduleHint = new WeakMap<object, number>();

function paperCandidates(corners: Pt[], limit: number): { paper: PaperId; landscape: boolean; s: { width: number; height: number }; d: number }[] {
  const aspectQuad = dist(corners[0], corners[1]) / Math.max(1e-6, dist(corners[0], corners[3]));
  const module = moduleHint.get(corners);
  // Distance between the two top finder centres in mm, from the known marker size (perspective-averaged module).
  const estSpan = module ? (dist(corners[0], corners[1]) / module) * 1.4 : null;
  const estSpanV = module ? (dist(corners[0], corners[3]) / module) * 1.4 : null;
  return PAPER_TRIES.map((t) => {
    const s = pageSizeMm(t.paper, t.landscape);
    const f = finderCentersMm(s.width, s.height);
    const aspErr = Math.abs(Math.log(aspectQuad / ((f[1].x - f[0].x) / (f[3].y - f[0].y))));
    const sizeErr = estSpan && estSpanV ? (Math.abs(Math.log(estSpan / (f[1].x - f[0].x))) + Math.abs(Math.log(estSpanV / (f[3].y - f[0].y)))) / 2 : 0;
    // A-series sizes are far more common; Letter vs A4 differ by only ~10% in aspect.
    return { ...t, s, aspErr, sizeErr, d: aspErr + sizeErr - (t.paper === 'letter' || t.paper === 'legal' ? 0 : 0.04) };
  })
    .filter((t) => t.aspErr < 0.25 && t.sizeErr < 0.45)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}

/**
 * Second chance for small or curled photos: align precisely for the most plausible paper sizes (finder centres
 * refined to sub-pixel), then find the strip near its expected place and read it.
 */
function decodeRefined(gray: Uint8Array, photo: RasterImage, corners: Pt[]): { header: SheetHeader; aligned: Aligned } | null {
  for (const t of paperCandidates(corners, 3)) {
    const al = alignToPage(photo, corners, t.s.width, t.s.height);
    if (!al) continue;
    const header =
      decodeStripLocated(photo, al.H1, t.s.width) ??
      decodeStrip((x, y) => {
        const p = applyH(al.H1, x, y);
        return sampleGray(gray, photo.width, photo.height, p.x, p.y);
      }, t.s.width);
    if (header) return { header, aligned: al };
  }
  return null;
}

function pagePeaks(al: Aligned, halfMm: number, thickMm: number): Peak[] {
  if (!al.peaks) {
    al.peaks = findPlusPeaks(al.grayR, al.rect.width, al.rect.height, al.ppm, halfMm, thickMm, {
      x0: 4 * al.ppm,
      y0: 15 * al.ppm,
      x1: (al.W - 4) * al.ppm,
      y1: (al.HH - 15) * al.ppm,
    });
  }
  return al.peaks;
}

/** White gap (mm) between frames, measured across the gutter next to the mark lattice; null when it cannot be measured. */
function measureGutter(gray: Float32Array, w: number, h: number, ppm: number, xMm: number, yMm: number, spanMm: number): number | null {
  const prof: number[] = [];
  const y0 = Math.max(0, Math.round((yMm - spanMm) * ppm));
  const y1 = Math.min(h - 1, Math.round((yMm + spanMm) * ppm));
  const cx = Math.round(xMm * ppm);
  for (let y = y0; y <= y1; y++) {
    let v = 0;
    for (let dx = -3; dx <= 3; dx++) v += gray[y * w + Math.min(w - 1, Math.max(0, cx + dx))];
    prof.push(v / 7);
  }
  const sorted = [...prof].sort((a, b) => a - b);
  const dark = sorted[Math.floor(sorted.length * 0.1)];
  const paper = sorted[Math.floor(sorted.length * 0.92)];
  if (paper - dark < 45) return null;
  const thr = (dark + paper) / 2;
  const mid = Math.round(yMm * ppm) - y0;
  if (mid < 0 || mid >= prof.length || prof[mid] < thr) return null;
  let a = mid;
  let b = mid;
  while (a > 0 && prof[a - 1] >= thr) a--;
  while (b < prof.length - 1 && prof[b + 1] <= 1e9 && prof[b + 1] >= thr) b++;
  if (a === 0 || b === prof.length - 1) return null;
  const gap = (b - a + 1) / ppm;
  return gap >= 3 && gap <= 20 ? gap : null;
}

/**
 * No readable strip: infer the layout (columns, rows, pitch, gutter) from the "+" lattice of the aligned page.
 * Paper size comes from the finder aspect; page number, frame count and fps are unknown.
 */
export function inferHeaderFromLattice(al: Aligned, paper: PaperId, landscape: boolean, pageIndex: number): { header: SheetHeader; gutterMeasured: boolean } | null {
  const half = markHalfFor(5);
  const peaks = pagePeaks(al, half, 0.4);
  const mm = peaks.filter((p) => p.score >= 0.75).map((p) => ({ x: p.x / al.ppm, y: p.y / al.ppm })).filter((p) => p.x > 4 && p.x < al.W - 4 && p.y > 16 && p.y < al.HH - 16)
    // the strip's own blobs can look like crosses
    .filter((p) => !(Math.abs(p.x - al.W / 2) < 26 && p.y < 20.5));
  const lat = inferLattice(mm, 5);
  if (!lat) return null;
  const cols = lat.x.count - 1;
  const rows = lat.y.count - 1;
  if (cols < 1 || rows < 1 || cols > 63 || rows > 63) return null;
  // Sample the gap at many places (frame content such as a white shape can fill a gutter locally); the smaller gaps are the truth.
  const gaps: number[] = [];
  for (let r = 0; r < lat.y.count; r++) {
    for (let c = 0; c < lat.x.count - 1; c++) {
      for (const fr of [0.2, 0.5, 0.8]) {
        const g = measureGutter(al.grayR, al.rect.width, al.rect.height, al.ppm, lat.x.origin + lat.x.pitch * (c + fr), lat.y.origin + lat.y.pitch * r, 9);
        if (g !== null) gaps.push(g);
      }
    }
  }
  gaps.sort((p, q) => p - q);
  const measured = gaps.length >= 4 ? gaps[Math.floor(gaps.length * 0.25)] : null;
  const gutter = Math.min(Math.max(measured ?? 5, 3), Math.min(20, Math.min(lat.x.pitch, lat.y.pitch) - 8));
  const t10 = (v: number) => Math.round(v * 10);
  const cellW = t10(lat.x.pitch - gutter);
  const cellH = t10(lat.y.pitch - gutter);
  const perPage = cols * rows;
  return {
    gutterMeasured: measured !== null,
    header: {
      version: 1,
      paper,
      landscape,
      pageIndex,
      pageCount: pageIndex + 1,
      columns: cols,
      rows,
      cellW,
      cellH,
      pitchX: cellW + t10(gutter),
      pitchY: cellH + t10(gutter),
      gridX0: t10(lat.x.origin + gutter / 2),
      gridY0: t10(lat.y.origin + gutter / 2),
      firstFrame: pageIndex * perPage,
      totalFrames: (pageIndex + 1) * perPage,
      fpsX100: 0,
      frameW: 0,
      frameH: 0,
      guide: 'full',
      guideOpacity: 100,
      projectId: 0,
    },
  };
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
  return { report, header: null, manualLayout: false, latticeLayout: false, frames: [], rectified: null, quality: Infinity };
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
  const hypList: { corners: Pt[]; quad: number; rank: number }[] = [];
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
    const quads = rankQuads(finders, 4);
    if (quads.length === 0) {
      return fail(
        report,
        `Not all four corner markers were found (${finders.length} candidate${finders.length === 1 ? '' : 's'} detected, none forming a paper-shaped quadrilateral): one is probably covered, cut off or too blurred. Photograph the whole sheet flat, in good light, with all four corner markers visible, or mark the corners by hand.`,
      );
    }
    quads.forEach((quad, qi) => {
      const q = quad.map((c) => ({ x: c.x * f, y: c.y * f, module: c.module * f }));
      const ranked = rankRotations(q, gray, w, h);
      if (qi === 0) ambiguous = ranked[0].ambiguous;
      const avgModule = q.reduce((sum, p) => sum + p.module, 0) / 4;
      ranked.forEach((r) => moduleHint.set(r.corners, avgModule));
      ranked.forEach((r, ri) => hypList.push({ corners: r.corners, quad: qi, rank: ri }));
    });
    hyps = hypList.map((h2) => h2.corners);
    report.cornersSource = 'auto';
  }

  /* ---- 2. layout ---- */
  let corners: Pt[] = hyps[0];
  let header: SheetHeader | null = null;
  let manualLayout = false;
  let latticeLayout = false;
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
      const refinedTries = hypList.length ? hypList.filter((h2) => h2.rank < 2).map((h2) => h2.corners) : hyps;
      for (const c of refinedTries) {
        const r = decodeRefined(gray, photo, c);
        if (r) {
          header = r.header;
          aligned = r.aligned;
          corners = c;
          break;
        }
      }
    }
    if (header) report.layoutSource = 'strip';
    if (!header) {
      // No strip: recover the layout from the "+" lattice so frames can still be cut.
      const cand = paperCandidates(hyps[0], 1)[0];
      const al = cand ? alignToPage(photo, hyps[0], cand.s.width, cand.s.height) : null;
      const inferred = al && cand ? inferHeaderFromLattice(al, cand.paper, cand.landscape, manual?.pageIndex ?? index) : null;
      if (!inferred || !al || !cand) {
        report.corners = cornersObject(hyps[0]);
        return fail(
          report,
          'The four corner markers were found but the data strip could not be read and no regular grid of + marks could be recognised. Enter the page layout by hand (paper, columns, rows).',
          { corners: report.corners },
        );
      }
      header = inferred.header;
      aligned = al;
      corners = hyps[0];
      manualLayout = true;
      latticeLayout = true;
      report.layoutSource = 'lattice';
      report.warnings.push(
        `The data strip could not be read; the layout was detected from the + marks instead: ${header.columns} x ${header.rows} frames on ${cand.paper.toUpperCase()}${cand.landscape ? ' landscape' : ''}${inferred.gutterMeasured ? '' : ' (gutter assumed 5 mm)'}. Please confirm the page number, total frame count and fps${ambiguous ? ', and check the page orientation (the top-left marker was not clearly identified)' : ''}.`,
      );
    }
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

  /* ---- 4. find every "+" mark: matched filter, then a smooth warp tracks the lattice ---- */
  const cols = geo.columns;
  const rows = geo.rows;
  const peaks = pagePeaks(al, geo.markHalfMm, geo.markThickMm);
  const expected: { x: number; y: number }[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const mm = markCenterMm(geo, c, r);
      expected.push({ x: mm.x * ppm, y: mm.y * ppm });
    }
  }
  const maxRadius = 0.4 * Math.min(geo.pitchXMm, geo.pitchYMm) * ppm;
  const tracked = trackLattice(expected, peaks, Math.min(5 * ppm, maxRadius), 1.5 * ppm);
  const grid: MarkInfo[][] = [];
  for (let r = 0; r <= rows; r++) {
    const rowInfo: MarkInfo[] = [];
    for (let c = 0; c <= cols; c++) {
      const node = tracked.nodes[r * (cols + 1) + c];
      const mm = markCenterMm(geo, c, r);
      const predicted = applyH(H1, mm.x, mm.y);
      const p = applyH(H1, node.x / ppm, node.y / ppm);
      rowInfo.push({ photo: p, found: !!node.peak, score: node.peak?.score ?? 0, residual: dist(p, predicted) });
    }
    grid.push(rowInfo);
  }
  const foundList: { r: number; c: number }[] = [];
  grid.forEach((row, r) => row.forEach((m, c) => m.found && foundList.push({ r, c })));
  if (foundList.length < Math.max(4, Math.ceil(0.25 * (rows + 1) * (cols + 1)))) {
    return fail(report, 'Too few registration marks could be located on this page (covered by drawing, or the photo is too blurred).', {
      marksFound: foundList.length,
      marksExpected: (rows + 1) * (cols + 1),
    });
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
  const dpiPx = Math.min(300 / 25.4, photoPixelsPerMm(H1, W / 2, HH / 2) * 1.5);
  let outW = opts.outputWidth ?? (header.frameW || Math.round(geo.cellWMm * dpiPx));
  let outH = opts.outputHeight ?? (header.frameH || Math.round(geo.cellHMm * dpiPx));
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
  return { report, header, manualLayout, latticeLayout, frames, rectified: small, quality: (reproj ?? 99) + missingPenalty + (fidFound < 4 ? 20 : 0) };
}

function cornersObject(c: Pt[]): ScanCorners {
  return { tl: { x: c[0].x, y: c[0].y }, tr: { x: c[1].x, y: c[1].y }, br: { x: c[2].x, y: c[2].y }, bl: { x: c[3].x, y: c[3].y } };
}
