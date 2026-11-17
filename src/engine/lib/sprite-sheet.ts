/**
 * Sprite sheet maths shared by the Sprite Sheet In node, the exporter (metadata writers live in `src/io/spritesheet-meta.ts`) and the tests.
 * Pure: no GPU, no DOM.
 *
 * A sheet is described by a list of FRAMES (rectangles of the sheet image) and optional animation TAGS. A frame may be trimmed: its rectangle
 * holds only the opaque part, `offX / offY` say where that part sits inside the original frame of size `srcW x srcH`.
 */

export interface SheetFrame {
  /** Position in the sheet's frame list. */
  index: number;
  name: string;
  /** Rectangle in the sheet image (texels, y down). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the rectangle sits inside the original (untrimmed) frame. */
  offX: number;
  offY: number;
  /** Original frame size before trimming. */
  srcW: number;
  srcH: number;
  /** Milliseconds; 0 = not stated. */
  durationMs: number;
  /** Pivot in the ORIGINAL frame, 0..1 (x right, y down). */
  pivot?: [number, number];
}

export interface SheetTag {
  name: string;
  from: number;
  to: number;
  direction: 'forward' | 'reverse' | 'pingpong';
}

export interface SheetDescription {
  image?: string;
  width?: number;
  height?: number;
  frames: SheetFrame[];
  tags: SheetTag[];
}

/* ----------------------------------------------------------------------------------------------- */
/* Metadata parsing                                                                                  */
/* ----------------------------------------------------------------------------------------------- */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function rectOf(v: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!isObj(v)) return null;
  return { x: num(v.x), y: num(v.y), w: num(v.w), h: num(v.h) };
}

function directionOf(v: unknown): SheetTag['direction'] {
  const s = String(v ?? 'forward').toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'reverse') return 'reverse';
  if (s === 'pingpong') return 'pingpong';
  return 'forward';
}

/**
 * Read the JSON that Aseprite ("Export Sprite Sheet", JSON array or hash), TexturePacker (JSON hash and JSON array) or this app's own
 * generic format writes next to a sheet. Throws a readable Error for anything else (and for rotated frames: re-export without rotation).
 *
 * Durations: Aseprite / TexturePacker write milliseconds in `duration`; the generic format writes seconds, recognised by its `x`/`y` frame keys.
 */
