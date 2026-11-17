/**
 * The app exporter's CPU sprite sheet path on the real GPU: it needs no canvas because it writes PNGs with its own encoder.
 * The plain grid path copies on the GPU and encodes through an OffscreenCanvas, which Node does not have: it is not run here.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseSheetJson } from '../engine/lib/sprite-sheet';
import { addNode, connect, createGraph } from '../engine/graph';
import { harness } from '../engine/testing';
import type { GraphDoc } from '../engine/types';
import type { ExportRequest } from './api';
import { ExporterImpl } from './exporter';
import { EvalGate } from './gate';

async function setup(outParams: Record<string, unknown>) {
  const t = await harness();
  let g: GraphDoc = createGraph('hero');
  g = { ...g, project: { ...g.project, width: 32, height: 24, fps: 10, duration: 0.5, loop: true, lengthMode: 'absolute' } };
  const shape = addNode(g, t.registry, 'shape', { x: 0, y: 0 }, { kind: 'ellipse', width: 0.3, height: 0.4, fill: [1, 0, 0, 1] });
  const anim = addNode(shape.graph, t.registry, 'animate', { x: 0, y: 0 }, { from: 0.3, to: 0.7, wave: 'sine' });
  const out = addNode(anim.graph, t.registry, 'image-out', { x: 0, y: 0 }, { name: 'sheet', kind: 'spritesheet', ...outParams });
  g = connect(out.graph, t.registry, { node: anim.node.id, port: 'value' }, { node: shape.node.id, port: 'x' });
  g = connect(g, t.registry, { node: shape.node.id, port: 'image' }, { node: out.node.id, port: 'image' });
  const library = { exact: false, setFrameBudget: () => 0, assetInfo: () => null };
  const exporter = new ExporterImpl({ gpu: t.gpu, gate: new EvalGate(t.engine), registry: t.registry, library, audio: { hasSignals: () => false } } as never);
  const req: ExportRequest = { graph: g, outputs: [out.node.id], items: 'current', item: 0, zip: false };
  return { exporter, req };
}

describe('app exporter: sprite sheets', () => {
  it('packed, trimmed, extruded, power-of-two sheet with Aseprite JSON through the app path', async () => {
    const { exporter, req } = await setup({ sheetLayout: 'pack', sheetTrim: true, extrude: 1, padding: 1, powerOfTwo: true, sheetMeta: 'aseprite', bleed: true });
    const files = await (exporter as unknown as { run(r: ExportRequest): Promise<{ name: string; blob: Blob }[]> }).run(req);
    expect(files.map((f) => f.name).sort()).toEqual(['sheet.json', 'sheet.png']);
    const png = Buffer.from(await files.find((f) => f.name === 'sheet.png')!.blob.arrayBuffer());
    const m = await sharp(png).metadata();
    expect([m.width! & (m.width! - 1), m.height! & (m.height! - 1)]).toEqual([0, 0]);
    const desc = parseSheetJson(await files.find((f) => f.name === 'sheet.json')!.blob.text());
    expect(desc.frames).toHaveLength(5);
    expect(desc.frames.every((f) => f.srcW === 32 && f.srcH === 24 && f.w < 32)).toBe(true);
    // bleed: the colour under transparent pixels is not black
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(0);
    expect(raw[0]).toBeGreaterThan(200);
  });

  it('a preset beats the sheet params set on the Output (GameMaker: one row, no metadata file)', async () => {
    const { exporter, req } = await setup({ preset: 'gamemaker', sheetMeta: 'css' });
    const files = await (exporter as unknown as { run(r: ExportRequest): Promise<{ name: string; blob: Blob }[]> }).run(req);
    expect(files.map((f) => f.name)).toEqual(['sheet.png']); // the preset says no metadata
    const m = await sharp(Buffer.from(await files[0].blob.arrayBuffer())).metadata();
    expect([m.width, m.height]).toEqual([5 * 32, 24]);
  });
});
