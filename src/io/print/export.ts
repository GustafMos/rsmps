/**
 * The 'print' export kind, free of GPU and browser APIs: it pulls frames through a callback, lays out the
 * sheets and returns PDF and/or PNG files. The exporter supplies `renderFrame`.
 */
import type { ExportedFile } from '../api';
import { formatProjectId, type GuideMode, type PaperId } from './format';
import { planSheet } from './layout';
import { PdfBuilder } from './pdf';
import { encodePng } from './png';
import { fitFrameToCell, renderPage } from './render';
import type { RasterImage } from './raster';

export interface PrintParams {
  paper: PaperId;
  orientation: 'portrait' | 'landscape';
  dpi: number;
  columns: number;
  rows: number;
  frameWidthMm: number;
  marginMm: number;
  gutterMm: number;
  guide: GuideMode;
  guideOpacity: number;
  output: 'pdf' | 'png' | 'both';
  step: number;
}

export function readPrintParams(p: Record<string, unknown>): PrintParams {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  return {
    paper: oneOf(p.printPaper, ['a4', 'a3', 'letter', 'a5', 'legal'] as const, 'a4'),
    orientation: oneOf(p.printOrientation, ['portrait', 'landscape'] as const, 'portrait'),
    dpi: Math.min(600, Math.max(72, Math.round(num(p.printDpi, 300)))),
    columns: Math.max(0, Math.round(num(p.printColumns, 3))),
    rows: Math.max(0, Math.round(num(p.printRows, 4))),
    frameWidthMm: Math.max(8, num(p.printFrameWidth, 50)),
    marginMm: Math.max(5, num(p.printMargin, 10)),
    gutterMm: Math.max(3, num(p.printGutter, 5)),
    guide: oneOf(p.printGuide, ['full', 'faded', 'outline', 'blank'] as const, 'full'),
    guideOpacity: Math.min(100, Math.max(5, Math.round(num(p.printGuideOpacity, 35)))),
    output: oneOf(p.printOutput, ['pdf', 'png', 'both'] as const, 'pdf'),
    step: Math.max(1, Math.round(num(p.step, 1))),
  };
}

export interface PrintExportRequest {
  params: PrintParams;
  /** Used for the file names and the caption. */
  title: string;
  /** Project frame count and rate (before `step`). */
  frames: number;
  fps: number;
  /** Render frame `index` (0-based project frame) as straight RGBA. */
  renderFrame(index: number): Promise<RasterImage>;
  progress(fraction: number, label: string): void;
  /** Make a file name unique within the export. */
  claim(name: string): string;
  yieldNow(): Promise<void>;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

export async function exportPrint(req: PrintExportRequest): Promise<ExportedFile[]> {
  const p = req.params;
  const picks: number[] = [];
  for (let f = 0; f < req.frames; f += p.step) picks.push(f);
  const first = await req.renderFrame(picks[0]);
  const sheet = planSheet(
    {
      paper: p.paper,
      orientation: p.orientation,
      dpi: p.dpi,
      marginMm: p.marginMm,
      gutterMm: p.gutterMm,
      columns: p.columns,
      rows: p.rows,
      frameWidthMm: p.frameWidthMm,
      guide: p.guide,
      guideOpacity: p.guideOpacity,
      name: req.title,
    },
    { width: first.width, height: first.height, count: picks.length, fps: req.fps / p.step },
  );
  const cells: RasterImage[] = [];
  for (let k = 0; k < picks.length; k++) {
    throwIfAborted(req.signal);
    const img = k === 0 ? first : await req.renderFrame(picks[k]);
    cells.push(fitFrameToCell(img, sheet));
    req.progress(((k + 1) / picks.length) * 0.6, `Frame ${k + 1}/${picks.length}`);
    await req.yieldNow();
  }
  const files: ExportedFile[] = [];
  const pdf = p.output !== 'png' ? new PdfBuilder(req.title) : null;
  const pngs: { name: string; data: Uint8Array }[] = [];
  const g = sheet.geometry;
  for (let page = 0; page < sheet.pageCount; page++) {
    throwIfAborted(req.signal);
    const bmp = renderPage(sheet, page, (i) => cells[i]);
    pdf?.addImagePage(bmp, g.pageWidthMm, g.pageHeightMm);
    if (p.output !== 'pdf') pngs.push({ name: `${req.title}_page_${String(page + 1).padStart(2, '0')}.png`, data: encodePng(bmp, { dpi: sheet.dpi, opaque: true, level: 3 }) });
    req.progress(0.6 + ((page + 1) / sheet.pageCount) * 0.4, `Page ${page + 1}/${sheet.pageCount}`);
    await req.yieldNow();
  }
  if (pdf) files.push({ name: req.claim(`${req.title}.pdf`), blob: new Blob([pdf.finish() as BlobPart], { type: 'application/pdf' }) });
  for (const png of pngs) files.push({ name: req.claim(png.name), blob: new Blob([png.data as BlobPart], { type: 'image/png' }) });
  req.progress(1, `${req.title} (id ${formatProjectId(sheet.projectId).slice(0, 6)})`);
  return files;
}
