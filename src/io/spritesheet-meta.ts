/**
 * Metadata written next to a sprite sheet. Pure text builders; the reader for all of these is `parseSheetJson` (engine/lib/sprite-sheet.ts),
 * so a sheet exported here can be played / sliced again by Sprite Sheet In (round trip, tested).
 *
 * Formats (honest list of what is and is not claimed):
 *  - json           this app's generic format: frames with rectangles, durations in SECONDS, trim offsets, pivot, tags. A superset of the
 *                   metadata older versions wrote (all the old keys are still there).
 *  - aseprite       the layout Aseprite's "Export Sprite Sheet" writes with "JSON Data: Array" (frames[], meta.frameTags, durations in ms).
 *  - texturepacker  the layout of TexturePacker's "JSON (Hash)" data format (frames{}, meta). No animation data (the format has none).
 *  - css            a stylesheet: one class per frame (width, height, background position) and one @keyframes per tag.
 * Godot and Unity have no format of their own here: they read the generic JSON (see docs/GAME_ASSETS.md for a Godot import script).
 */
import type { SheetTag } from '../engine/lib/sprite-sheet';
import type { SheetBuild } from './spritesheet-pack';

export type SheetMetaFormat = 'none' | 'json' | 'aseprite' | 'texturepacker' | 'css';

export interface SheetMetaInput {
  /** Names the frames: `${baseName}_${index}`. */
  baseName: string;
  /** File name of each page image, same order as `build.pages`. */
  images: string[];
  build: SheetBuild;
  /** Per frame, milliseconds. */
  durationsMs: number[];
  tags: SheetTag[];
  fps: number;
  loop: boolean;
  padding: number;
  extrude: number;
  /** Pivot inside the ORIGINAL frame, 0..1 (x right, y down), same for every frame. Null = none. */
  pivot: [number, number] | null;
}

export interface MetaFile {
  /** File extension without the dot. */
  ext: string;
  /** '' for the only file, `_2` etc. for page files of formats that cannot list several pages. */
  suffix: string;
  text: string;
}

const frameName = (i: SheetMetaInput, index: number) => `${i.baseName}_${index}`;

function genericJson(i: SheetMetaInput): string {
  const b = i.build;
  const f0 = b.frames[0];
  const frames = b.frames.map((f) => ({
    index: f.index,
    name: frameName(i, f.index),
    page: f.page,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    offsetX: f.offX,
    offsetY: f.offY,
    sourceWidth: f.srcW,
    sourceHeight: f.srcH,
    duration: i.durationsMs[f.index] / 1000,
    ...(i.pivot ? { pivot: i.pivot } : {}),
  }));
  const doc = {
    format: 'rsmps-spritesheet',
    version: 2,
    image: i.images[0],
    ...(i.images.length > 1 ? { images: i.images } : {}),
    width: b.pages[0].width,
    height: b.pages[0].height,
    ...(i.images.length > 1 ? { pages: b.pages.map((p, k) => ({ image: i.images[k], width: p.width, height: p.height })) } : {}),
    frameWidth: f0.srcW,
    frameHeight: f0.srcH,
    columns: b.columns,
    rows: b.rows,
    padding: i.padding,
    extrude: i.extrude,
    frameCount: b.frames.length,
    fps: i.fps,
    loop: i.loop,
    frameDuration: 1 / i.fps,
    frames,
    tags: i.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
  };
  return JSON.stringify(doc, null, 2);
}

/** Frames of one page, in the order of their index, with their own numbering for formats that list one page per file. */
function pageFrames(i: SheetMetaInput, page: number) {
  return i.build.frames.filter((f) => f.page === page);
}

