import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildTimeline, entryAt, opaqueBounds, orderFrames, parseIndexList, parseSheetJson, sliceAuto, sliceGrid, tagFrames, type SheetDescription } from '../engine/lib/sprite-sheet';
import { encodePngRgba } from './png-encode';
import { layoutSheet } from './spritesheet';
import { writeSheetMeta, type SheetMetaFormat, type SheetMetaInput } from './spritesheet-meta';
import { applyPreset } from './spritesheet-presets';
import { bleedTransparent, buildSheets, extractFrames, nextPow2, type Bitmap } from './spritesheet-pack';

/** A w x h frame: a coloured blob (unique colour per seed) inside transparent borders. Opaque pixels only (no premultiplication loss). */
function frame(seed: number, w: number, h: number, box?: { x: number; y: number; w: number; h: number }): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4);
  const b = box ?? { x: 1 + (seed % 3), y: 1 + (seed % 2), w: w - 3 - (seed % 3), h: h - 3 - (seed % 2) };
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (seed * 53 + x * 7) & 255;
      data[i + 1] = (seed * 29 + y * 11) & 255;
      data[i + 2] = (x * y + seed) & 255;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const frames = (n: number, w = 12, h = 10): Bitmap[] => Array.from({ length: n }, (_, i) => frame(i, w, h));

function same(a: Bitmap, b: Bitmap): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

describe('buildSheets layout', () => {
  it('default options reproduce the old grid layout exactly', () => {
    for (const [n, cols, pad] of [[12, 4, 2], [7, 0, 0], [5, 0, 3], [1, 0, 0], [9, 2, 1]] as const) {
      const fr = frames(n);
      const b = buildSheets(fr, { columns: cols, padding: pad });
      const old = layoutSheet(n, 12, 10, cols, pad);
      expect(b.pages).toHaveLength(1);
      expect([b.pages[0].width, b.pages[0].height, b.columns, b.rows]).toEqual([old.width, old.height, old.columns, old.rows]);
      b.frames.forEach((f, i) => expect([f.x, f.y, f.w, f.h]).toEqual([old.rects[i].x, old.rects[i].y, old.rects[i].w, old.rects[i].h]));
    }
  });

  it('row and column layouts', () => {
    const row = buildSheets(frames(5), { layout: 'row' });
    expect([row.pages[0].width, row.pages[0].height]).toEqual([60, 10]);
    const col = buildSheets(frames(5), { layout: 'column', padding: 1 });
    expect([col.pages[0].width, col.pages[0].height]).toEqual([12, 54]);
  });

  it('every layout round-trips the frames pixel exactly', () => {
    const fr = [frame(0, 12, 10), frame(1, 12, 10, { x: 4, y: 2, w: 3, h: 5 }), frame(2, 12, 10), frame(3, 12, 10, { x: 0, y: 0, w: 12, h: 10 }), frame(4, 12, 10, { x: 6, y: 6, w: 1, h: 1 })];
    const variants = [
      {},
      { trim: true },
      { layout: 'pack', trim: true },
      { layout: 'pack' },
      { layout: 'row', extrude: 2, padding: 3, trim: true },
      { layout: 'column', powerOfTwo: true, trim: true },
      { columns: 2, extrude: 1, bleed: true, trim: true, powerOfTwo: true },
      { layout: 'pack', trim: true, maxSize: 20, padding: 1 },
      { maxSize: 30, extrude: 1, padding: 2 },
    ] as const;
    for (const v of variants) {
      const b = buildSheets(fr, v as never);
      const back = extractFrames(b);
      back.forEach((f, i) => expect(same(f, fr[i]), `${JSON.stringify(v)} frame ${i}`).toBe(true));
    }
  });

  it('trim keeps offsets and shrinks the pack', () => {
    const fr = [frame(0, 16, 16, { x: 5, y: 6, w: 4, h: 3 }), frame(1, 16, 16, { x: 2, y: 2, w: 6, h: 6 })];
    const b = buildSheets(fr, { layout: 'pack', trim: true });
    expect(b.frames[0]).toMatchObject({ w: 4, h: 3, offX: 5, offY: 6, srcW: 16, srcH: 16 });
    expect(b.frames[1]).toMatchObject({ w: 6, h: 6, offX: 2, offY: 2 });
    expect(b.pages[0].width * b.pages[0].height).toBeLessThan(16 * 16);
  });

  it('packing is deterministic and frames never overlap', () => {
    const fr = Array.from({ length: 23 }, (_, i) => frame(i, 8 + (i % 5) * 3, 6 + (i % 4) * 4));
    const a = buildSheets(fr, { layout: 'pack', padding: 1, extrude: 1 });
    const b = buildSheets(fr, { layout: 'pack', padding: 1, extrude: 1 });
    expect(a.frames).toEqual(b.frames);
    expect(Array.from(a.pages[0].data)).toEqual(Array.from(b.pages[0].data));
    for (const p of a.frames) for (const q of a.frames) {
      if (p === q || p.page !== q.page) continue;
      const apart = p.x + p.w + 2 <= q.x || q.x + q.w + 2 <= p.x || p.y + p.h + 2 <= q.y || q.y + q.h + 2 <= p.y;
      expect(apart, `${p.index} overlaps ${q.index}`).toBe(true);
    }
  });

  it('power of two rounds every page up; max size makes more pages', () => {
    const pot = buildSheets(frames(5), { powerOfTwo: true });
    expect([nextPow2(pot.pages[0].width), nextPow2(pot.pages[0].height)]).toEqual([pot.pages[0].width, pot.pages[0].height]);
    const many = buildSheets(frames(20), { maxSize: 40, layout: 'grid' });
    expect(many.pages.length).toBeGreaterThan(1);
    for (const p of many.pages) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(40);
    const packed = buildSheets(frames(20), { maxSize: 32, layout: 'pack' });
    expect(packed.pages.length).toBeGreaterThan(1);
    for (const p of packed.pages) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(32);
    expect(() => buildSheets(frames(2), { maxSize: 8 })).toThrow(/does not fit/);
  });

  it('extrude repeats the edge pixels around every frame', () => {
    const fr = [frame(3, 6, 6, { x: 0, y: 0, w: 6, h: 6 })];
    const b = buildSheets(fr, { extrude: 2 });
    const pg = b.pages[0];
    expect([pg.width, pg.height]).toEqual([10, 10]);
    const px = (x: number, y: number) => Array.from(pg.data.subarray((y * pg.width + x) * 4, (y * pg.width + x) * 4 + 4));
    expect(px(0, 5)).toEqual(px(2, 5)); // left edge repeated
    expect(px(9, 5)).toEqual(px(7, 5));
    expect(px(5, 0)).toEqual(px(5, 2));
    expect(px(0, 0)).toEqual(px(2, 2)); // corner
    expect(px(1, 9)).toEqual(px(2, 7));
  });
});

