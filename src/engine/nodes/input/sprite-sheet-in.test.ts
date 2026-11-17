import { describe, expect, it, vi } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import type { ImageValue } from '../../types';
import { harness } from '../../testing';
import { buildSheets, extractFrames, type Bitmap } from '../../../io/spritesheet-pack';
import { writeSheetMeta } from '../../../io/spritesheet-meta';

/** A 4-cell strip: cell i is a solid colour of its own, 8x8 each. */
const COLORS: [number, number, number, number][] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
const P10 = { fps: 10, duration: 2 };
const strip = (t: Awaited<ReturnType<typeof harness>>) => t.fromFn(32, 8, (x) => COLORS[Math.floor(x / 8)]);

describe('sprite-sheet-in', () => {
  it('plays the cells of a grid at the frame rate and loops', async () => {
    const t = await harness();
    const sheet = strip(t);
    const seen: number[][] = [];
    for (const s of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
      const out = await t.run('sprite-sheet-in', { columns: 4, rows: 1, fps: 10 }, { image: sheet }, { seconds: s, project: P10 });
      const img = out.image as ImageValue;
      expect([img.width, img.height, img.unit]).toEqual([8, 8, 1]);
      seen.push((await t.pixels(img)).at(3, 3).slice(0, 3));
    }
    expect(seen).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 0], [0, 255, 0]]);
  });

  it('reports frame and count, ping-pong, loop off, hold and custom order', async () => {
    const t = await harness();
    const sheet = strip(t);
    const at = async (params: Record<string, unknown>, s: number) => (await t.run('sprite-sheet-in', { columns: 4, rows: 1, fps: 10, ...params }, { image: sheet }, { seconds: s, project: P10 })).frame;
    expect(await at({}, 0.2)).toBe(2);
    expect((await t.run('sprite-sheet-in', { columns: 4, rows: 1 }, { image: sheet })).count).toBe(4);
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((s) => s)).toHaveLength(7);
    const pp: number[] = [];
    for (const s of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) pp.push((await at({ pingPong: true }, s)) as number);
    expect(pp).toEqual([0, 1, 2, 3, 2, 1, 0, 1]);
    expect(await at({ loop: false }, 1.9)).toBe(3);
    expect(await at({ order: 'custom', sequence: '3,3,0' }, 0.1)).toBe(3);
    expect(await at({ order: 'custom', sequence: '3,3,0' }, 0.2)).toBe(0);
    expect(await at({ range: '1-2' }, 0.1)).toBe(2);
    expect(await at({ hold: 1 }, 0.7)).toBe(3);
  });

  it('batch items: item N shows cell N', async () => {
    const t = await harness();
    const sheet = strip(t);
    for (let i = 0; i < 4; i++) {
      const out = await t.run('sprite-sheet-in', { columns: 4, rows: 1, as: 'items' }, { image: sheet }, { item: i, itemCount: 4, seconds: 0.5 });
      expect((await t.pixels(out.image as ImageValue)).at(0, 0).slice(0, 3)).toEqual(COLORS[i].slice(0, 3));
      expect(out.frame).toBe(i);
    }
  });

  it('grid by cell size with margin and spacing', async () => {
    const t = await harness();
    // 2 columns of 6x6 cells, margin 1, spacing 2: x0 = 1, x1 = 9.
    const sheet = t.fromFn(17, 8, (x, y) => (x >= 1 && x < 7 && y >= 1 && y < 7 ? [255, 0, 0, 255] : x >= 9 && x < 15 && y >= 1 && y < 7 ? [0, 0, 255, 255] : [0, 0, 0, 0]));
    const p = { by: 'size', cellWidth: 6, cellHeight: 6, margin: 1, spacing: 2, fps: 1 };
    const a = await t.run('sprite-sheet-in', p, { image: sheet }, { seconds: 0, project: P10 });
    const b = await t.run('sprite-sheet-in', p, { image: sheet }, { seconds: 1, project: P10 });
    expect([a.count, (a.image as ImageValue).width]).toEqual([2, 6]);
    expect((await t.pixels(a.image as ImageValue)).at(0, 0)).toEqual([255, 0, 0, 255]);
    expect((await t.pixels(b.image as ImageValue)).at(5, 5)).toEqual([0, 0, 255, 255]);
  });

  it('auto slicing finds sprites by their gaps and pads them to one cell', async () => {
    const t = await harness();
    const sheet = t.fromFn(30, 12, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [255, 0, 0, 255] : x >= 12 && x < 20 && y >= 1 && y < 11 ? [0, 255, 0, 255] : [0, 0, 0, 0]));
    const first = await t.run('sprite-sheet-in', { slicing: 'auto', fps: 1, anchor: 'bottom-left' }, { image: sheet }, { seconds: 0, project: P10 });
    const img = first.image as ImageValue;
    expect([first.count, img.width, img.height]).toEqual([2, 8, 10]);
    const px = await t.pixels(img);
    expect(px.at(0, 9)).toEqual([255, 0, 0, 255]); // 4x4 sprite sits in the bottom-left corner
    expect(px.at(0, 5)[3]).toBe(0);
    expect(px.at(5, 9)[3]).toBe(0);
    const second = await t.run('sprite-sheet-in', { slicing: 'auto', fps: 1 }, { image: sheet }, { seconds: 1, project: P10 });
    expect((await t.pixels(second.image as ImageValue)).at(7, 0)).toEqual([0, 255, 0, 255]);
  });

  it('trim borders cuts every cell to its opaque pixels', async () => {
    const t = await harness();
    const sheet = t.fromFn(16, 8, (x, y) => ((x === 2 && y === 3) || (x === 9 && y === 5) || (x === 10 && y === 5) ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = await t.run('sprite-sheet-in', { columns: 2, rows: 1, trim: true, fps: 1 }, { image: sheet }, { seconds: 0, project: P10 });
    expect([(out.image as ImageValue).width, (out.image as ImageValue).height]).toEqual([2, 1]); // the widest trimmed cell
    expect((await t.pixels(out.image as ImageValue)).at(0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('round trip: export with trim + pack + extrude, read the JSON back, every frame is pixel exact', async () => {
    const t = await harness();
    const originals: Bitmap[] = [0, 1, 2, 3, 4].map((seed) => {
      const w = 10;
      const h = 9;
      const data = new Uint8ClampedArray(w * h * 4);
      const x0 = 1 + (seed % 3);
      const y0 = 1 + (seed % 2);
      for (let y = y0; y < h - 2; y++) for (let x = x0; x < w - 2 - (seed % 2); x++) data.set([(seed * 50 + x * 9) & 255, (y * 20) & 255, (seed * 70) & 255, 255], (y * w + x) * 4);
      return { width: w, height: h, data };
    });
    const build = buildSheets(originals, { layout: 'pack', trim: true, extrude: 1, padding: 1 });
    const [file] = writeSheetMeta('aseprite', {
      baseName: 'hero',
      images: ['hero.png'],
      build,
      durationsMs: [100, 100, 100, 100, 100],
      tags: [{ name: 'walk', from: 1, to: 3, direction: 'forward' }],
      fps: 10,
      loop: true,
      padding: 1,
      extrude: 1,
      pivot: null,
    });
    const pg = build.pages[0];
    const sheet = t.fromFn(pg.width, pg.height, (x, y) => {
      const i = (y * pg.width + x) * 4;
      return [pg.data[i], pg.data[i + 1], pg.data[i + 2], pg.data[i + 3]];
    });
    const expected = extractFrames(build);
    for (let i = 0; i < 5; i++) {
      const out = await t.run('sprite-sheet-in', { slicing: 'json', meta: file.text, as: 'items' }, { image: sheet }, { item: i, itemCount: 5 });
      const px = await t.pixels(out.image as ImageValue);
      expect([px.width, px.height]).toEqual([10, 9]);
      let bad = 0;
      for (let k = 0; k < expected[i].data.length; k++) if (px.data[k] !== expected[i].data[k]) bad++;
      expect(bad, `frame ${i}`).toBe(0);
    }
    // The tag selects frames 1-3 and the count says so.
    const tagged = await t.run('sprite-sheet-in', { slicing: 'json', meta: file.text, tag: 'walk', fps: 10 }, { image: sheet }, { seconds: 0.1, project: P10 });
    expect([tagged.count, tagged.frame]).toEqual([3, 2]);
  });

  it('metadata durations drive the timing', async () => {
    const t = await harness();
    const sheet = strip(t);
    const meta = JSON.stringify({
      frames: COLORS.map((_, i) => ({ filename: `f${i}`, frame: { x: i * 8, y: 0, w: 8, h: 8 }, duration: i === 0 ? 500 : 100 })),
      meta: { image: 's.png' },
    });
    const at = async (s: number) => (await t.run('sprite-sheet-in', { slicing: 'json', meta, timing: 'meta', as: 'animation' }, { image: sheet }, { seconds: s, project: P10 })).frame;
    expect([await at(0.4), await at(0.5), await at(0.6), await at(0.7)]).toEqual([0, 1, 2, 3]);
  });

  it('slices once per sheet: playing the animation does not read the sheet again', async () => {
    const t = await harness();
    let g = createGraph('memo');
    const src = addNode(g, t.registry, t.source(t.fromFn(30, 12, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [255, 0, 0, 255] : x >= 12 && x < 20 && y >= 1 && y < 11 ? [0, 255, 0, 255] : [0, 0, 0, 0]))));
    g = src.graph;
    const node = addNode(g, t.registry, 'sprite-sheet-in', { x: 0, y: 0 }, { slicing: 'auto', fps: 2 });
    g = connect(node.graph, t.registry, { node: src.node.id, port: 'out' }, { node: node.node.id, port: 'image' });
    const spy = vi.spyOn(t.gpu, 'read');
    for (const s of [0, 0.5, 1, 1.5, 2]) await t.evalGraph(g, node.node.id, { seconds: s, port: 'image' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('says what is wrong instead of returning nothing', async () => {
    const t = await harness();
    await expect(t.run('sprite-sheet-in', {}, {})).rejects.toThrow(/Wire a picture/);
    await expect(t.run('sprite-sheet-in', { slicing: 'json', meta: '' }, { image: strip(t) })).rejects.toThrow(/metadata/i);
    await expect(t.run('sprite-sheet-in', { slicing: 'json', meta: '{"frames":[{"filename":"a","frame":{"x":40,"y":0,"w":8,"h":8}}]}' }, { image: strip(t) })).rejects.toThrow(/outside/);
  });
});
