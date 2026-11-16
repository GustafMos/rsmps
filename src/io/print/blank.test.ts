import { describe, expect, it } from 'vitest';
import { decodeHeader, encodeHeader } from './format';
import { exportBlankSheets, exportNextRound, gridForFramesPerSheet, planBlankSheets, resolveAspect, resolveFrameCount } from './blank';
import { pageHeader } from './layout';
import { cellRectMm, mmToPx } from './layout';
import { createRaster, type RasterImage } from './raster';
import { renderPage } from './render';
import { scanPage } from './scan/page';
import { assembleScan } from './scan/pipeline';
import { photograph } from './testkit.test-util';

const blank = createRaster(1, 1);

/** Paint a frame-specific colour block into every cell on the page (a stand-in for a drawing). */
function paintDrawings(page: RasterImage, sheet: ReturnType<typeof planBlankSheets>['sheet'], pageIndex: number, colorOf: (frame: number) => [number, number, number]): void {
  const g = sheet.geometry;
  const first = sheet.frameOffset + pageIndex * sheet.perPage;
  const count = Math.min(sheet.perPage, sheet.totalFrames - first);
  for (let k = 0; k < count; k++) {
    const r = cellRectMm(g, k % g.columns, Math.floor(k / g.columns));
    const x0 = Math.round(mmToPx(r.x + r.w * 0.3, sheet.dpi));
    const x1 = Math.round(mmToPx(r.x + r.w * 0.7, sheet.dpi));
    const y0 = Math.round(mmToPx(r.y + r.h * 0.3, sheet.dpi));
    const y1 = Math.round(mmToPx(r.y + r.h * 0.7, sheet.dpi));
    const c = colorOf(first + k);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) page.data.set([c[0], c[1], c[2], 255], (y * page.width + x) * 4);
  }
}

const colorOf = (f: number): [number, number, number] => [40 + ((f * 37) % 180), 40 + ((f * 83) % 180), 40 + ((f * 151) % 180)];

function centreMean(img: RasterImage): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(img.height * 0.4); y < Math.ceil(img.height * 0.6); y++)
    for (let x = Math.floor(img.width * 0.4); x < Math.ceil(img.width * 0.6); x++) {
      for (let c = 0; c < 3; c++) sum[c] += img.data[(y * img.width + x) * 4 + c];
      n++;
    }
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