describe('bleed colour under transparency', () => {
  it('fills transparent pixels with the nearest opaque colour and never touches alpha or opaque pixels', () => {
    const d = new Uint8ClampedArray(5 * 1 * 4);
    d.set([200, 10, 10, 255], 0);
    d.set([10, 10, 200, 255], 16);
    bleedTransparent(d, 5, 1);
    expect(Array.from(d.subarray(4, 8))).toEqual([200, 10, 10, 0]);
    expect(Array.from(d.subarray(12, 16))).toEqual([10, 10, 200, 0]);
    expect([d[3], d[19]]).toEqual([255, 255]);
    expect(Array.from(d.subarray(0, 3))).toEqual([200, 10, 10]);
  });

  it('bilinear sampling across a sheet edge shows no dark fringe with bleed, and does without', () => {
    // A 2 px wide strip: left texel opaque red, right texel transparent. Sampling halfway between them mixes premultiplied colours.
    const mix = (right: [number, number, number, number]) => {
      const left = [255, 0, 0, 255];
      // premultiplied bilinear = average of premultiplied values; then un-premultiply.
      const a = (left[3] + right[3]) / 2;
      const r = (left[0] * left[3] + right[0] * right[3]) / 2 / 255;
      return a > 0 ? (r / a) * 255 : 0;
    };
    // Engines that filter straight (non-premultiplied) data average the colour channels first: with black under alpha 0 the red darkens.
    const straight = (rightRgb: number) => (255 + rightRgb) / 2;
    expect(straight(0)).toBeLessThan(140);
    expect(straight(255)).toBeGreaterThan(250);
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
    bleedTransparent(data, 2, 1);
    expect(straight(data[4])).toBeGreaterThan(250);
    expect(mix([data[4], data[5], data[6], 0])).toBe(255);
  });
});

