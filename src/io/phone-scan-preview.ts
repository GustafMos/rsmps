/**
 * The preview animation sent back to the phone: ONE sprite-sheet picture of up to 96 frames (decimated evenly when there are more),
 * each cell at most 480 px on its long side and the whole sheet within phone-friendly canvas limits, plus a small description
 * (`PreviewMeta`). Pure: the JPEG encoding of the sheet is done by the browser glue (`encodeSprite`).
 */
import { createRaster, resizeRaster, type RasterImage } from './print/raster';
import type { PreviewMeta } from '../phone/scan-protocol';

export const PREVIEW_MAX_FRAMES = 96;
export const PREVIEW_MAX_FRAME_SIDE = 480;
/** Phones decode a sprite sheet into a texture / canvas: stay under their dimension and area limits. */
export const PREVIEW_MAX_SHEET_SIDE = 4096;
export const PREVIEW_MAX_SHEET_PIXELS = 8_000_000;
export const PREVIEW_JPEG_QUALITY = 0.8;

export interface PreviewPlan {
  /** Frame numbers (0-based) in the sprite, in order. */
  indices: number[];
  step: number;
  count: number;
  cols: number;
  rows: number;
  fw: number;
  fh: number;
  /** Playback rate: the project's rate divided by the decimation step, so the loop lasts as long as the animation. */
  fps: number;
  total: number;
}

/** Evenly spaced frames: every `step`-th, at most `max` of them. */
export function decimate(total: number, max = PREVIEW_MAX_FRAMES): { indices: number[]; step: number } {
  if (total <= 0) return { indices: [], step: 1 };
  const step = Math.max(1, Math.ceil(total / max));
  const indices: number[] = [];
  for (let i = 0; i < total; i += step) indices.push(i);
  return { indices, step };
}

/** Where every frame goes and how big a cell is, for `total` frames of w x h pixels at `fps`. Throws when there is nothing to show. */
export function planPreview(total: number, w: number, h: number, fps: number, opts: { maxFrames?: number; maxFrameSide?: number } = {}): PreviewPlan {
  if (!(total > 0) || !(w > 0) || !(h > 0)) throw new Error('There are no frames to preview.');
  const { indices, step } = decimate(total, opts.maxFrames ?? PREVIEW_MAX_FRAMES);
  const count = indices.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  let k = Math.min(1, (opts.maxFrameSide ?? PREVIEW_MAX_FRAME_SIDE) / Math.max(w, h));
  k = Math.min(k, PREVIEW_MAX_SHEET_SIDE / (cols * w), PREVIEW_MAX_SHEET_SIDE / (rows * h), Math.sqrt(PREVIEW_MAX_SHEET_PIXELS / (cols * rows * w * h)));
  const fw = Math.max(2, Math.floor(w * k));
  const fh = Math.max(2, Math.floor(h * k));
  return { indices, step, count, cols, rows, fw, fh, fps: Math.max(0.5, Math.round((fps / step) * 100) / 100), total };
}

export interface PackedSprite {
  image: RasterImage;
  /** 1-based frame numbers (of the whole animation) that are missing. */
  missingFrames: number[];
}

/**
 * Draw the planned frames into one sheet. A missing frame shows the previous drawing (the first one the next), the way "repeat the
 * previous one" does when committing; transparent pixels are flattened onto white (the phone shows an opaque picture).
 */
export function packSprite(frames: readonly (RasterImage | null)[], plan: PreviewPlan): PackedSprite {
  const image = createRaster(plan.cols * plan.fw, plan.rows * plan.fh, [255, 255, 255, 255]);
  const missing: number[] = [];
  let prev: RasterImage | null = null;
  const firstPresent = plan.indices.map((i) => frames[i]).find((f) => !!f) ?? null;
  plan.indices.forEach((frameIndex, k) => {
    const src = frames[frameIndex] ?? null;
    if (!src) missing.push(frameIndex + 1);
    const use = src ?? prev ?? firstPresent;
    if (src) prev = src;
    if (!use) return;
    const cell = resizeRaster(use, plan.fw, plan.fh, 'area');
    const ox = (k % plan.cols) * plan.fw;
    const oy = Math.floor(k / plan.cols) * plan.fh;
    for (let y = 0; y < plan.fh; y++) {
      for (let x = 0; x < plan.fw; x++) {
        const s = (y * plan.fw + x) * 4;
        const d = ((oy + y) * image.width + ox + x) * 4;
        const a = cell.data[s + 3] / 255;
        image.data[d] = Math.round(cell.data[s] * a + 255 * (1 - a));
        image.data[d + 1] = Math.round(cell.data[s + 1] * a + 255 * (1 - a));
        image.data[d + 2] = Math.round(cell.data[s + 2] * a + 255 * (1 - a));
        image.data[d + 3] = 255;
      }
    }
  });
  return { image, missingFrames: missing };
}

/** The description that goes into `preview-begin`. `allMissingFrames` / `missingSheets` are 1-based, from the scan report. */
export function previewMeta(plan: PreviewPlan, allMissingFrames: readonly number[], missingSheets: readonly number[]): PreviewMeta {
  return {
    count: plan.count,
    cols: plan.cols,
    rows: plan.rows,
    fw: plan.fw,
    fh: plan.fh,
    fps: plan.fps,
    total: plan.total,
    step: plan.step,
    missingFrames: allMissingFrames.slice(0, 500),
    missingSheets: missingSheets.slice(0, 500),
  };
}