export function parseSheetJson(text: string): SheetDescription {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('The sprite sheet metadata is not valid JSON.');
  }
  if (!isObj(root) || !('frames' in root)) throw new Error('The sprite sheet metadata has no "frames" list. Expected the JSON of Aseprite, TexturePacker or this app.');
  const meta = isObj(root.meta) ? root.meta : {};
  const entries: { key: string; value: Json }[] = [];
  if (Array.isArray(root.frames)) root.frames.forEach((f, i) => isObj(f) && entries.push({ key: typeof f.filename === 'string' ? f.filename : String(i), value: f }));
  else if (isObj(root.frames)) for (const [k, v] of Object.entries(root.frames)) if (isObj(v)) entries.push({ key: k, value: v });
  if (!entries.length) throw new Error('The sprite sheet metadata lists no frames.');

  const frames: SheetFrame[] = entries.map(({ key, value }, index) => {
    const framed = rectOf(value.frame);
    if (framed) {
      if (value.rotated === true) throw new Error('This sheet uses rotated frames, which Sprite Sheet In does not read. Export it again without rotation.');
      const sss = rectOf(value.spriteSourceSize) ?? { x: 0, y: 0, w: framed.w, h: framed.h };
      const ss = isObj(value.sourceSize) ? { w: num(value.sourceSize.w, framed.w), h: num(value.sourceSize.h, framed.h) } : { w: framed.w, h: framed.h };
      const f: SheetFrame = { index, name: key, x: framed.x, y: framed.y, w: framed.w, h: framed.h, offX: sss.x, offY: sss.y, srcW: ss.w, srcH: ss.h, durationMs: num(value.duration, 0) };
      if (isObj(value.pivot)) f.pivot = [num(value.pivot.x, 0.5), num(value.pivot.y, 0.5)];
      return f;
    }
    // Generic format: x, y, w, h at the top of the frame object.
    const w = num(value.w);
    const h = num(value.h);
    const f: SheetFrame = {
      index,
      name: typeof value.name === 'string' ? value.name : key,
      x: num(value.x),
      y: num(value.y),
      w,
      h,
      offX: num(value.offsetX),
      offY: num(value.offsetY),
      srcW: num(value.sourceWidth, w),
      srcH: num(value.sourceHeight, h),
      durationMs: Math.round(num(value.duration) * 1000),
    };
    if (Array.isArray(value.pivot) && value.pivot.length >= 2) f.pivot = [num(value.pivot[0], 0.5), num(value.pivot[1], 0.5)];
    return f;
  });
  for (const f of frames) if (!(f.w > 0 && f.h > 0)) throw new Error(`Frame "${f.name}" has no size in the metadata.`);

  const tagList = Array.isArray(meta.frameTags) ? meta.frameTags : Array.isArray(root.tags) ? root.tags : [];
  const tags: SheetTag[] = [];
  for (const t of tagList) {
    if (!isObj(t) || typeof t.name !== 'string') continue;
    const from = Math.max(0, Math.min(frames.length - 1, Math.round(num(t.from))));
    const to = Math.max(from, Math.min(frames.length - 1, Math.round(num(t.to, from))));
    tags.push({ name: t.name, from, to, direction: directionOf(t.direction) });
  }
  const size = isObj(meta.size) ? meta.size : null;
  return {
    image: typeof meta.image === 'string' ? meta.image : typeof root.image === 'string' ? root.image : undefined,
    width: size ? num(size.w) || undefined : num(root.width) || undefined,
    height: size ? num(size.h) || undefined : num(root.height) || undefined,
    frames,
    tags,
  };
}

/* ----------------------------------------------------------------------------------------------- */
/* Slicing                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

export interface GridSlice {
  /** 'count': columns x rows given. 'size': cell width x height given. */
  by: 'count' | 'size';
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** Space around the whole grid. */
  margin: number;
  /** Space between cells. */
  spacing: number;
}

/** Frames of a regular grid (row-major, frame 0 top-left). Cells that do not fit entirely inside the image are dropped. */
export function sliceGrid(imageW: number, imageH: number, g: GridSlice): SheetFrame[] {
  const margin = Math.max(0, Math.floor(g.margin));
  const spacing = Math.max(0, Math.floor(g.spacing));
  const innerW = imageW - 2 * margin;
  const innerH = imageH - 2 * margin;
  let cols: number;
  let rows: number;
  let cw: number;
  let ch: number;
  if (g.by === 'size') {
    cw = Math.max(1, Math.floor(g.cellWidth));
    ch = Math.max(1, Math.floor(g.cellHeight));
    cols = Math.max(0, Math.floor((innerW + spacing) / (cw + spacing)));
    rows = Math.max(0, Math.floor((innerH + spacing) / (ch + spacing)));
  } else {
    cols = Math.max(1, Math.floor(g.columns));
    rows = Math.max(1, Math.floor(g.rows));
    cw = Math.floor((innerW - (cols - 1) * spacing) / cols);
    ch = Math.floor((innerH - (rows - 1) * spacing) / rows);
  }
  const frames: SheetFrame[] = [];
  if (cw < 1 || ch < 1) return frames;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = frames.length;
      frames.push({ index, name: String(index), x: margin + c * (cw + spacing), y: margin + r * (ch + spacing), w: cw, h: ch, offX: 0, offY: 0, srcW: cw, srcH: ch, durationMs: 0 });
    }
  }
  return frames;
}

