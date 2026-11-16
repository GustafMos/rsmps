/**
 * Blank sheets for animation drawn entirely on paper: frame boxes, the usual scan markers and data strip, frame numbers,
 * optional drawing guides. No picture. Also the onion-skin "next round" sheets (the previous drawing faint inside the next
 * frame's box). Pure and GPU-free, so the dialog, the CLI and tests all call the same code.
 */
import type { ExportedFile } from '../api';
import { renderExposureSheet } from './exposure';
import { PAPER_MM, type GuideMode, type PaperId } from './format';
import { drawingAt, resolveHolds } from './holds';
import { planSheet, type FrameGuide, type SheetDecor, type SheetLayout } from './layout';
import { createRaster, type RasterImage } from './raster';
import { throwIfAborted, writeSheetFiles, type PrintOutput } from './sheetfiles';

export const ASPECT_PRESETS: Record<string, [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '4:5': [4, 5],
  '5:4': [5, 4],
  '2:3': [2, 3],
  '3:2': [3, 2],
  '21:9': [21, 9],
};

export type AspectSpec = string | { width: number; height: number };

/** "16:9", "1.78", "project" (needs `project`) or an explicit pair, to a width / height pair. */
export function resolveAspect(spec: AspectSpec | undefined, project?: { width: number; height: number }): { width: number; height: number } {
  if (spec && typeof spec === 'object') {
    if (!(spec.width > 0 && spec.height > 0)) throw new Error('Frame aspect needs a positive width and height.');
    return spec;
  }
  const s = (spec ?? 'project').trim().toLowerCase();
  if (s === 'project') {
    if (project && project.width > 0 && project.height > 0) return project;
    return { width: 16, height: 9 };
  }
  if (ASPECT_PRESETS[s]) return { width: ASPECT_PRESETS[s][0], height: ASPECT_PRESETS[s][1] };
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m && +m[1] > 0 && +m[2] > 0) return { width: +m[1], height: +m[2] };
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return { width: Math.round(n * 1000), height: 1000 };
  throw new Error(`Unknown frame aspect "${spec}". Use project, a preset like 16:9, W:H or a number.`);
}

export interface BlankSheetOptions {
  /** Frame count, or `seconds` x `fps`. */
  frames?: number;
  seconds?: number;
  fps?: number;
  aspect?: AspectSpec;
  /** Used when `aspect` is "project". */
  project?: { width: number; height: number };
  /** Frames per sheet (the grid is chosen to make the frames as large as possible). Ignored when columns and rows are given. */
  perSheet?: number;
  columns?: number;
  rows?: number;
  paper?: PaperId;
  orientation?: 'portrait' | 'landscape';
  marginMm?: number;
  gutterMm?: number;
  dpi?: number;
  guides?: FrameGuide[];
  /** Faint big frame numbers inside the boxes (onion-skin placeholder numbering). */
  ghostNumbers?: boolean;
  /** Frame numbers above the boxes (default true) and frame boxes (default true). */
  numbers?: boolean;
  boxes?: boolean;
  /** Time code, hold counts and beat dots next to the frame numbers (default true when `holds`, `shootOn` or `beats` are given). */
  timing?: boolean;
  shootOn?: number;
  holds?: (number | null | undefined)[];
  /** Beat frames (timeline frames, 0-based), e.g. from `beatFrames(detectBeats(...), fps)`. */
  beats?: number[];
  /** Also print an exposure sheet page after the frame sheets. */
  exposureSheet?: boolean;
  name?: string;
  output?: PrintOutput;
  /** Size the scan cuts the frames to, in pixels per printed millimetre (default 8, about 200 dpi). The strip records it as the frame size. */
  pxPerMm?: number;
  /** Continue an animation: first frame number (0-based) and round number. Used by `exportNextRound`. */
  frameOffset?: number;
  round?: number;
  projectId?: number;
}

export interface BlankPlan {
  sheet: SheetLayout;
  frames: number;
  columns: number;
  rows: number;
  perSheet: number;
  pages: number;
}