function aseprite(i: SheetMetaInput, page: number): string {
  const pg = i.build.pages[page];
  const frames = pageFrames(i, page).map((f) => ({
    filename: frameName(i, f.index),
    frame: { x: f.x, y: f.y, w: f.w, h: f.h },
    rotated: false,
    trimmed: f.w !== f.srcW || f.h !== f.srcH,
    spriteSourceSize: { x: f.offX, y: f.offY, w: f.w, h: f.h },
    sourceSize: { w: f.srcW, h: f.srcH },
    duration: Math.round(i.durationsMs[f.index]),
  }));
  // Tags are only meaningful when the whole sheet is one page (indices are per file).
  const tags = i.build.pages.length === 1 ? i.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })) : [];
  return JSON.stringify(
    { frames, meta: { app: 'RSMPS', version: '1', image: i.images[page], format: 'RGBA8888', size: { w: pg.width, h: pg.height }, scale: '1', frameTags: tags } },
    null,
    2,
  );
}

function texturePacker(i: SheetMetaInput, page: number): string {
  const pg = i.build.pages[page];
  const frames: Record<string, unknown> = {};
  for (const f of pageFrames(i, page)) {
    frames[frameName(i, f.index)] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: f.w !== f.srcW || f.h !== f.srcH,
      spriteSourceSize: { x: f.offX, y: f.offY, w: f.w, h: f.h },
      sourceSize: { w: f.srcW, h: f.srcH },
      ...(i.pivot ? { pivot: { x: i.pivot[0], y: i.pivot[1] } } : {}),
    };
  }
  return JSON.stringify({ frames, meta: { app: 'RSMPS', version: '1.0', image: i.images[page], format: 'RGBA8888', size: { w: pg.width, h: pg.height }, scale: '1' } }, null, 2);
}

const cssIdent = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1') || 'frame';

function css(i: SheetMetaInput, page: number): string {
  const lines: string[] = [];
  const base = cssIdent(i.baseName);
  const pg = i.build.pages[page];
  lines.push(`/* ${i.images[page]} (${pg.width}x${pg.height}). Pixel art: keep image-rendering on pixelated. */`);
  lines.push(`.${base} { background-image: url("${i.images[page]}"); background-repeat: no-repeat; image-rendering: pixelated; display: inline-block; }`);
  const frames = pageFrames(i, page);
  for (const f of frames) lines.push(`.${base}-${f.index} { width: ${f.w}px; height: ${f.h}px; background-position: -${f.x}px -${f.y}px; }`);
  if (i.build.pages.length === 1) {
    for (const t of i.tags) {
      const ids: number[] = [];
      for (let k = t.from; k <= t.to; k++) ids.push(k);
      const total = ids.reduce((s, k) => s + (i.durationsMs[k] || 1000 / i.fps), 0);
      const name = `${base}-${cssIdent(t.name)}`;
      lines.push(`@keyframes ${name} {`);
      let at = 0;
      for (const k of ids) {
        const f = i.build.frames[k];
        lines.push(`  ${(at / total * 100).toFixed(3).replace(/\.?0+$/, '')}% { background-position: -${f.x}px -${f.y}px; animation-timing-function: steps(1, end); }`);
        at += i.durationsMs[k] || 1000 / i.fps;
      }
      lines.push(`  100% { background-position: -${i.build.frames[ids[ids.length - 1]].x}px -${i.build.frames[ids[ids.length - 1]].y}px; }`);
      lines.push('}');
      lines.push(`.${name} { width: ${i.build.frames[ids[0]].srcW}px; height: ${i.build.frames[ids[0]].srcH}px; animation: ${name} ${(total / 1000).toFixed(3)}s linear ${i.loop ? 'infinite' : '1 forwards'}; }`);
    }
  }
  return lines.join('\n') + '\n';
}

/** All metadata files for a format (none for 'none'). Formats that cannot list several pages write one file per page. */
export function writeSheetMeta(format: SheetMetaFormat, input: SheetMetaInput): MetaFile[] {
  if (format === 'none') return [];
  if (format === 'json') return [{ ext: 'json', suffix: '', text: genericJson(input) }];
  const out: MetaFile[] = [];
  for (let page = 0; page < input.build.pages.length; page++) {
    const suffix = page === 0 ? '' : `_${page + 1}`;
    if (format === 'aseprite') out.push({ ext: 'json', suffix, text: aseprite(input, page) });
    else if (format === 'texturepacker') out.push({ ext: 'json', suffix, text: texturePacker(input, page) });
    else out.push({ ext: 'css', suffix, text: css(input, page) });
  }
  return out;
}