export interface AutoSlice {
  /** Alpha above this (0..255) counts as sprite. */
  alphaThreshold: number;
  /** Pieces closer than this many pixels belong to the same sprite. */
  gap: number;
  /** Boxes whose longer side is below this are noise and dropped. */
  minSize: number;
  /** Extra pixels kept around every box. */
  padding: number;
}

/**
 * Find the sprites of a sheet by the transparent gaps between them: 8-connected opaque regions, regions closer than `gap` merged, tiny ones dropped,
 * then ordered into rows (top to bottom) and left to right inside a row. `rgba` is straight RGBA8.
 */
export function sliceAuto(rgba: ArrayLike<number>, width: number, height: number, o: AutoSlice): SheetFrame[] {
  const thr = Math.max(0, Math.min(254, o.alphaThreshold));
  const label = new Int32Array(width * height).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] <= thr) continue;
    const id = boxes.length;
    const box = { x0: width, y0: height, x1: -1, y1: -1 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (label[q] !== -1 || rgba[q * 4 + 3] <= thr) continue;
          label[q] = id;
          stack.push(q);
        }
      }
    }
    boxes.push(box);
  }
  // Merge boxes that overlap once grown by half the gap on every side (repeat until stable).
  const grow = Math.max(0, Math.floor(o.gap));
  let merged = boxes;
  for (let changed = true; changed; ) {
    changed = false;
    const out: typeof boxes = [];
    for (const b of merged) {
      const hit = out.find((c) => b.x0 - grow - 1 <= c.x1 && b.x1 + grow + 1 >= c.x0 && b.y0 - grow - 1 <= c.y1 && b.y1 + grow + 1 >= c.y0);
      if (hit) {
        hit.x0 = Math.min(hit.x0, b.x0);
        hit.y0 = Math.min(hit.y0, b.y0);
        hit.x1 = Math.max(hit.x1, b.x1);
        hit.y1 = Math.max(hit.y1, b.y1);
        changed = true;
      } else out.push({ ...b });
    }
    merged = out;
  }
  const minSide = Math.max(0, o.minSize);
  const pad = Math.max(0, Math.floor(o.padding));
  const kept = merged
    .filter((b) => Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1) >= minSide)
    .map((b) => ({ x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad), x1: Math.min(width - 1, b.x1 + pad), y1: Math.min(height - 1, b.y1 + pad) }));
  // Rows: sort by top edge, start a new row when a box's centre is below the current row's bottom.
  kept.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: (typeof kept)[] = [];
  let rowBottom = -1;
  for (const b of kept) {
    const cy = (b.y0 + b.y1) / 2;
    if (rows.length && cy <= rowBottom) {
      rows[rows.length - 1].push(b);
      rowBottom = Math.max(rowBottom, b.y1);
    } else {
      rows.push([b]);
      rowBottom = b.y1;
    }
  }
  const frames: SheetFrame[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
    for (const b of row) {
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      const index = frames.length;
      frames.push({ index, name: String(index), x: b.x0, y: b.y0, w, h, offX: 0, offY: 0, srcW: w, srcH: h, durationMs: 0 });
    }
  }
  return frames;
}

/* ----------------------------------------------------------------------------------------------- */
/* Selection and timing                                                                              */
/* ----------------------------------------------------------------------------------------------- */

/** "0,1,2,1" or "0-3, 6" -> list of numbers (ranges inclusive, either direction). Invalid pieces are ignored. */
export function parseIndexList(text: string, max: number): number[] {
  const out: number[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) if (i >= 0 && i < max) out.push(i);
  }
  return out;
}

export type FrameOrder = 'row' | 'column' | 'custom';

/** Frame indices in play order. `column` reorders a regular grid column by column (needs `columns`). */
export function orderFrames(count: number, order: FrameOrder, columns: number, custom: string): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (order === 'custom') {
    const list = parseIndexList(custom, count);
    return list.length ? list : all;
  }
  if (order === 'column' && columns > 0) {
    const rows = Math.ceil(count / columns);
    const out: number[] = [];
    for (let c = 0; c < columns; c++) for (let r = 0; r < rows; r++) if (r * columns + c < count) out.push(r * columns + c);
    return out;
  }
  return all;
}

