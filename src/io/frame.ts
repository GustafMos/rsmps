/**
 * Output frame maths (pure, shared by the player, exporter, UI and CLI).
 * An Output node may choose its own frame (aspect ratio, size, orientation) instead of the project canvas.
 */

export const FRAME_PRESETS = ['project', '16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '2:3', '21:9', 'custom'] as const;
export type FramePreset = (typeof FRAME_PRESETS)[number];
export type Orientation = 'as-is' | 'landscape' | 'portrait';
export type ConformMode = 'auto' | 'none' | 'fill' | 'fit' | 'stretch';
export type ConformAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface FrameParams {
  frame: FramePreset;
  orientation: Orientation;
  frameWidth: number;
  frameHeight: number;
  conform: ConformMode;
  conformAnchor: ConformAnchor;
  /** Render on a grid this many times coarser, then enlarge with hard pixels (1 = off). */
  pixelSize: number;
  /** Sequences and spritesheets: deliver the small art-resolution frames, no enlargement. */
  exportArtSize: boolean;
}

export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_SIDE = 16384;
/** The engine clamps the playback proxy at 0.05, so a coarser grid than 1/20 cannot be rendered exactly. */
export const MAX_PIXEL_SIZE = 20;
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);

/** Read the Frame group of an `image-out` node's params, with defaults. */
export function readFrameParams(params: Record<string, unknown>): FrameParams {
  return {
    frame: pick(params.frame, FRAME_PRESETS, 'project'),
    orientation: pick(params.orientation, ['as-is', 'landscape', 'portrait'] as const, 'as-is'),
    frameWidth: Math.min(MAX_SIDE, Math.max(1, int(params.frameWidth, 1920))),
    frameHeight: Math.min(MAX_SIDE, Math.max(1, int(params.frameHeight, 1080))),
    conform: pick(params.conform, ['auto', 'none', 'fill', 'fit', 'stretch'] as const, 'auto'),
    conformAnchor: pick(params.conformAnchor, ['center', 'top', 'bottom', 'left', 'right'] as const, 'center'),
    pixelSize: Math.min(MAX_PIXEL_SIZE, Math.max(1, int(params.pixelSize, 1))),
    exportArtSize: params.exportArtSize === true,
  };
}

const even = (n: number) => Math.min(MAX_SIDE, Math.max(2, Math.round(n / 2) * 2));

/**
 * Frame size in full-resolution texels. Ratio presets keep the project's SHORT side (so unit-relative lengths
 * and pixel-art scale stay identical) and are rounded to even numbers; 'custom' is literal; 'project' is the
 * project canvas. `orientation` then swaps width/height if they disagree with the choice.
 */
export function resolveFrame(project: Size, p: FrameParams): Size {
  let w = project.width;
  let h = project.height;
  if (p.frame === 'custom') {
    w = p.frameWidth;
    h = p.frameHeight;
  } else if (p.frame !== 'project') {
    const [a, b] = p.frame.split(':').map(Number);
    const r = a / b;
    const short = Math.min(project.width, project.height);
    if (r >= 1) {
      h = short;
      w = short * r;
    } else {
      w = short;
      h = short / r;
    }
    w = even(w);
    h = even(h);
  }
  if ((p.orientation === 'landscape' && w < h) || (p.orientation === 'portrait' && h < w)) [w, h] = [h, w];
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const k = p.pixelSize;
  if (k > 1) {
    // The frame must be a whole number of art pixels in both directions.
    w = Math.max(k, Math.round(w / k) * k);
    h = Math.max(k, Math.round(h / k) * k);
  }
  return { width: w, height: h };
}

/**
 * Pixel size plan: the whole graph is evaluated at proxy 1/k (so the art grid is frame/k) and the result is
 * enlarged k times with nearest-neighbour to the full frame. `frame` must come from resolveFrame (a multiple of k).
 */
export function pixelPlan(frame: Size, pixelSize: number): { proxy: number; art: Size; final: Size } {
  const k = Math.max(1, Math.round(pixelSize));
  return { proxy: 1 / k, art: { width: Math.max(1, Math.round(frame.width / k)), height: Math.max(1, Math.round(frame.height / k)) }, final: frame };
}

/** True when the frame differs from the project canvas, i.e. the engine needs an explicit canvas. */
export function isCustomFrame(project: Size, frame: Size): boolean {
  return frame.width !== project.width || frame.height !== project.height;
}

/** 'auto' means: export what arrives when the frame is the project canvas as-is, otherwise fill the frame. */
export function effectiveConform(p: FrameParams): Exclude<ConformMode, 'auto'> {
  if (p.conform !== 'auto') return p.conform;
  return p.frame === 'project' && p.orientation === 'as-is' ? 'none' : 'fill';
}

/**
 * Where the source lands in the destination frame (destination texels; may extend past the frame for 'fill',
 * which crops). Returns null when nothing needs to be done (mode 'none', or already the right size).
 */
export function conformRect(src: Size, dst: Size, mode: Exclude<ConformMode, 'auto'>, anchor: ConformAnchor = 'center'): Rect | null {
  if (mode === 'none') return null;
  if (src.width === dst.width && src.height === dst.height) return null;
  if (mode === 'stretch') return { x: 0, y: 0, w: dst.width, h: dst.height };
  const sx = dst.width / src.width;
  const sy = dst.height / src.height;
  const s = mode === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = src.width * s;
  const h = src.height * s;
  let x = (dst.width - w) / 2;
  let y = (dst.height - h) / 2;
  if (mode === 'fill') {
    if (anchor === 'top') y = 0;
    else if (anchor === 'bottom') y = dst.height - h;
    else if (anchor === 'left') x = 0;
    else if (anchor === 'right') x = dst.width - w;
  }
  return { x, y, w, h };
}

/** The same frame at a playback proxy (what the engine renders at). */
export function scaleSize(size: Size, proxy: number): Size {
  return { width: Math.max(1, Math.round(size.width * proxy)), height: Math.max(1, Math.round(size.height * proxy)) };
}
