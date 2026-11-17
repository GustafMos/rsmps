import { defineNode } from '../../define';
import type { ImageValue } from '../../types';
import {
  anchorOffset,
  buildTimeline,
  entryAt,
  frameBounds,
  itemCellCount,
  parseSheetJson,
  selectFrames,
  sliceAuto,
  sliceGrid,
  type CellAnchor,
  type SheetDescription,
  type SheetFrame,
} from '../../lib/sprite-sheet';

/** Slicing and trim analysis of one sheet, kept by identity of the sheet content so playing the animation never repeats it. */
interface Analysis {
  desc: SheetDescription;
  /** Per frame: the opaque rectangle (sheet coordinates) when "Trim borders" is on, null for an empty frame. */
  bounds: ({ x: number; y: number; w: number; h: number } | null)[] | null;
}
const MEMO = new Map<string, Analysis>();
const MEMO_LIMIT = 24;

function remember(key: string, a: Analysis): Analysis {
  MEMO.delete(key);
  MEMO.set(key, a);
  while (MEMO.size > MEMO_LIMIT) MEMO.delete(MEMO.keys().next().value as string);
  return a;
}

const ANCHORS: { value: CellAnchor; label: string }[] = [
  { value: 'center', label: 'Center' },
  { value: 'top-left', label: 'Top left' },
  { value: 'top', label: 'Top' },
  { value: 'top-right', label: 'Top right' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'bottom-right', label: 'Bottom right' },
];