/** Frames of a tag in its own direction (pingpong without repeating the ends). */
export function tagFrames(tag: SheetTag): number[] {
  const fwd: number[] = [];
  for (let i = tag.from; i <= tag.to; i++) fwd.push(i);
  if (tag.direction === 'reverse') return fwd.reverse();
  if (tag.direction === 'pingpong' && fwd.length > 2) return [...fwd, ...fwd.slice(1, -1).reverse()];
  return fwd;
}

export interface TimelineEntry {
  /** Index into the selection (play order position), and the sheet frame shown. */
  step: number;
  frame: number;
  ms: number;
}

/**
 * The animation as a list of (frame, duration). `durationsMs[frame]` > 0 wins when `useMetadata`, otherwise every step lasts 1000 / fps.
 * `pingPong` appends the way back without repeating the end frames.
 */
export function buildTimeline(frames: number[], durationsMs: (frame: number) => number, useMetadata: boolean, fps: number, pingPong: boolean): TimelineEntry[] {
  const seq = pingPong && frames.length > 2 ? [...frames, ...frames.slice(1, -1).reverse()] : frames.slice();
  const base = 1000 / Math.max(0.001, fps);
  return seq.map((frame, step) => {
    const d = useMetadata ? durationsMs(frame) : 0;
    return { step, frame, ms: d > 0 ? d : base };
  });
}

/**
 * Which entry plays at `seconds`. `hold` extends the last entry (seconds) before a loop restarts. Without `loop` the last entry stays.
 */
export function entryAt(timeline: TimelineEntry[], seconds: number, loop: boolean, holdSeconds = 0): TimelineEntry {
  if (!timeline.length) throw new Error('entryAt: empty timeline');
  const total = timeline.reduce((s, e) => s + e.ms, 0) + Math.max(0, holdSeconds) * 1000;
  let t = Math.max(0, seconds) * 1000;
  if (loop) t = t % total;
  else t = Math.min(t, total - 1e-6);
  // Half a millisecond of tolerance: a frame boundary hit by float noise must not flip to the previous frame.
  t += 1e-6;
  let acc = 0;
  for (let i = 0; i < timeline.length; i++) {
    acc += timeline[i].ms + (i === timeline.length - 1 ? Math.max(0, holdSeconds) * 1000 : 0);
    if (t < acc) return timeline[i];
  }
  return timeline[timeline.length - 1];
}

/* ----------------------------------------------------------------------------------------------- */
/* Placement                                                                                         */
/* ----------------------------------------------------------------------------------------------- */

export type CellAnchor = 'center' | 'top-left' | 'top' | 'top-right' | 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

/** Where a w x h picture sits inside a cw x ch cell for an anchor (whole texels, rounded toward the top-left). */
export function anchorOffset(anchor: CellAnchor, w: number, h: number, cw: number, ch: number): [number, number] {
  const dx = cw - w;
  const dy = ch - h;
  const x = anchor.includes('left') || anchor === 'left' ? 0 : anchor.includes('right') ? dx : Math.floor(dx / 2);
  const y = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? dy : Math.floor(dy / 2);
  return [x, y];
}

