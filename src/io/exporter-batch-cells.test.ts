/**
 * Sprite Sheet In "Batch items" through the app exporter: a 6-cell sheet makes the batch 6 items by itself (`NodeDef.batchSize`), item i is cell i,
 * "each clip" writes one file per cell and "all batch items" re-packs the cells into ONE sheet.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseSheetJson } from '../engine/lib/sprite-sheet';
import { addNode, batchCount, connect, createGraph } from '../engine/graph';
import { harness } from '../engine/testing';
import type { GraphDoc, ImageValue } from '../engine/types';
import type { ExportRequest } from './api';
import { ExporterImpl } from './exporter';
import { EvalGate } from './gate';

const COLORS: [number, number, number, number][] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255], [0, 255, 255, 255], [255, 0, 255, 255]];

async function setup(outParams: Record<string, unknown>) {
  const t = await harness();
  const sheet = t.fromFn(48, 8, (x) => COLORS[Math.floor(x / 8)]);
  const src = t.source(sheet);
  let g: GraphDoc = createGraph('hero');
  g = { ...g, project: { ...g.project, width: 8, height: 8, fps: 10, duration: 0.1, loop: false, lengthMode: 'absolute' } };
  const s = addNode(g, t.registry, src);
  const cells = addNode(s.graph, t.registry, 'sprite-sheet-in', { x: 0, y: 0 }, { columns: 6, rows: 1, as: 'items' });
  const out = addNode(cells.graph, t.registry, 'image-out', { x: 0, y: 0 }, { name: 'sheet', kind: 'spritesheet', ...outParams });
  g = connect(out.graph, t.registry, { node: s.node.id, port: 'out' }, { node: cells.node.id, port: 'image' });
  g = connect(g, t.registry, { node: cells.node.id, port: 'image' }, { node: out.node.id, port: 'image' });
  const library = { exact: false, setFrameBudget: () => 0, assetInfo: () => null };
  const exporter = new ExporterImpl({ gpu: t.gpu, gate: new EvalGate(t.engine), registry: t.registry, library, audio: { hasSignals: () => false } } as never);
  const req: ExportRequest = { graph: g, outputs: [out.node.id], items: 'all', item: 0, zip: false };
  const run = (r: ExportRequest) => (exporter as unknown as { run(r: ExportRequest): Promise<{ name: string; blob: Blob }[]> }).run(r);
  return { t, g, req, run, cells: cells.node.id };
}

describe('Sprite Sheet In: cells as batch items', () => {
  it('a 6-cell grid makes 6 items by itself; item i renders cell i', async () => {
    const { t, g } = await setup({});
    expect(batchCount(g, t.registry)).toBe(6);
    const sheet = t.fromFn(48, 8, (x) => COLORS[Math.floor(x / 8)]);
    for (let i = 0; i < 6; i++) {
      const out = await t.run('sprite-sheet-in', { columns: 6, rows: 1, as: 'items' }, { image: sheet }, { item: i, itemCount: 6 });
      expect((await t.pixels(out.image as ImageValue)).at(3, 3)).toEqual(COLORS[i]);
    }
  });

  it('nodes without batchSize and the other modes keep the old batch size', async () => {
    const { t, g } = await setup({});
    const anim = { ...g, nodes: g.nodes.map((n) => (n.type === 'sprite-sheet-in' ? { ...n, params: { ...n.params, as: 'animation' } } : n)) };
    expect(batchCount(anim, t.registry)).toBe(1);
    expect(batchCount(createGraph('x'), t.registry)).toBe(1);
  });

  it('range and custom order shorten the batch; cell size grids use "Items per sheet"; metadata counts its frames', async () => {
    const { t, g, cells } = await setup({});
    const set = (params: Record<string, unknown>): GraphDoc => ({ ...g, nodes: g.nodes.map((n) => (n.id === cells ? { ...n, params: { ...n.params, ...params } } : n)) });
    expect(batchCount(set({ range: '1-3' }), t.registry)).toBe(3);
    expect(batchCount(set({ order: 'custom', sequence: '5,4,3,2' }), t.registry)).toBe(4);
    expect(batchCount(set({ by: 'size' }), t.registry)).toBe(1); // unknown: falls back to the file lists
    expect(batchCount(set({ by: 'size', itemCount: 9 }), t.registry)).toBe(9);
    const meta = JSON.stringify({ frames: [0, 1, 2, 3, 4].map((i) => ({ filename: `f${i}`, frame: { x: i * 8, y: 0, w: 8, h: 8 }, duration: 100 })), meta: { size: { w: 40, h: 8 } } });
    expect(batchCount(set({ slicing: 'json', meta }), t.registry)).toBe(5);
    expect(batchCount(set({ slicing: 'json', meta: 'not json' }), t.registry)).toBe(1);
  });

  it('several sheet files multiply: item = sheet x cells + cell', async () => {
    const { t, g, cells } = await setup({});
    const two: GraphDoc = { ...g, nodes: g.nodes.map((n) => (n.id === cells ? { ...n, params: { ...n.params, assets: ['a', 'b'] } } : n)) };
    expect(batchCount(two, t.registry)).toBe(12);
  });

  it('export, each clip: one file per cell', async () => {
    const { req, run } = await setup({ sheetLayout: 'row', sheetMeta: 'none', sheetFrom: 'clip' });
    const files = await run(req);
    const pngs = files.filter((f) => f.name.endsWith('.png'));
    expect(pngs).toHaveLength(6);
    const reds: number[] = [];
    for (const f of pngs) {
      const raw = await sharp(Buffer.from(await f.blob.arrayBuffer())).ensureAlpha().raw().toBuffer();
      reds.push(raw[0] * 65536 + raw[1] * 256 + raw[2]);
    }
    expect(new Set(reds).size).toBe(6); // six different cells
  });

  it('export, all batch items: ONE sheet re-packs the six cells', async () => {
    const { req, run } = await setup({ sheetLayout: 'row', sheetMeta: 'aseprite', sheetFrom: 'batch' });
    const files = await run(req);
    expect(files.map((f) => f.name).sort()).toEqual(['sheet.json', 'sheet.png']);
    const png = Buffer.from(await files.find((f) => f.name === 'sheet.png')!.blob.arrayBuffer());
    const m = await sharp(png).metadata();
    expect([m.width, m.height]).toEqual([48, 8]);
    const desc = parseSheetJson(await files.find((f) => f.name === 'sheet.json')!.blob.text());
    expect(desc.frames).toHaveLength(6);
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < 6; i++) expect([...raw.subarray((3 * 48 + i * 8 + 3) * 4, (3 * 48 + i * 8 + 3) * 4 + 4)]).toEqual(COLORS[i]);
  });
});