describe('metadata round trip', () => {
  const originals = [frame(0, 12, 10), frame(1, 12, 10, { x: 4, y: 2, w: 3, h: 5 }), frame(2, 12, 10), frame(3, 12, 10, { x: 0, y: 0, w: 12, h: 10 }), frame(4, 12, 10, { x: 6, y: 6, w: 1, h: 1 }), frame(5, 12, 10)];
  const durations = [100, 100, 200, 100, 50, 100];

  function input(b: ReturnType<typeof buildSheets>): SheetMetaInput {
    return {
      baseName: 'hero',
      images: b.pages.map((_, i) => `hero${i ? `_${i + 1}` : ''}.png`),
      build: b,
      durationsMs: durations,
      tags: [{ name: 'idle', from: 0, to: 2, direction: 'forward' }, { name: 'run', from: 3, to: 5, direction: 'pingpong' }],
      fps: 10,
      loop: true,
      padding: 0,
      extrude: 0,
      pivot: [0.5, 1],
    };
  }

  function replay(desc: SheetDescription, pages: Bitmap[]): Bitmap[] {
    // What Sprite Sheet In does: cut each rectangle, put it back at its offset in the source-size frame.
    return desc.frames.map((f) => {
      const data = new Uint8ClampedArray(f.srcW * f.srcH * 4);
      const pg = pages[0];
      for (let y = 0; y < f.h; y++) data.set(pg.data.subarray(((f.y + y) * pg.width + f.x) * 4, ((f.y + y) * pg.width + f.x + f.w) * 4), ((f.offY + y) * f.srcW + f.offX) * 4);
      return { width: f.srcW, height: f.srcH, data };
    });
  }

  for (const format of ['json', 'aseprite', 'texturepacker'] as SheetMetaFormat[]) {
    for (const opts of [{}, { trim: true, layout: 'pack', padding: 1, extrude: 1 }, { trim: true, powerOfTwo: true, columns: 3 }] as const) {
      it(`${format} ${JSON.stringify(opts)}: export then read back reproduces the frames pixel for pixel`, () => {
        const b = buildSheets(originals, opts as never);
        const files = writeSheetMeta(format, { ...input(b), padding: (opts as { padding?: number }).padding ?? 0, extrude: (opts as { extrude?: number }).extrude ?? 0 });
        expect(files).toHaveLength(1);
        const desc = parseSheetJson(files[0].text);
        expect(desc.frames).toHaveLength(originals.length);
        const back = replay(desc, b.pages);
        back.forEach((f, i) => expect(same(f, originals[i]), `frame ${i}`).toBe(true));
        if (format !== 'texturepacker') {
          expect(desc.frames.map((f) => f.durationMs)).toEqual(durations);
          expect(desc.tags.map((t) => [t.name, t.from, t.to])).toEqual([['idle', 0, 2], ['run', 3, 5]]);
        }
        if (format === 'aseprite') expect(desc.tags[1].direction).toBe('pingpong');
        expect(desc.image).toBe('hero.png');
      });
    }
  }

  it('the generic json keeps every key older versions wrote', () => {
    const b = buildSheets(frames(12, 64, 48), { columns: 4, padding: 2 });
    const [file] = writeSheetMeta('json', { ...input(b), durationsMs: Array(12).fill(100), tags: [], padding: 2 });
    const meta = JSON.parse(file.text);
    expect(meta).toMatchObject({ frameCount: 12, columns: 4, rows: 3, frameWidth: 64, frameHeight: 48, padding: 2, width: 4 * 64 + 3 * 2, height: 3 * 48 + 2 * 2, fps: 10, loop: true, frameDuration: 0.1 });
    expect(meta.frames[5]).toMatchObject({ index: 5, x: 66, y: 50, w: 64, h: 48, duration: 0.1 });
  });

  it('multi page sheets write one file per page for the formats that cannot list pages, one json for the generic format', () => {
    const b = buildSheets(frames(20), { maxSize: 40 });
    expect(b.pages.length).toBeGreaterThan(1);
    expect(writeSheetMeta('json', { ...input(b), durationsMs: Array(20).fill(100), tags: [] })).toHaveLength(1);
    const ase = writeSheetMeta('aseprite', { ...input(b), durationsMs: Array(20).fill(100), tags: [] });
    expect(ase).toHaveLength(b.pages.length);
    expect(ase[1].suffix).toBe('_2');
    expect(parseSheetJson(ase[1].text).frames.length).toBe(b.frames.filter((f) => f.page === 1).length);
  });

  it('css has a class per frame and keyframes per tag', () => {
    const b = buildSheets(originals);
    const [file] = writeSheetMeta('css', input(b));
    expect(file.ext).toBe('css');
    expect(file.text).toContain('.hero-0 {');
    expect(file.text).toContain('@keyframes hero-idle');
    expect(file.text).toContain('animation-timing-function: steps(1, end)');
  });
});