/** Tight box around the pixels whose alpha is above `threshold` (straight RGBA8). Null when nothing is opaque. */
export function opaqueBounds(rgba: ArrayLike<number>, width: number, height: number, threshold = 0): { x: number; y: number; w: number; h: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ----------------------------------------------------------------------------------------------- */
/* Selection of the frames to play                                                                  */
/* ----------------------------------------------------------------------------------------------- */

export interface Selection {
  /** Animation (tag) name; empty or unknown = all frames. */
  tag: string;
  /** Positions within the tag (or the whole sheet): "0-3,5". Empty = all. */
  range: string;
  order: FrameOrder;
  /** Columns of a regular grid, for column-major order. */
  columns: number;
  /** For order 'custom': sheet frame numbers, "0,1,2,1". */
  sequence: string;
}

/** Sheet frame numbers to play, in order. Never empty for a sheet with frames. */
export function selectFrames(desc: SheetDescription, s: Selection): number[] {
  const n = desc.frames.length;
  if (n === 0) return [];
  if (s.order === 'custom') return orderFrames(n, 'custom', s.columns, s.sequence);
  const tag = s.tag.trim() ? desc.tags.find((t) => t.name === s.tag.trim()) : undefined;
  let base = tag ? tagFrames(tag) : orderFrames(n, s.order, s.columns, '');
  if (s.range.trim()) {
    const picks = parseIndexList(s.range, base.length);
    if (picks.length) base = picks.map((i) => base[i]);
  }
  return base;
}

/** Opaque bounds of one frame rectangle inside the whole sheet's pixels (sheet coordinates), or null when it is empty. */
export function frameBounds(rgba: ArrayLike<number>, sheetWidth: number, f: { x: number; y: number; w: number; h: number }, threshold = 0): { x: number; y: number; w: number; h: number } | null {
  let x0 = f.w;
  let y0 = f.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (rgba[((f.y + y) * sheetWidth + f.x + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: f.x + x0, y: f.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ----------------------------------------------------------------------------------------------- */
/* Cells as batch items                                                                             */
/* ----------------------------------------------------------------------------------------------- */

const JSON_COUNT_MEMO = new Map<string, SheetDescription | null>();

/**
 * How many cells "Play as: Batch items" hands out PER SHEET, from the node's params alone (`NodeDef.batchSize` is pure and has no picture),
 * or null when it cannot be known from params:
 *  - grid by columns and rows: columns x rows cells, then the same selection (animation, frames, order) the node plays;
 *  - metadata JSON: the frames the metadata lists, then the selection (parsed once per text, memoised);
 *  - grid by cell size and gap detection depend on the sheet's pixels: the user's `itemCount` (> 0) is used, else null (the batch is then
 *    decided by the file lists as before, and the Count output says how many cells were found).
 */
export function itemCellCount(p: { slicing: string; by: string; columns: number; rows: number; meta: string; tag: string; range: string; order: FrameOrder; sequence: string; itemCount: number }): number | null {
  let desc: SheetDescription | null = null;
  let columns = 0;
  if (p.slicing === 'grid' && p.by === 'count') {
    const n = Math.max(1, Math.floor(p.columns)) * Math.max(1, Math.floor(p.rows));
    desc = { frames: Array.from({ length: n }, (_, index) => ({ index, name: String(index), x: 0, y: 0, w: 1, h: 1, offX: 0, offY: 0, srcW: 1, srcH: 1, durationMs: 0 })), tags: [] };
    columns = Math.max(1, Math.floor(p.columns));
  } else if (p.slicing === 'json') {
    if (!p.meta.trim()) return null;
    if (!JSON_COUNT_MEMO.has(p.meta)) {
      let parsed: SheetDescription | null = null;
      try {
        parsed = parseSheetJson(p.meta);
      } catch {
        parsed = null;
      }
      if (JSON_COUNT_MEMO.size >= 8) JSON_COUNT_MEMO.delete(JSON_COUNT_MEMO.keys().next().value as string);
      JSON_COUNT_MEMO.set(p.meta, parsed);
    }
    desc = JSON_COUNT_MEMO.get(p.meta) ?? null;
  } else return p.itemCount > 0 ? Math.floor(p.itemCount) : null;
  if (!desc) return null;
  const n = selectFrames(desc, { tag: p.tag, range: p.range, order: p.order, columns, sequence: p.sequence }).length;
  return n > 0 ? n : null;
}
