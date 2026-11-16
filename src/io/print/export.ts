/**
 * The 'print' export kind, free of GPU and browser APIs: it pulls frames through a callback, lays out the
 * sheets and returns PDF and/or PNG files (or plates / SVG plots). The exporter supplies `renderFrame`.
 */
import type { ExportedFile } from '../api';
import { formatProjectId, type GuideMode, type PaperId } from './format';
import { renderFlipbook, renderZine } from './imposition';
import { planSheet, type SheetDecor, type SheetLayout } from './layout';
import { planPlot, plotToSvg } from './plot';
import { renderPlates } from './separations';
import { throwIfAborted, writePageFiles, writeSheetFiles, type PrintOutput } from './sheetfiles';
import { fitFrameToCell } from './render';
import { resizeRaster, type RasterImage } from './raster';

export type PrintStyle = 'full' | 'faint' | 'outline' | 'blue';
export type PrintLayout = 'grid' | 'flipbook' | 'zine';
export type PrintKind = 'sheets' | 'separations' | 'svg-plot';

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
  output: PrintOutput;
  step: number;
  /** Rotoscope style of the printed picture (`full` = use `guide` as before). */
  style: PrintStyle;
  /** Percent of the picture's darkness kept by `faint` and `blue`. */
  styleStrength: number;
  outlineInk: 'grey' | 'blue';
  /** Frame boxes + numbers on picture sheets too (blank sheets always have them). */
  frameNumbers: boolean;
  /** Paper layers: one sheet set per layer, same frame boxes. */
  layers: number;
  /** Which layer sets carry the picture. */
  layerGuide: 'first' | 'all';
  layout: PrintLayout;
  binding: 'left' | 'right' | 'top';
  bindingMm: number;
  thumbIndex: boolean;
  duplex: boolean;
  kind: PrintKind;
  inks: number;
  hatch: boolean;
  hatchMm: number;
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
    style: oneOf(p.printStyle, ['full', 'faint', 'outline', 'blue'] as const, 'full'),
    styleStrength: Math.min(100, Math.max(5, Math.round(num(p.printStyleStrength, 30)))),
    outlineInk: oneOf(p.printOutlineInk, ['grey', 'blue'] as const, 'grey'),
    frameNumbers: p.printFrameNumbers === true,
    layers: Math.min(8, Math.max(1, Math.round(num(p.printLayers, 1)))),
    layerGuide: oneOf(p.printLayerGuide, ['first', 'all'] as const, 'first'),
    layout: oneOf(p.printLayout, ['grid', 'flipbook', 'zine'] as const, 'grid'),
    binding: oneOf(p.printBinding, ['left', 'right', 'top'] as const, 'left'),
    bindingMm: Math.max(4, num(p.printBindingMm, 10)),
    thumbIndex: p.printThumbIndex === true,
    duplex: p.printDuplex === true,
    kind: oneOf(p.printKind, ['sheets', 'separations', 'svg-plot'] as const, 'sheets'),
    inks: Math.min(8, Math.max(1, Math.round(num(p.printInks, 3)))),
    hatch: p.printHatch === true,
    hatchMm: Math.min(5, Math.max(0.3, num(p.printHatchMm, 1))),
  };
}