export function resolveFrameCount(o: { frames?: number; seconds?: number; fps?: number }): number {
  const fps = o.fps && o.fps > 0 ? o.fps : 12;
  const n = o.frames && o.frames > 0 ? o.frames : o.seconds && o.seconds > 0 ? Math.round(o.seconds * fps) : 0;
  if (!(n >= 1)) throw new Error('Give a frame count, or seconds and a frame rate.');
  if (n > 60000) throw new Error('That is more than 60000 frames. Print fewer frames.');
  return Math.round(n);
}

function holdsOf(frames: number, o: { shootOn?: number; holds?: (number | null | undefined)[] }): number[] {
  return resolveHolds(frames, { shootOn: o.shootOn, holds: o.holds });
}

/** Choose columns x rows holding at least `perSheet` frames with the largest possible frames. */
export function gridForFramesPerSheet(o: BlankSheetOptions, aspect: { width: number; height: number }, perSheet: number): { columns: number; rows: number } {
  let best = { columns: 1, rows: 1, score: -1, waste: 0 };
  const want = Math.max(1, Math.min(63 * 63, Math.round(perSheet)));
  for (let cols = 1; cols <= Math.min(want, 63); cols++) {
    const rows = Math.ceil(want / cols);
    if (rows > 63) continue;
    try {
      const s = planSheet({ paper: o.paper, orientation: o.orientation, marginMm: o.marginMm, gutterMm: o.gutterMm, columns: cols, rows, dpi: 72 }, { width: aspect.width, height: aspect.height, count: want, fps: 12 });
      const waste = cols * rows - want;
      const score = s.geometry.cellWMm;
      if (score > best.score + 1e-6 || (Math.abs(score - best.score) < 1e-6 && waste < best.waste)) best = { columns: cols, rows, score, waste };
    } catch {
      /* does not fit */
    }
  }
  if (best.score < 0) throw new Error('No grid of that many frames fits on this paper. Use fewer frames per sheet or larger paper.');
  return { columns: best.columns, rows: best.rows };
}

export function planBlankSheets(o: BlankSheetOptions): BlankPlan {
  const fps = o.fps && o.fps > 0 ? o.fps : 12;
  const frames = resolveFrameCount({ frames: o.frames, seconds: o.seconds, fps });
  const aspect = resolveAspect(o.aspect, o.project);
  let columns = o.columns ?? 0;
  let rows = o.rows ?? 0;
  if (!(columns > 0 && rows > 0) && o.perSheet && o.perSheet > 0) ({ columns, rows } = gridForFramesPerSheet(o, aspect, o.perSheet));
  const holds = holdsOf(frames + (o.frameOffset ?? 0), o);
  const hasTiming = o.timing ?? (o.shootOn !== undefined || !!o.holds || !!o.beats?.length);
  const decor: SheetDecor = {
    boxes: o.boxes ?? true,
    numbers: o.numbers ?? true,
    ghostNumbers: !!o.ghostNumbers,
    guides: o.guides ?? [],
    timing: hasTiming ? { holds: holds, beats: o.beats ? [...new Set(o.beats.map((t) => drawingAt(holds, t)))] : undefined } : undefined,
  };
  const planned = planSheet(
    {
      paper: o.paper,
      orientation: o.orientation,
      dpi: o.dpi,
      marginMm: o.marginMm,
      gutterMm: o.gutterMm,
      columns,
      rows,
      guide: 'blank' as GuideMode,
      name: o.name ?? 'Blank sheets',
      frameOffset: o.frameOffset,
      round: o.round,
      projectId: o.projectId,
      decor,
    },
    { width: Math.round(aspect.width * 1000), height: Math.round(aspect.height * 1000), count: frames, fps },
  );
  // a blank sheet has no picture, so the frame size the scan cuts to comes from the printed size, not from the aspect numbers
  const ppm = Math.min(24, Math.max(2, o.pxPerMm ?? 8));
  const sheet: SheetLayout = { ...planned, frameWidthPx: Math.min(16383, Math.max(16, Math.round(planned.geometry.cellWMm * ppm))), frameHeightPx: Math.min(16383, Math.max(16, Math.round(planned.geometry.cellHMm * ppm))) };
  return { sheet, frames, columns: sheet.geometry.columns, rows: sheet.geometry.rows, perSheet: sheet.perPage, pages: sheet.pageCount };
}

export interface BlankRunOptions {
  claim?(name: string): string;
  progress?(fraction: number, label: string): void;
  yieldNow?(): Promise<void>;
  signal?: AbortSignal;
}