describe('blank sheets planning', () => {
  it('resolves aspects and frame counts', () => {
    expect(resolveAspect('16:9')).toEqual({ width: 16, height: 9 });
    expect(resolveAspect('project', { width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
    expect(resolveAspect({ width: 3, height: 2 })).toEqual({ width: 3, height: 2 });
    expect(() => resolveAspect('wat')).toThrow(/Unknown frame aspect/);
    expect(resolveFrameCount({ seconds: 2, fps: 12 })).toBe(24);
    expect(() => resolveFrameCount({})).toThrow();
  });
  it('picks a grid for frames per sheet and plans pages', () => {
    const g = gridForFramesPerSheet({}, { width: 16, height: 9 }, 12);
    expect(g.columns * g.rows).toBeGreaterThanOrEqual(12);
    const plan = planBlankSheets({ frames: 50, aspect: '4:3', perSheet: 12, paper: 'a4' });
    expect(plan.perSheet).toBeGreaterThanOrEqual(12);
    expect(plan.pages).toBe(Math.ceil(50 / plan.perSheet));
    expect(plan.sheet.guide).toBe('blank');
  });
  it('writes a PDF and PNG pages, plus an exposure sheet', async () => {
    const files = await exportBlankSheets({ frames: 30, aspect: '16:9', paper: 'a4', dpi: 100, guides: ['thirds', 'cross'], ghostNumbers: true, exposureSheet: true, shootOn: 2, output: 'both', name: 'My blank' });
    const pdf = files.find((f) => f.name.endsWith('.pdf'))!;
    expect(pdf).toBeTruthy();
    const head = new Uint8Array(await pdf.blob.arrayBuffer()).slice(0, 5);
    expect(String.fromCharCode(...head)).toBe('%PDF-');
    expect(files.filter((f) => f.name.endsWith('.png')).length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => f.name.includes('exposure'))).toBe(true);
  });
});

describe('version 2 strip', () => {
  it('stays version 1 without layers or rounds and carries layer, round and blue guide otherwise', () => {
    const sheet = planBlankSheets({ frames: 6, perSheet: 6, aspect: '1:1' }).sheet;
    const h1 = pageHeader(sheet, 0);
    expect(decodeHeader(encodeHeader(h1))!.version).toBe(1);
    const h2 = pageHeader({ ...sheet, layer: 2, layerCount: 3, round: 1, blueGuide: true }, 0);
    const back = decodeHeader(encodeHeader(h2))!;
    expect(back.version).toBe(2);
    expect([back.layer, back.layerCount, back.round, back.blueGuide]).toEqual([2, 3, 1, true]);
    expect(back.firstFrame).toBe(h2.firstFrame);
  });
});

describe('blank sheets scan round trip', () => {
  it('frames drawn on printed blank sheets come back in order through the normal Scan code', async () => {
    const plan = planBlankSheets({ frames: 16, perSheet: 8, aspect: '4:3', paper: 'a4', dpi: 200, guides: ['grid', 'cross'], ghostNumbers: true, name: 'roundtrip' });
    const sheet = plan.sheet;
    expect(plan.pages).toBe(2);
    const photos: RasterImage[] = [];
    // second page first: order of photos must not matter
    for (const p of [1, 0]) {
      const page = renderPage(sheet, p, () => blank);
      paintDrawings(page, sheet, p, colorOf);
      photos.push((await photograph(page, { seed: 20 + p, rotateDeg: p ? -5 : 4, width: 2400, height: 3200 })).image);
    }
    const out = assembleScan(photos.map((im, i) => scanPage(im, `p${i}`, i)));
    expect(out.report.pages.map((p) => p.status)).not.toContain('failed');
    expect(out.report.totalFrames).toBe(16);
    expect(out.report.missingFrames).toEqual([]);
    expect(out.report.pages.find((p) => p.layout)!.layout!.guide).toBe('blank');
    for (let f = 0; f < 16; f++) {
      const img = out.frames[f];
      expect(img, `frame ${f}`).not.toBeNull();
      const m = centreMean(img!);
      const want = colorOf(f);
      for (let c = 0; c < 3; c++) expect(Math.abs(m[c] - want[c]), `frame ${f} channel ${c}`).toBeLessThan(28);
    }
  }, 120000);

  it('a next-round sheet joins the same project and replaces / appends frames by absolute number', async () => {
    const first = planBlankSheets({ frames: 8, perSheet: 8, aspect: '4:3', dpi: 200, name: 'rounds' });
    const page0 = renderPage(first.sheet, 0, () => blank);
    paintDrawings(page0, first.sheet, 0, colorOf);
    const photo0 = (await photograph(page0, { seed: 5, width: 2400, height: 3200 })).image;
    const scan0 = assembleScan([scanPage(photo0, 'r0', 0)]);
    expect(scan0.report.recoveredFrames).toBe(8);
    const previous = scan0.frames;
    const files = await exportNextRound({ previous, frames: 8, perSheet: 8, dpi: 200, name: 'rounds', projectId: first.sheet.projectId, output: 'png' });
    expect(files.length).toBe(1);
    // render the same round directly to scan it (the PNG is just that bitmap)
    const { planBlankSheets: plan2 } = await import('./blank');
    const p2 = plan2({ frames: 8, perSheet: 8, aspect: { width: previous[0]!.width, height: previous[0]!.height }, dpi: 200, name: 'rounds', frameOffset: 8, round: 1, projectId: first.sheet.projectId });
    expect(p2.sheet.totalFrames).toBe(16);
    const page1 = renderPage({ ...p2.sheet, guide: 'blank' }, 0, () => blank);
    const colour2 = (f: number) => colorOf(f + 5);
    paintDrawings(page1, p2.sheet, 0, colour2);
    const photo1 = (await photograph(page1, { seed: 6, width: 2400, height: 3200 })).image;
    const all = assembleScan([scanPage(photo0, 'r0', 0), scanPage(photo1, 'r1', 1)]);
    expect(all.report.totalFrames).toBe(16);
    expect(all.report.rounds).toBe(1);
    expect(all.report.missingFrames).toEqual([]);
    const m = centreMean(all.frames[12]!);
    const want = colour2(12);
    for (let c = 0; c < 3; c++) expect(Math.abs(m[c] - want[c])).toBeLessThan(28);
  }, 120000);
});

describe('paper layers', () => {
  it('two layers of the same frames are told apart by the strip and come back as separate layers', async () => {
    const base = planBlankSheets({ frames: 8, perSheet: 8, aspect: '4:3', dpi: 200, name: 'layers', projectId: 0x12345678 }).sheet;
    const mk = (layer: number) => ({ ...base, layer, layerCount: 2 });
    const sheets = [mk(0), mk(1)];
    const colours = [(f: number) => colorOf(f), (f: number) => colorOf(f + 40)];
    const photos: RasterImage[] = [];
    for (const l of [1, 0]) {
      const page = renderPage(sheets[l], 0, () => blank);
      paintDrawings(page, sheets[l], 0, colours[l]);
      photos.push((await photograph(page, { seed: 70 + l, rotateDeg: l ? 3 : -4, width: 2400, height: 3200 })).image);
    }
    const out = assembleScan(photos.map((im, i) => scanPage(im, `l${i}`, i)));
    expect(out.report.layerCount).toBe(2);
    expect(out.layers.length).toBe(2);
    expect(out.report.missingFrames).toEqual([]);
    for (let l = 0; l < 2; l++)
      for (let f = 0; f < 8; f++) {
        const m = centreMean(out.layers[l][f]!);
        const want = colours[l](f);
        for (let c = 0; c < 3; c++) expect(Math.abs(m[c] - want[c]), `layer ${l} frame ${f}`).toBeLessThan(28);
      }
  }, 120000);
});