/** The guide mode, opacity and blue flag the strip records for a rotoscope style. */
export function styleGuide(p: PrintParams): { guide: GuideMode; opacity: number; blue: boolean } {
  switch (p.style) {
    case 'faint':
      return { guide: 'faded', opacity: p.styleStrength, blue: false };
    case 'blue':
      return { guide: 'faded', opacity: p.styleStrength, blue: true };
    case 'outline':
      return { guide: 'outline', opacity: 100, blue: p.outlineInk === 'blue' };
    default:
      return { guide: p.guide, opacity: p.guideOpacity, blue: false };
  }
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

export async function exportPrint(req: PrintExportRequest): Promise<ExportedFile[]> {
  const p = req.params;
  const picks: number[] = [];
  for (let f = 0; f < req.frames; f += p.step) picks.push(f);
  if (p.kind === 'separations') return exportSeparations(req, picks);
  if (p.kind === 'svg-plot') return exportPlots(req, picks);
  if (p.layout !== 'grid') return exportImposed(req, picks);
  return exportSheets(req, picks);
}

/** Frames pulled once, at a cell-sized resolution so memory stays bounded. */
async function pullFrames(req: PrintExportRequest, picks: number[], fit: (img: RasterImage) => RasterImage, share: number, first?: RasterImage): Promise<RasterImage[]> {
  const out: RasterImage[] = [];
  for (let k = 0; k < picks.length; k++) {
    throwIfAborted(req.signal);
    out.push(fit(k === 0 && first ? first : await req.renderFrame(picks[k])));
    req.progress(((k + 1) / picks.length) * share, `Frame ${k + 1}/${picks.length}`);
    await req.yieldNow();
  }
  return out;
}

async function exportSheets(req: PrintExportRequest, picks: number[]): Promise<ExportedFile[]> {
  const p = req.params;
  const first = await req.renderFrame(picks[0]);
  const st = styleGuide(p);
  const decor: SheetDecor = p.frameNumbers ? { boxes: true, numbers: true } : {};
  const plan = (layer: number, guide: GuideMode, projectId?: number): SheetLayout =>
    planSheet(
      {
        paper: p.paper,
        orientation: p.orientation,
        dpi: p.dpi,
        marginMm: p.marginMm,
        gutterMm: p.gutterMm,
        columns: p.columns,
        rows: p.rows,
        frameWidthMm: p.frameWidthMm,
        guide,
        guideOpacity: st.opacity,
        name: req.title,
        layer,
        layerCount: p.layers,
        blueGuide: guide === 'blank' ? false : st.blue,
        decor: guide === 'blank' && p.layers > 1 ? { boxes: true, numbers: true, ...decor } : decor,
        projectId,
      },
      { width: first.width, height: first.height, count: picks.length, fps: req.fps / p.step },
    );
  const main = plan(0, st.guide);
  const cells = await pullFrames(req, picks, (img) => fitFrameToCell(img, main), 0.6, first);
  const files: ExportedFile[] = [];
  const share = 0.4 / p.layers;
  for (let layer = 0; layer < p.layers; layer++) {
    const withPicture = layer === 0 || p.layerGuide === 'all';
    const sheet = layer === 0 ? main : plan(layer, withPicture ? st.guide : 'blank', main.projectId);
    const suffix = p.layers > 1 ? `_layer${layer + 1}` : '';
    const r = await writeSheetFiles(sheet, (i) => cells[i], { title: req.title, output: p.output, claim: req.claim, progress: req.progress, yieldNow: req.yieldNow, signal: req.signal, suffix, progressFrom: 0.6 + share * layer, progressSpan: share });
    files.push(...r.files);
  }
  req.progress(1, `${req.title} (id ${formatProjectId(main.projectId).slice(0, 6)})`);
  return files;
}

async function exportImposed(req: PrintExportRequest, picks: number[]): Promise<ExportedFile[]> {
  const p = req.params;
  const first = await req.renderFrame(picks[0]);
  // pictures at the size they will print: no point keeping more than the dpi resolves
  const targetW = Math.min(first.width, Math.round((p.layout === 'zine' ? 70 : Math.max(p.frameWidthMm, 20)) * (p.dpi / 25.4)));
  const fit = (img: RasterImage) => (img.width <= targetW ? img : resizeRaster(img, targetW, Math.max(1, Math.round((img.height * targetW) / img.width)), 'auto'));
  const frames = await pullFrames(req, picks, fit, 0.5, first);
  throwIfAborted(req.signal);
  let pages;
  if (p.layout === 'zine') pages = renderZine(frames, { paper: p.paper, dpi: p.dpi, title: req.title }).pages;
  else pages = renderFlipbook(frames, { paper: p.paper, orientation: p.orientation, dpi: p.dpi, frameWidthMm: p.frameWidthMm, marginMm: p.marginMm, bindingMm: p.bindingMm, binding: p.binding, thumbIndex: p.thumbIndex, duplex: p.duplex, title: req.title }).pages;
  req.progress(0.6, `${pages.length} page${pages.length === 1 ? '' : 's'}`);
  const files = await writePageFiles(pages, p.dpi, { title: `${req.title}_${p.layout}`, output: p.output, claim: req.claim, progress: req.progress, yieldNow: req.yieldNow, signal: req.signal, progressFrom: 0.6, progressSpan: 0.4 });
  req.progress(1, req.title);
  return files;
}

async function exportSeparations(req: PrintExportRequest, picks: number[]): Promise<ExportedFile[]> {
  const p = req.params;
  const frames = await pullFrames(req, picks, (img) => img, 0.5);
  const { palette, plates } = renderPlates(frames, { inks: p.inks, paper: p.paper, orientation: p.orientation, dpi: p.dpi, title: req.title });
  const files: ExportedFile[] = [];
  let n = 0;
  for (const plate of plates) {
    n++;
    const slug = `${plate.ink.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const got = await writePageFiles(plate.pages, p.dpi, { title: `${req.title}_ink${n}_${slug}`, output: p.output, claim: req.claim, signal: req.signal, yieldNow: req.yieldNow, progress: req.progress, progressFrom: 0.5 + (0.5 * (n - 1)) / plates.length, progressSpan: 0.5 / plates.length });
    files.push(...got);
  }
  req.progress(1, `${palette.inks.length} ink${palette.inks.length === 1 ? '' : 's'}${palette.exact ? '' : ' (k-means)'}`);
  return files;
}

async function exportPlots(req: PrintExportRequest, picks: number[]): Promise<ExportedFile[]> {
  const p = req.params;
  const frames = await pullFrames(req, picks, (img) => img, 0.4);
  const files: ExportedFile[] = [];
  for (let k = 0; k < frames.length; k++) {
    throwIfAborted(req.signal);
    const plot = planPlot(frames[k], { inks: p.inks > 1 ? p.inks : 1, paper: p.paper, orientation: p.orientation, marginMm: p.marginMm, hatch: p.hatch, hatchSpacingMm: p.hatchMm });
    const svg = plotToSvg(plot);
    files.push({ name: req.claim(`${req.title}_plot_${String(k + 1).padStart(frames.length > 99 ? 4 : 2, '0')}.svg`), blob: new Blob([svg], { type: 'image/svg+xml' }) });
    req.progress(0.4 + 0.6 * ((k + 1) / frames.length), `Plot ${k + 1}/${frames.length}`);
    await req.yieldNow();
  }
  return files;
}