describe('slicing', () => {
  it('grid by count and by size, with margin and spacing', () => {
    const f = sliceGrid(100, 50, { by: 'count', columns: 4, rows: 2, cellWidth: 0, cellHeight: 0, margin: 0, spacing: 0 });
    expect(f).toHaveLength(8);
    expect(f[5]).toMatchObject({ x: 25, y: 25, w: 25, h: 25 });
  });

  it('grid by size drops cells that do not fit', () => {
    const g = sliceGrid(70, 36, { by: 'size', columns: 0, rows: 0, cellWidth: 16, cellHeight: 16, margin: 2, spacing: 2 });
    expect(g.length).toBe(Math.floor((66 + 2) / 18) * Math.floor((32 + 2) / 18));
    expect(g[1]).toMatchObject({ x: 20, y: 2 });
  });

  it('auto slicing finds sprites by their gaps, in reading order', () => {
    const w = 40;
    const h = 24;
    const d = new Uint8ClampedArray(w * h * 4);
    const box = (x0: number, y0: number, bw: number, bh: number) => {
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) d.set([255, 0, 0, 255], (y * w + x) * 4);
    };
    box(20, 2, 6, 8); // top row, second by x
    box(3, 3, 5, 6); // top row, first
    box(30, 14, 4, 4); // second row
    box(8, 14, 6, 7);
    d.set([255, 255, 255, 255], (22 * w + 38) * 4); // a stray pixel
    const f = sliceAuto(d, w, h, { alphaThreshold: 0, gap: 0, minSize: 2, padding: 0 });
    expect(f.map((r) => [r.x, r.y, r.w, r.h])).toEqual([[3, 3, 5, 6], [20, 2, 6, 8], [8, 14, 6, 7], [30, 14, 4, 4]]);
    const keep = sliceAuto(d, w, h, { alphaThreshold: 0, gap: 0, minSize: 1, padding: 1 });
    expect(keep).toHaveLength(5);
    expect(keep[0]).toMatchObject({ x: 2, y: 2, w: 7, h: 8 });
  });

  it('auto slicing joins pieces closer than the gap', () => {
    const w = 20;
    const d = new Uint8ClampedArray(w * 8 * 4);
    for (const [x, y] of [[2, 2], [2, 3], [6, 3], [7, 3]]) d.set([0, 0, 0, 255], (y * w + x) * 4);
    expect(sliceAuto(d, w, 8, { alphaThreshold: 0, gap: 0, minSize: 1, padding: 0 })).toHaveLength(2);
    const joined = sliceAuto(d, w, 8, { alphaThreshold: 0, gap: 3, minSize: 1, padding: 0 });
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ x: 2, y: 2, w: 6, h: 2 });
  });

  it('TexturePacker hash and Aseprite array with trimmed frames', () => {
    const hash = JSON.stringify({
      frames: {
        'a.png': { frame: { x: 0, y: 0, w: 10, h: 8 }, rotated: false, trimmed: true, spriteSourceSize: { x: 3, y: 2, w: 10, h: 8 }, sourceSize: { w: 16, h: 16 } },
        'b.png': { frame: { x: 10, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 }, sourceSize: { w: 16, h: 16 } },
      },
      meta: { image: 'x.png', size: { w: 26, h: 16 } },
    });
    const d = parseSheetJson(hash);
    expect(d.frames[0]).toMatchObject({ name: 'a.png', x: 0, w: 10, offX: 3, offY: 2, srcW: 16, srcH: 16 });
    expect(d.frames[1].x).toBe(10);
    const ase = JSON.stringify({
      frames: [{ filename: 'f 0', frame: { x: 0, y: 0, w: 4, h: 4 }, duration: 80 }, { filename: 'f 1', frame: { x: 4, y: 0, w: 4, h: 4 }, duration: 120 }],
      meta: { image: 's.png', frameTags: [{ name: 'walk', from: 0, to: 1, direction: 'reverse' }] },
    });
    const a = parseSheetJson(ase);
    expect(a.frames.map((f) => f.durationMs)).toEqual([80, 120]);
    expect(a.tags[0]).toMatchObject({ name: 'walk', direction: 'reverse' });
    expect(tagFrames(a.tags[0])).toEqual([1, 0]);
  });

  it('rejects rotated frames and non-metadata json with a readable message', () => {
    expect(() => parseSheetJson('{"frames":{"a":{"frame":{"x":0,"y":0,"w":1,"h":1},"rotated":true}}}')).toThrow(/rotated/);
    expect(() => parseSheetJson('{"a":1}')).toThrow(/frames/);
    expect(() => parseSheetJson('nope')).toThrow(/JSON/);
  });
});

