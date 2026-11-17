/** Game asset export through the CLI renderer: packed / trimmed / extruded sheets, metadata formats, one sheet from a batch, bleed, the report. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseSheetJson } from '../../engine/lib/sprite-sheet';
import { testGpu } from '../../engine/testing';
import type { Gpu } from '../../engine/gpu/gpu';
import { assignInputs } from '../prepare';
import { renderGraphBatch } from '../render';
import { addNode, builtinRegistry, chain, connect, readRaw, tempDir, writeSprite } from './testkit';

const registry = builtinRegistry();
let gpu: Gpu;
beforeAll(async () => {
  gpu = await testGpu();
}, 60_000);

async function animated(outParams: Record<string, unknown>) {
  const c = chain(registry, [{ type: 'shape', params: { kind: 'ellipse', width: 0.3, height: 0.4, fill: [1, 0, 0, 1] } }], { width: 64, height: 48, fps: 12, duration: 0.5 }, outParams);
  const added = addNode(c.graph, registry, 'animate', { x: 0, y: 0 }, { from: 0.3, to: 0.7, wave: 'sine' });
  return connect(added.graph, registry, { node: added.node.id, port: 'value' }, { node: c.ids[0], port: 'x' });
}

describe('game sheets', () => {
  it('packed + trimmed + extruded + power-of-two sheet with Aseprite JSON reproduces every frame exactly', async () => {
    const outA = tempDir();
    const outB = tempDir();
    const seq = await renderGraphBatch({ graph: await animated({ kind: 'sequence', name: 'ball' }), registry, outDir: outA, sequenceFps: 12, gpu });
    expect(seq.errors).toEqual([]);
    const sheet = await renderGraphBatch({
      graph: await animated({ kind: 'spritesheet', name: 'sheet', sheetLayout: 'pack', sheetTrim: true, extrude: 1, padding: 2, powerOfTwo: true, sheetMeta: 'aseprite' }),
      registry,
      outDir: outB,
      sequenceFps: 12,
      gpu,
    });
    expect(sheet.errors).toEqual([]);
    expect(readdirSync(outB).sort()).toEqual(['sheet.json', 'sheet.png']);
    const desc = parseSheetJson(readFileSync(join(outB, 'sheet.json'), 'utf8'));
    const img = await readRaw(join(outB, 'sheet.png'));
    expect([img.width & (img.width - 1), img.height & (img.height - 1)]).toEqual([0, 0]); // powers of two
    expect(desc.frames).toHaveLength(6);
    expect(desc.frames.every((f) => f.w < 64 && f.h < 48)).toBe(true); // trimmed
    expect(desc.tags.map((t) => [t.from, t.to])).toEqual([[0, 5]]);
    const files = readdirSync(join(outA, 'ball')).sort();
    for (let i = 0; i < files.length; i++) {
      const ref = await readRaw(join(outA, 'ball', files[i]));
      const f = desc.frames[i];
      let bad = 0;
      for (let y = 0; y < f.srcH; y++) {
        for (let x = 0; x < f.srcW; x++) {
          const inside = x >= f.offX && x < f.offX + f.w && y >= f.offY && y < f.offY + f.h;
          const got = inside ? img.at(f.x + x - f.offX, f.y + y - f.offY) : [0, 0, 0, 0];
          const want = ref.at(x, y);
          if (got[3] !== want[3] || (want[3] > 0 && got.slice(0, 3).some((v, k) => v !== want[k]))) bad++;
        }
      }
      expect(bad, `frame ${i}`).toBe(0);
    }
  });

  it('single row, TexturePacker JSON, CSS and several pages', async () => {
    const out = tempDir();
    await renderGraphBatch({ graph: await animated({ kind: 'spritesheet', name: 'row', sheetLayout: 'row', sheetMeta: 'texturepacker' }), registry, outDir: out, sequenceFps: 12, gpu });
    const m = await sharp(join(out, 'row.png')).metadata();
    expect([m.width, m.height]).toEqual([6 * 64, 48]);
    expect(Object.keys(JSON.parse(readFileSync(join(out, 'row.json'), 'utf8')).frames)).toHaveLength(6);
    const css = tempDir();
    await renderGraphBatch({ graph: await animated({ kind: 'spritesheet', name: 'web', preset: 'web' }), registry, outDir: css, sequenceFps: 12, gpu });
    expect(readFileSync(join(css, 'web.css'), 'utf8')).toContain('.web-5 {');
    const pages = tempDir();
    await renderGraphBatch({ graph: await animated({ kind: 'spritesheet', name: 'pg', maxSheet: 128, sheetMeta: 'json' }), registry, outDir: pages, sequenceFps: 12, gpu });
    const names = readdirSync(pages).sort();
    expect(names).toEqual(['pg.json', 'pg.png', 'pg_2.png']);
    const meta = JSON.parse(readFileSync(join(pages, 'pg.json'), 'utf8'));
    expect(meta.images).toEqual(['pg.png', 'pg_2.png']);
    expect(meta.frames.map((f: { page: number }) => f.page)).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it('presets: Unity makes power-of-two pages, GameMaker a strip; a preset beats the node params', async () => {
    const out = tempDir();
    await renderGraphBatch({ graph: await animated({ kind: 'spritesheet', name: 'u', preset: 'unity', columns: 5 }), registry, outDir: out, sequenceFps: 12, gpu });
    const m = await sharp(join(out, 'u.png')).metadata();
    expect([m.width! & (m.width! - 1), m.height! & (m.height! - 1)]).toEqual([0, 0]);
    const gm = tempDir();
    await renderGraphBatch({ graph: await animated({ kind: 'spritesheet', name: 'g', preset: 'gamemaker', sheetLayout: 'grid', columns: 2, sheetMeta: 'json' }), registry, outDir: gm, sequenceFps: 12, gpu });
    expect(readdirSync(gm)).toEqual(['g.png']); // strip, and no metadata file
    expect((await sharp(join(gm, 'g.png')).metadata()).height).toBe(48);
  });

  it('CLI style overrides reach every spritesheet output', async () => {
    const out = tempDir();
    await renderGraphBatch({ graph: await animated({ kind: 'spritesheet', name: 's' }), registry, outDir: out, sequenceFps: 12, gpu, overrides: { outputParams: { sheetLayout: 'column', sheetMeta: 'none' } } });
    expect(readdirSync(out)).toEqual(['s.png']);
    expect((await sharp(join(out, 's.png')).metadata()).width).toBe(64);
  });
});

describe('batch sheet, bleed, report', () => {
  async function twoSprites() {
    const dir = tempDir();
    await writeSprite(join(dir, 'hero.png'), 16, 16, '#ff0000');
    await writeSprite(join(dir, 'slime.png'), 16, 16, '#00ff00');
    return [join(dir, 'hero.png'), join(dir, 'slime.png')];
  }

  it('one sheet from every batch item, one tag per item named after its file', async () => {
    const files = await twoSprites();
    const c = chain(registry, [{ type: 'media-in' }], { width: 16, height: 16, fps: 12, duration: 0.25 }, { kind: 'spritesheet', name: 'set', sheetFrom: 'batch', sheetMeta: 'aseprite', sheetLayout: 'row' });
    const graph = assignInputs(c.graph, registry, { positional: files, targeted: [], recursive: false, sequence: false }).graph;
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    expect(readdirSync(out).sort()).toEqual(['set.json', 'set.png']);
    const desc = parseSheetJson(readFileSync(join(out, 'set.json'), 'utf8'));
    expect(desc.frames).toHaveLength(6);
    expect(desc.tags.map((t) => [t.name, t.from, t.to])).toEqual([['hero', 0, 2], ['slime', 3, 5]]);
    const img = await readRaw(join(out, 'set.png'));
    expect(img.at(8, 8)[0]).toBeGreaterThan(img.at(8, 8)[1]); // the first item is the red sprite
    expect(img.at(3 * 16 + 8, 8)[1]).toBeGreaterThan(img.at(3 * 16 + 8, 8)[0]); // the fourth frame is the green one
  });

  it('bleed writes the nearest opaque color under transparent pixels; without it they are black', async () => {
    const files = await twoSprites();
    const run = async (bleed: boolean) => {
      const c = chain(registry, [{ type: 'media-in' }], { width: 16, height: 16, fps: 12, duration: 1 / 12 }, { kind: 'image', name: '{name}', bleed });
      const graph = assignInputs(c.graph, registry, { positional: [files[0]], targeted: [], recursive: false, sequence: false }).graph;
      const out = tempDir();
      await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
      return readRaw(join(out, 'hero.png'));
    };
    const plain = await run(false);
    const bled = await run(true);
    expect(plain.at(0, 0)).toEqual([0, 0, 0, 0]);
    expect(bled.at(0, 0)[3]).toBe(0);
    expect(bled.at(0, 0)[0]).toBeGreaterThan(200); // the red of the disc, not black
    expect(bled.at(8, 8)).toEqual(plain.at(8, 8)); // opaque pixels are untouched
  });

  it('a report lists size, colors, frames and the off-palette fraction from a Palette Lock in report mode', async () => {
    const files = await twoSprites();
    const c = chain(registry, [{ type: 'media-in' }, { type: 'palette-lock', params: { mode: 'report', builtin: 'pico-8' } }], { width: 16, height: 16, fps: 12, duration: 1 / 12 }, { kind: 'image', name: '{name}' });
    const graph = assignInputs(c.graph, registry, { positional: files, targeted: [], recursive: false, sequence: false }).graph;
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu, report: 'json' });
    expect(sum.errors).toEqual([]);
    expect(existsSync(join(out, 'export-report.json'))).toBe(true);
    const rep = JSON.parse(readFileSync(join(out, 'export-report.json'), 'utf8')) as { files: { file: string; colors: number; offPalette: number; frames: number; bytes: number; width: number }[] };
    expect(rep.files.map((f) => f.file)).toEqual(['hero.png', 'slime.png']);
    for (const f of rep.files) {
      expect(f.colors).toBeGreaterThan(0);
      expect(f.offPalette).toBeGreaterThan(0); // the half-transparent disc color is not a pico-8 color
      expect(f.offPalette).toBeLessThanOrEqual(1);
      expect(f.frames).toBe(1);
      expect(f.bytes).toBeGreaterThan(50);
      expect(f.width).toBe(16);
    }
    const text = tempDir();
    await renderGraphBatch({ graph, registry, outDir: text, sequenceFps: 12, gpu, report: 'text' });
    expect(readFileSync(join(text, 'export-report.txt'), 'utf8')).toContain('hero.png | image | 16x16 | 1 |');
  });
});