const emptyFrame: RasterImage = createRaster(1, 1);

function safeName(s: string): string {
  return (s.trim() || 'blank-sheets').replace(/[\\/:*?"<>|]+/g, '_');
}

/** The sheets as PDF and/or PNG pages (plus an exposure sheet when asked). */
export async function exportBlankSheets(o: BlankSheetOptions, run: BlankRunOptions = {}): Promise<ExportedFile[]> {
  throwIfAborted(run.signal);
  const plan = planBlankSheets(o);
  const title = safeName(o.name ?? 'blank-sheets');
  const fps = plan.sheet.fpsX100 / 100;
  const extra: { bitmap: RasterImage; widthMm: number; heightMm: number; label: string }[] = [];
  if (o.exposureSheet) {
    const holds = holdsOf(plan.frames, o);
    const ex = renderExposureSheet({ title: o.name ?? 'Blank sheets', fps, holds, beats: o.beats, beatsFromAudio: !!o.beats?.length, firstDrawing: (o.frameOffset ?? 0) + 1, paper: o.paper, dpi: Math.min(plan.sheet.dpi, 200) });
    ex.pages.forEach((bitmap) => extra.push({ bitmap, widthMm: ex.widthMm, heightMm: ex.heightMm, label: 'exposure' }));
  }
  const { files } = await writeSheetFiles(plan.sheet, () => emptyFrame, { title, output: o.output ?? 'pdf', claim: run.claim, progress: run.progress, yieldNow: run.yieldNow, signal: run.signal, extraPages: extra });
  return files;
}

export interface NextRoundOptions extends BlankSheetOptions {
  /** The scanned drawings so far, in order (null = missing). The next round starts after the last one. */
  previous: (RasterImage | null)[];
  /** How to show the previous drawing inside the next box. */
  onion?: 'faint' | 'blue';
  /** Percent of ink kept (default 30). */
  onionStrength?: number;
  /** The project id of the scan project's sheets (so the new pages join the same project) and the round just scanned. */
  projectId: number;
  /**
   * 'append' (default): new frames continue after the last drawing; only the first box can show a previous drawing (the one
   * before it). 'replace': the boxes cover frames 0.. again and each shows its own earlier drawing, for inking over pencil.
   */
  mode?: 'append' | 'replace';
}

/**
 * "Print next round": blank boxes for `frames` new frames that continue the animation, each with the previous drawing faint
 * (or non-photo blue) inside it. Scanning them adds the frames to the same scan project (same project id, round + 1).
 */
export async function exportNextRound(o: NextRoundOptions, run: BlankRunOptions = {}): Promise<ExportedFile[]> {
  const replace = o.mode === 'replace';
  const offset = replace ? 0 : o.previous.length;
  const last = [...o.previous].reverse().find((f) => f);
  const aspect = o.aspect ?? (last ? { width: last.width, height: last.height } : undefined);
  const frames = replace ? (o.frames ?? o.previous.length) : o.frames;
  const plan = planBlankSheets({ ...o, frames: frames ?? o.frames, seconds: frames ? undefined : o.seconds, frameOffset: offset, round: (o.round ?? 0) + 1, aspect });
  const sheet: SheetLayout = { ...plan.sheet, guide: 'faded', guideOpacity: Math.max(5, Math.min(100, Math.round(o.onionStrength ?? 30))), blueGuide: o.onion === 'blue' };
  const getFrame = (local: number): RasterImage => {
    // append: the new frame (offset + local) sits over the drawing before it; replace: over its own earlier drawing
    const idx = replace ? local : offset + local - 1;
    return o.previous[idx] ?? emptyFrame;
  };
  const title = safeName(o.name ?? 'next-round');
  const { files } = await writeSheetFiles(sheet, getFrame, { title: `${title}_round${sheet.round + 1}`, output: o.output ?? 'pdf', claim: run.claim, progress: run.progress, yieldNow: run.yieldNow, signal: run.signal });
  return files;
}

/** Paper size label used in messages. */
export function paperLabel(p: PaperId): string {
  return `${p.toUpperCase()} (${PAPER_MM[p][0]} x ${PAPER_MM[p][1]} mm)`;
}