export default defineNode({
  id: 'sprite-sheet-in',
  title: 'Sprite Sheet In',
  category: 'input',
  description:
    'Plays the cells of a sprite sheet as an animation, or hands each cell to the rest of the graph as a batch item. The sheet comes from a wired picture or a file. Cells are found by a grid, by the transparent gaps between sprites, or from the JSON that Aseprite or TexturePacker (or this app\'s Output) writes next to the sheet, which also gives frame durations, trimmed offsets and named animations. ' +
    'The cell is delivered at its own size with hard pixels, ready for Pixel Upscale, Outline, Palette Lock and the Output. Wire a sheet at full size: the cell sizes are measured in sheet pixels.',
  keywords: ['spritesheet', 'sprite sheet', 'atlas', 'slice', 'frames', 'strip', 'cells', 'aseprite', 'texture packer', 'texturepacker', 'tileset', 'animation', 'flipbook'],
  cpu: true,
  inputs: { image: { type: 'image', label: 'Sheet' } },
  outputs: { image: { type: 'image', label: 'Image' }, frame: { type: 'number', label: 'Frame' }, count: { type: 'number', label: 'Count' } },
  params: {
    assets: { type: 'assets', default: [], accept: 'image-video', label: 'Sheet file', group: 'Source', hint: 'Used when no picture is wired to Sheet. With several files each batch item uses its own sheet.' },
    slicing: {
      type: 'enum',
      default: 'grid',
      label: 'Slice by',
      group: 'Slicing',
      options: [
        { value: 'grid', label: 'Grid' },
        { value: 'auto', label: 'Gaps between sprites' },
        { value: 'json', label: 'Metadata JSON' },
      ],
    },
    by: {
      type: 'enum',
      default: 'count',
      label: 'Grid given as',
      group: 'Slicing',
      options: [
        { value: 'count', label: 'Columns and rows' },
        { value: 'size', label: 'Cell size' },
      ],
      visibleIf: (p) => p.slicing === 'grid',
    },
    columns: { type: 'number', default: 4, min: 1, max: 256, softMax: 64, step: 1, integer: true, label: 'Columns', group: 'Slicing', visibleIf: (p) => p.slicing === 'grid' && p.by === 'count' },
    rows: { type: 'number', default: 1, min: 1, max: 256, softMax: 64, step: 1, integer: true, label: 'Rows', group: 'Slicing', visibleIf: (p) => p.slicing === 'grid' && p.by === 'count' },
    cellWidth: { type: 'number', default: 32, min: 1, max: 8192, softMax: 512, step: 1, integer: true, label: 'Cell width', hint: 'Sheet pixels.', group: 'Slicing', visibleIf: (p) => p.slicing === 'grid' && p.by === 'size' },
    cellHeight: { type: 'number', default: 32, min: 1, max: 8192, softMax: 512, step: 1, integer: true, label: 'Cell height', hint: 'Sheet pixels.', group: 'Slicing', visibleIf: (p) => p.slicing === 'grid' && p.by === 'size' },
    margin: { type: 'number', default: 0, min: 0, max: 512, softMax: 64, step: 1, integer: true, label: 'Margin', hint: 'Space around the whole grid, sheet pixels.', group: 'Slicing', visibleIf: (p) => p.slicing === 'grid' },
    spacing: { type: 'number', default: 0, min: 0, max: 512, softMax: 64, step: 1, integer: true, label: 'Spacing', hint: 'Space between cells, sheet pixels.', group: 'Slicing', visibleIf: (p) => p.slicing === 'grid' },
    alphaCutoff: { type: 'number', default: 0, min: 0, max: 0.99, step: 0.01, label: 'Alpha cutoff', hint: 'Pixels with alpha at or below this count as empty.', group: 'Slicing', visibleIf: (p) => p.slicing === 'auto' },
    gap: { type: 'number', default: 0, min: 0, max: 64, softMax: 16, step: 1, integer: true, label: 'Join gap', hint: 'Pieces separated by at most this many empty pixels are one sprite.', group: 'Slicing', visibleIf: (p) => p.slicing === 'auto' },
    minSize: { type: 'number', default: 2, min: 1, max: 512, softMax: 64, step: 1, integer: true, label: 'Minimum size', hint: 'Smaller specks are ignored.', group: 'Slicing', visibleIf: (p) => p.slicing === 'auto' },
    autoPad: { type: 'number', default: 0, min: 0, max: 32, step: 1, integer: true, label: 'Padding', hint: 'Extra pixels kept around every detected sprite.', group: 'Slicing', visibleIf: (p) => p.slicing === 'auto' },
    meta: {
      type: 'string',
      default: '',
      multiline: true,
      label: 'Metadata JSON',
      hint: 'Paste the JSON written next to the sheet: Aseprite (array or hash), TexturePacker (hash or array) or this app\'s generic format. Rotated frames are not supported.',
      group: 'Slicing',
      visibleIf: (p) => p.slicing === 'json',
    },
    as: {
      type: 'enum',
      default: 'animation',
      label: 'Play as',
      group: 'Playback',
      options: [
        { value: 'animation', label: 'Animation over time' },
        { value: 'items', label: 'Batch items' },
      ],
      hint: 'Batch items: batch item N shows cell N, so the whole graph runs once per sprite and an Output writes one file each or re-packs one sheet. The node sets the batch size itself: the cells of the grid (columns x rows) or of the metadata, times the number of sheet files.',
    },
    itemCount: {
      type: 'number',
      default: 0,
      min: 0,
      max: 100000,
      softMax: 256,
      step: 1,
      integer: true,
      label: 'Items per sheet',
      hint: 'Only for Cell size grids and Gaps between sprites: how many cells to hand out (the Count output shows how many were found). 0 = unknown, the batch size then comes from the file lists.',
      group: 'Playback',
      visibleIf: (p) => p.as === 'items' && (p.slicing === 'auto' || (p.slicing === 'grid' && p.by === 'size')),
    },
    tag: { type: 'string', default: '', label: 'Animation', hint: 'Name of an animation from the metadata (Aseprite tag). Empty = all frames.', group: 'Playback', visibleIf: (p) => p.slicing === 'json' },
    range: { type: 'string', default: '', label: 'Frames', hint: 'Which frames, counted from 0: "2-7" or "0,1,4-6". Empty = all.', group: 'Playback' },
    order: {
      type: 'enum',
      default: 'row',
      label: 'Order',
      group: 'Playback',
      options: [
        { value: 'row', label: 'Rows first' },
        { value: 'column', label: 'Columns first' },
        { value: 'custom', label: 'Custom list' },
      ],
    },
    sequence: { type: 'string', default: '0,1,2,1', label: 'Frame list', hint: 'Sheet frame numbers in play order, repeats allowed: 0,1,2,1', group: 'Playback', visibleIf: (p) => p.order === 'custom' },
    timing: {
      type: 'enum',
      default: 'fps',
      label: 'Timing',
      group: 'Playback',
      options: [
        { value: 'fps', label: 'Frame rate' },
        { value: 'meta', label: 'Durations from metadata' },
      ],
      visibleIf: (p) => p.as === 'animation',
    },
    fps: { type: 'number', default: 12, min: 0.1, max: 240, softMax: 60, step: 0.1, unit: 'hz', label: 'Frame rate', hint: 'Cells per second (also the fallback for frames without a duration).', group: 'Playback', visibleIf: (p) => p.as === 'animation' },
    pingPong: { type: 'bool', default: false, label: 'Ping-pong', hint: 'Play forward then back, without repeating the end frames.', group: 'Playback', visibleIf: (p) => p.as === 'animation' },
    loop: { type: 'bool', default: true, label: 'Loop', hint: 'Off: the last cell stays.', group: 'Playback', visibleIf: (p) => p.as === 'animation' },
    hold: { type: 'number', default: 0, min: 0, max: 60, step: 0.05, unit: 's', label: 'Hold last', hint: 'Extra seconds on the last cell before the loop restarts.', group: 'Playback', visibleIf: (p) => p.as === 'animation' },
    trim: { type: 'bool', default: false, label: 'Trim borders', hint: 'Cut each cell down to its opaque pixels (a one-time analysis of the sheet).', group: 'Cell' },
    untrim: { type: 'bool', default: true, label: 'Restore trim', hint: 'Metadata that trimmed the frames: put each back at its original offset and size.', group: 'Cell', visibleIf: (p) => p.slicing === 'json' && p.trim !== true },
    anchor: { type: 'enum', default: 'center', label: 'Anchor', hint: 'Where a smaller cell sits inside the common cell size (the largest selected cell).', group: 'Cell', options: ANCHORS },
  },
  summary: (p) => `${p.slicing === 'grid' ? (p.by === 'count' ? `${p.columns}x${p.rows} grid` : `${p.cellWidth}x${p.cellHeight} cells`) : p.slicing === 'auto' ? 'auto cells' : 'metadata'} · ${p.as === 'items' ? 'items' : `${p.fps} fps`}`,
  batchSize: (p) => {
    if (p.as !== 'items') return null;
    const per = itemCellCount(p);
    return per === null ? null : per * Math.max(1, p.assets.length);
  },
  async render(ctx) {
    const p = ctx.params;
    const items = p.as === 'items';
    // Cells per sheet when this node sets the batch size itself: item = sheet x cells + cell (several sheet files each give all their cells).
    const per = items ? itemCellCount(p) : null;

    // 1. The sheet picture, at full size.
    let sheet: ImageValue | null = ctx.in.image;
    let key: string;
    if (sheet) {
      key = `w:${ctx.nodeId}:${ctx.inputSignature('image')}:${ctx.inputVaries('image') ? ctx.time.frame : 0}`;
    } else {
      if (p.assets.length === 0) throw new Error('Wire a picture to Sheet or add a sprite sheet file.');
      const id = p.assets.length > 1 ? p.assets[(per ? Math.floor(ctx.item.index / per) : ctx.item.index) % p.assets.length] : p.assets[0];
      if (!ctx.host.assetInfo(id)) throw new Error('The sprite sheet file is missing. Add it again.');
      const frame = await ctx.host.assetFrame(id, 0, 0);
      if (!frame) throw new Error('Could not decode the sprite sheet file.');
      sheet = { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: 1 };
      key = `a:${id}`;
    }
    const W = sheet.width;
    const H = sheet.height;

    // 2. Slice (memoised: a pure function of the sheet and the slicing settings).
    const slicingKey = `${p.slicing}|${p.by}|${p.columns}|${p.rows}|${p.cellWidth}|${p.cellHeight}|${p.margin}|${p.spacing}|${p.alphaCutoff}|${p.gap}|${p.minSize}|${p.autoPad}|${p.trim}|${p.slicing === 'json' ? p.meta : ''}`;
    const memoKey = `${key}|${W}x${H}|${slicingKey}`;
    let analysis = MEMO.get(memoKey);
    if (analysis) remember(memoKey, analysis);
    else {
      let pixels: Uint8ClampedArray | null = null;
      const readSheet = async () => (pixels ??= await ctx.gpu.read(sheet!, true));
      let desc: SheetDescription;
      if (p.slicing === 'grid') {
        desc = { frames: sliceGrid(W, H, { by: p.by, columns: p.columns, rows: p.rows, cellWidth: p.cellWidth, cellHeight: p.cellHeight, margin: p.margin, spacing: p.spacing }), tags: [] };
      } else if (p.slicing === 'auto') {
        desc = { frames: sliceAuto(await readSheet(), W, H, { alphaThreshold: Math.round(p.alphaCutoff * 255), gap: p.gap, minSize: p.minSize, padding: p.autoPad }), tags: [] };
      } else {
        if (!p.meta.trim()) throw new Error('Paste the sprite sheet metadata JSON into Metadata JSON.');
        desc = parseSheetJson(p.meta);
        for (const f of desc.frames) if (f.x < 0 || f.y < 0 || f.x + f.w > W || f.y + f.h > H) throw new Error(`Frame "${f.name}" lies outside the ${W}x${H} sheet: is this the picture the metadata belongs to?`);
      }
      if (desc.frames.length === 0) throw new Error('No cells were found in the sheet. Check the grid, or lower the alpha cutoff.');
      let bounds: Analysis['bounds'] = null;
      if (p.trim) {
        const px = await readSheet();
        bounds = desc.frames.map((f) => frameBounds(px, W, f));
      }
      analysis = remember(memoKey, { desc, bounds });
    }
    const { desc, bounds } = analysis;

    // 3. Which cells play, in which order.
    const columns = p.slicing === 'grid' && p.by === 'count' ? p.columns : p.slicing === 'grid' ? Math.max(1, Math.floor(W / Math.max(1, p.cellWidth + p.spacing))) : 0;
    const selection = selectFrames(desc, { tag: p.tag, range: p.range, order: p.order, columns, sequence: p.sequence });
    if (selection.length === 0) throw new Error('The frame selection is empty.');

    // 4. Which one is shown now.
    let shown: number;
    if (items) shown = selection[(per ? ctx.item.index % per : ctx.item.index) % selection.length];
    else if (selection.length === 1) shown = selection[0];
    else {
      const timeline = buildTimeline(selection, (f) => desc.frames[f].durationMs, p.timing === 'meta', p.fps, p.pingPong);
      shown = entryAt(timeline, ctx.time.seconds, p.loop, p.hold).frame;
    }

    // 5. Placement: a common cell, every cell anchored inside it. Rectangles are the content to copy; "logical" is the frame they sit in.
    const geo = (f: SheetFrame) => {
      const b = bounds?.[f.index];
      if (p.trim) {
        const r = b ?? { x: f.x, y: f.y, w: 1, h: 1 };
        return { rx: r.x, ry: r.y, rw: b ? r.w : 0, rh: b ? r.h : 0, lw: r.w, lh: r.h, ox: 0, oy: 0 };
      }
      if (p.slicing === 'json' && p.untrim) return { rx: f.x, ry: f.y, rw: f.w, rh: f.h, lw: f.srcW, lh: f.srcH, ox: f.offX, oy: f.offY };
      return { rx: f.x, ry: f.y, rw: f.w, rh: f.h, lw: f.w, lh: f.h, ox: 0, oy: 0 };
    };
    let cw = 1;
    let ch = 1;
    for (const i of new Set(selection)) {
      const g = geo(desc.frames[i]);
      cw = Math.max(cw, g.lw);
      ch = Math.max(ch, g.lh);
    }
    const g = geo(desc.frames[shown]);
    const [ax, ay] = anchorOffset(p.anchor as CellAnchor, g.lw, g.lh, cw, ch);
    const max = ctx.gpu.device.limits.maxTextureDimension2D;
    if (cw > max || ch > max) throw new Error(`The cell would be ${cw}x${ch}, larger than this GPU supports (${max}).`);

    const image = ctx.gpu.pass({
      label: 'sprite-sheet-in',
      size: { width: cw, height: ch, unit: 1 },
      textures: { sheet },
      uniforms: { rect: [g.rx, g.ry, g.rw, g.rh], dest: [ax + g.ox, ay + g.oy] },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let q = vec2i(floor(px)) - vec2i(u.dest);
  if (q.x < 0 || q.y < 0 || q.x >= i32(u.rect.z) || q.y >= i32(u.rect.w)) { return vec4f(0.0); }
  return textureLoad(sheet, vec2i(u.rect.xy) + q, 0);
}`,
    });
    return { image, frame: shown, count: selection.length };
  },
});