describe('selection and timing', () => {
  it('index lists and orders', () => {
    expect(parseIndexList('0,1,2,1', 4)).toEqual([0, 1, 2, 1]);
    expect(parseIndexList('2-4, 7, 9', 8)).toEqual([2, 3, 4, 7]);
    expect(parseIndexList('3-1', 8)).toEqual([3, 2, 1]);
    expect(orderFrames(6, 'column', 3, '')).toEqual([0, 3, 1, 4, 2, 5]);
    expect(orderFrames(4, 'custom', 2, '3,3,0')).toEqual([3, 3, 0]);
    expect(orderFrames(4, 'custom', 2, 'x')).toEqual([0, 1, 2, 3]);
  });

  it('timeline: fps, metadata durations, ping-pong, loop and hold', () => {
    const t = buildTimeline([0, 1, 2], () => 0, false, 10, false);
    expect([0, 0.05, 0.1, 0.25, 0.3, 0.35].map((s) => entryAt(t, s, true).frame)).toEqual([0, 0, 1, 2, 0, 0]);
    expect(entryAt(t, 5, false).frame).toBe(2);
    const m = buildTimeline([0, 1], (f) => (f === 0 ? 300 : 100), true, 10, false);
    expect([0, 0.29, 0.3, 0.39, 0.4].map((s) => entryAt(m, s, true).frame)).toEqual([0, 0, 1, 1, 0]);
    const pp = buildTimeline([0, 1, 2], () => 0, false, 10, true);
    expect(pp.map((e) => e.frame)).toEqual([0, 1, 2, 1]);
    const held = buildTimeline([0, 1], () => 0, false, 10, false);
    expect(entryAt(held, 0.35, true, 0.5).frame).toBe(1);
    expect(entryAt(held, 0.65, true, 0.5).frame).toBe(1);
    expect(entryAt(held, 0.75, true, 0.5).frame).toBe(0);
  });

  it('opaqueBounds', () => {
    const f = frame(0, 10, 10, { x: 2, y: 3, w: 4, h: 2 });
    expect(opaqueBounds(f.data, 10, 10)).toEqual({ x: 2, y: 3, w: 4, h: 2 });
    expect(opaqueBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});

describe('png encoder and presets', () => {
  it('writes a PNG that decodes to the same straight RGBA, colour under alpha 0 included', async () => {
    const w = 5;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([(i * 17) & 255, (i * 31) & 255, (i * 47) & 255, i % 3 === 0 ? 0 : i % 3 === 1 ? 128 : 255], i * 4);
    const png = await encodePngRgba(data, w, h);
    const back = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([back.info.width, back.info.height, back.info.channels]).toEqual([w, h, 4]);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });

  it('presets only override their own fields, generic changes nothing', () => {
    const s = { layout: 'pack' as const, columns: 5, padding: 3, extrude: 2, trim: true, powerOfTwo: false, maxSize: 512, bleed: false, meta: 'aseprite' as const };
    expect(applyPreset('generic', s)).toBe(s);
    expect(applyPreset('unity', s)).toMatchObject({ powerOfTwo: true, layout: 'grid', maxSize: 512, columns: 5 });
    expect(applyPreset('gamemaker', s).layout).toBe('row');
    expect(applyPreset('rpgmaker', s).columns).toBe(3);
    expect(applyPreset('web', s).meta).toBe('css');
  });
});
