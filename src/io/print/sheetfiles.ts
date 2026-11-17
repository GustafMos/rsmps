/**
 * Turns planned sheets (or any list of page bitmaps) into PDF / PNG files. Shared by the Output node's print kind,
 * the blank-sheets dialog and the CLI. One page buffer is reused for the whole set and the work yields between pages,
 * so a long set never blocks the UI for more than one page at a time.
 */
import type { ExportedFile } from '../api';
import { PdfBuilder } from './pdf';
import { encodePng } from './png';
import type { SheetLayout } from './layout';
import { renderPage, type PrintFrame } from './render';
import type { RasterImage } from './raster';

export type PrintOutput = 'pdf' | 'png' | 'both';

export interface FileOptions {
  /** File name stem (also the PDF title). */
  title: string;
  output: PrintOutput;
  claim?(name: string): string;
  progress?(fraction: number, label: string): void;
  yieldNow?(): Promise<void>;
  signal?: AbortSignal;
  /** Appended after the sheets: already rendered pages with their physical size (exposure sheet...). */
  extraPages?: { bitmap: RasterImage; widthMm: number; heightMm: number; label?: string }[];
  /** Fraction of the progress bar already used before this call, and how much of it this call may use. */
  progressFrom?: number;
  progressSpan?: number;
  /** File name suffix, e.g. `_layer2`, put before `_page_NN` / `.pdf`. */
  suffix?: string;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
}

const noYield = () => Promise.resolve();

/**
 * Build the PDF and/or PNG pages for a planned sheet. `getFrame(i)` is only called for frames on the page being rendered.
 * Pass `builder` to add the pages to an existing PDF (several paper layers in one file); the caller then finishes it.
 */
export async function writeSheetFiles(
  sheet: SheetLayout,
  getFrame: (index: number) => PrintFrame,
  o: FileOptions,
  builder?: PdfBuilder,
): Promise<{ files: ExportedFile[]; pdf: PdfBuilder | null }> {
  const claim = o.claim ?? ((n: string) => n);
  const suffix = o.suffix ?? '';
  const pdf = o.output !== 'png' ? (builder ?? new PdfBuilder(o.title)) : null;
  const pngs: { name: string; data: Uint8Array }[] = [];
  const g = sheet.geometry;
  const total = sheet.pageCount + (o.extraPages?.length ?? 0);
  const from = o.progressFrom ?? 0;
  const span = o.progressSpan ?? 1;
  const yieldNow = o.yieldNow ?? noYield;
  let buffer: RasterImage | undefined;
  for (let page = 0; page < sheet.pageCount; page++) {
    throwIfAborted(o.signal);
    const bmp = renderPage(sheet, page, getFrame, buffer);
    buffer = bmp;
    pdf?.addImagePage(bmp, g.pageWidthMm, g.pageHeightMm);
    if (o.output !== 'pdf') pngs.push({ name: `${o.title}${suffix}_page_${String(page + 1).padStart(2, '0')}.png`, data: encodePng(bmp, { dpi: sheet.dpi, opaque: true, level: 3 }) });
    o.progress?.(from + span * ((page + 1) / total), `Page ${page + 1}/${sheet.pageCount}`);
    await yieldNow();
  }
  let extra = 0;
  for (const e of o.extraPages ?? []) {
    throwIfAborted(o.signal);
    extra++;
    pdf?.addImagePage(e.bitmap, e.widthMm, e.heightMm);
    if (o.output !== 'pdf') pngs.push({ name: `${o.title}${suffix}_${e.label ?? 'extra'}_${String(extra).padStart(2, '0')}.png`, data: encodePng(e.bitmap, { dpi: sheet.dpi, opaque: true, level: 3 }) });
    o.progress?.(from + span * ((sheet.pageCount + extra) / total), e.label ?? 'Extra page');
    await yieldNow();
  }
  const files: ExportedFile[] = [];
  if (pdf && !builder) files.push({ name: claim(`${o.title}${suffix}.pdf`), blob: new Blob([pdf.finish() as BlobPart], { type: 'application/pdf' }) });
  for (const png of pngs) files.push({ name: claim(png.name), blob: new Blob([png.data as BlobPart], { type: 'image/png' }) });
  return { files, pdf };
}

/** Pages that are already bitmaps (flipbook, zine, plates) to files. */
export async function writePageFiles(pages: { bitmap: RasterImage; widthMm: number; heightMm: number }[], dpi: number, o: FileOptions): Promise<ExportedFile[]> {
  const claim = o.claim ?? ((n: string) => n);
  const yieldNow = o.yieldNow ?? noYield;
  const pdf = o.output !== 'png' ? new PdfBuilder(o.title) : null;
  const files: ExportedFile[] = [];
  const from = o.progressFrom ?? 0;
  const span = o.progressSpan ?? 1;
  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(o.signal);
    const p = pages[i];
    pdf?.addImagePage(p.bitmap, p.widthMm, p.heightMm);
    if (o.output !== 'pdf') files.push({ name: claim(`${o.title}${o.suffix ?? ''}_page_${String(i + 1).padStart(2, '0')}.png`), blob: new Blob([encodePng(p.bitmap, { dpi, opaque: true, level: 3 }) as BlobPart], { type: 'image/png' }) });
    o.progress?.(from + span * ((i + 1) / pages.length), `Page ${i + 1}/${pages.length}`);
    await yieldNow();
  }
  if (pdf) files.unshift({ name: claim(`${o.title}${o.suffix ?? ''}.pdf`), blob: new Blob([pdf.finish() as BlobPart], { type: 'application/pdf' }) });
  return files;
}
