/** Spritesheet layout and metadata. Pure. */

export interface SheetLayout {
  columns: number;
  rows: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  padding: number;
  rects: { x: number; y: number; w: number; h: number }[];
}

/**
 * Row-major grid, frame 0 top-left. `padding` is the gap between frames (Godot's "separation");
 * there is no margin around the sheet. `columns` 0 = auto (about square: ceil(sqrt(count))).
 */
export function layoutSheet(count: number, frameWidth: number, frameHeight: number, columns: number, padding: number): SheetLayout {
  const n = Math.max(1, Math.floor(count));
  const pad = Math.max(0, Math.floor(padding));
  const cols = Math.min(n, columns > 0 ? Math.floor(columns) : Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const rects: SheetLayout['rects'] = [];
  for (let i = 0; i < n; i++) {
    rects.push({ x: (i % cols) * (frameWidth + pad), y: Math.floor(i / cols) * (frameHeight + pad), w: frameWidth, h: frameHeight });
  }
  return {
    columns: cols,
    rows,
    width: cols * frameWidth + (cols - 1) * pad,
    height: rows * frameHeight + (rows - 1) * pad,
    frameWidth,
    frameHeight,
    padding: pad,
    rects,
  };
}

export interface SheetMeta {
  image: string;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  padding: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  /** Seconds per frame. */
  frameDuration: number;
  frames: { index: number; x: number; y: number; w: number; h: number; duration: number }[];
}

export function sheetMetadata(layout: SheetLayout, image: string, fps: number, loop: boolean): SheetMeta {
  const duration = 1 / fps;
  return {
    image,
    width: layout.width,
    height: layout.height,
    frameWidth: layout.frameWidth,
    frameHeight: layout.frameHeight,
    columns: layout.columns,
    rows: layout.rows,
    padding: layout.padding,
    frameCount: layout.rects.length,
    fps,
    loop,
    frameDuration: duration,
    frames: layout.rects.map((r, index) => ({ index, ...r, duration })),
  };
}
