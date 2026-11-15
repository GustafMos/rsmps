import sharp from 'sharp';
import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  STRIP_BYTES,
  decodeHeader,
  encodeHeader,
  stripBytes,
  stripModules,
  type SheetHeader,
} from './format';
import { fitHomography, applyH } from './geometry';
import { captionFor, geometryFromHeader, markCenterMm, pageHeader, planSheet } from './layout';
import { PdfBuilder } from './pdf';
import { encodePng } from './png';
import { guideAppearance, renderPage, fitFrameToCell } from './render';
import { createRaster } from './raster';
import { extractDrawing, removeGuide } from './scan/clean';
import { makeFrames } from './testkit.test-util';

describe('header + strip format', () => {
  const h: SheetHeader = {
    version: FORMAT_VERSION,
    paper: 'letter',
    landscape: true,
    pageIndex: 3,
    pageCount: 9,
    columns: 5,
    rows: 4,
    cellW: 412,
    cellH: 309,
    pitchX: 462,
    pitchY: 359,
    gridX0: 255,
    gridY0: 321,
    firstFrame: 60,
    totalFrames: 175,
    fpsX100: 1250,
    frameW: 640,
    frameH: 480,
    guide: 'faded',
    guideOpacity: 35,
    projectId: 0xdeadbeef,
  };
  it('round-trips every field', () => {
    expect(decodeHeader(encodeHeader(h))).toEqual(h);
  });
  it('detects corruption through the CRC', () => {
    const bytes = encodeHeader(h);
    for (let bit = 0; bit < 240; bit += 7) {
      const bad = new Uint8Array(bytes);
      bad[bit >> 3] ^= 0x80 >> (bit & 7);
      expect(decodeHeader(bad)).toBeNull();
    }
  });
  it('survives the module grid', () => {
    const grid = stripModules(encodeHeader(h));
    expect(decodeHeader(stripBytes(grid))).toEqual(h);
    expect(STRIP_BYTES).toBeGreaterThanOrEqual(33);
  });
});

describe('planSheet', () => {
  it('lays a default A4 sheet out inside the printable area, marks in the gutters', () => {
    const s = planSheet({ columns: 3, rows: 4, name: 'demo' }, { width: 96, height: 72, count: 30, fps: 12 });
    const g = s.geometry;
    expect(g.columns).toBe(3);
    expect(g.rows).toBe(4);
    expect(s.pageCount).toBe(3);
    // everything inside the page and clear of the 20 mm bands
    const first = markCenterMm(g, 0, 0);
    const last = markCenterMm(g, 3, 4);
    expect(first.x).toBeGreaterThan(5);
    expect(last.x).toBeLessThan(205);
    expect(first.y).toBeGreaterThan(20);
    expect(last.y).toBeLessThan(277);
    expect(Math.abs(g.cellWMm / g.cellHMm - 96 / 72)).toBeLessThan(0.02);
    expect(g.gutterMm).toBeCloseTo(5, 5);
    expect(geometryFromHeader(pageHeader(s, 1))).toEqual(g);
    expect(captionFor(s, 2)).toContain('PAGE 3/3');
  });
  it('supports target frame width, landscape and other papers', () => {
    const s = planSheet({ paper: 'a3', orientation: 'landscape', frameWidthMm: 60 }, { width: 100, height: 100, count: 5, fps: 8 });
    expect(s.geometry.pageWidthMm).toBe(420);
    expect(s.geometry.cellWMm).toBeCloseTo(60, 0);
    expect(s.geometry.columns).toBeGreaterThan(4);
  });
  it('rejects impossible requests clearly', () => {
    expect(() => planSheet({ columns: 40, rows: 40 }, { width: 10, height: 10, count: 5, fps: 8 })).toThrow(/smaller than 8 mm/);
  });
});

describe('render', () => {
  const frames = makeFrames(4);
  const sheet = planSheet({ columns: 2, rows: 2, dpi: 150 }, { width: 96, height: 72, count: 4, fps: 10 });
  const page = renderPage(sheet, 0, (i) => frames[i]);
  it('has the exact pixel size of the paper', () => {
    expect(page.width).toBe(Math.round((210 * 150) / 25.4));
    expect(page.height).toBe(Math.round((297 * 150) / 25.4));
  });
  it('draws black finders in the corners and marks in the gutter', () => {
    const px = (x: number, y: number) => page.data[(Math.round(y) * page.width + Math.round(x)) * 4];
    const mm = (v: number) => (v * 150) / 25.4;
    expect(px(mm(8), mm(8))).toBeLessThan(40);
    expect(px(mm(11.9), mm(11.9))).toBeLessThan(40); // core of the TL finder
    expect(px(mm(210 - 8), mm(8))).toBeLessThan(40);
    const m = markCenterMm(sheet.geometry, 1, 1);
    expect(px(mm(m.x), mm(m.y))).toBeLessThan(40);
    expect(px(mm(m.x + 1.2), mm(m.y))).toBeLessThan(60);
    expect(px(mm(m.x + 1), mm(m.y + 1))).toBeGreaterThan(220);
  });
  it('fits frames to cells', () => {
    const f = fitFrameToCell(frames[0], sheet);
    expect(f.width).toBe(Math.round((sheet.geometry.cellWMm * 150) / 25.4));
  });
});

describe('guide', () => {
  const f = makeFrames(1)[0];
  it('faded keeps a fraction of the ink and blank is white', () => {
    const faded = guideAppearance(f, 'faded', 30);
    const blank = guideAppearance(f, 'blank', 0);
    expect(faded.data[0]).toBeGreaterThan(f.data[0]);
    expect(blank.data[0]).toBe(255);
  });
  it('removeGuide undoes the printed guide on a perfect scan', () => {
    const g = guideAppearance(f, 'faded', 40);
    const scanned = createRaster(f.width, f.height);
    scanned.data.set(g.data);
    removeGuide(scanned, f, 'faded', 40);
    expect(scanned.data[0]).toBeGreaterThan(250);
    expect(scanned.data[1000 * 4]).toBeGreaterThan(250);
  });
  it('extractDrawing keeps ink and clears paper', () => {
    const img = createRaster(4, 1);
    img.data.set([255, 255, 255, 255, 250, 250, 250, 255, 200, 30, 30, 255, 0, 0, 0, 255]);
    const d = extractDrawing(img);
    expect(d.data[3]).toBe(0);
    expect(d.data[7]).toBe(0);
    expect(d.data[11]).toBeGreaterThan(200);
    expect(d.data[8]).toBeGreaterThan(190);
    expect(d.data[15]).toBe(255);
  });
});

describe('homography', () => {
  it('solves the 8-DOF system exactly and in least squares', () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }, { x: 0, y: 200 }];
    const dst = [{ x: 10, y: 20 }, { x: 300, y: 5 }, { x: 280, y: 400 }, { x: 30, y: 380 }];
    const H = fitHomography(src, dst)!;
    src.forEach((p, i) => {
      const q = applyH(H, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
    const mid = applyH(H, 50, 100);
    const more = fitHomography([...src, { x: 50, y: 100 }], [...dst, mid])!;
    const chk = applyH(more, 25, 50);
    const ref = applyH(H, 25, 50);
    expect(chk.x).toBeCloseTo(ref.x, 4);
  });
});

describe('PNG and PDF writers', () => {
  const frames = makeFrames(2);
  const sheet = planSheet({ columns: 1, rows: 2, dpi: 100 }, { width: 96, height: 72, count: 2, fps: 10 });
  const pages = [renderPage(sheet, 0, (i) => frames[i])];

  it('writes a PNG that decodes back identically', async () => {
    const png = encodePng(pages[0], { dpi: 100, opaque: true });
    const dec = await sharp(Buffer.from(png)).raw().toBuffer({ resolveWithObject: true });
    expect(dec.info.width).toBe(pages[0].width);
    expect(dec.info.height).toBe(pages[0].height);
    const ch = dec.info.channels;
    for (const i of [0, 12345, 99999, pages[0].width * 300 + 77]) {
      expect(dec.data[i * ch]).toBe(pages[0].data[i * 4]);
      expect(dec.data[i * ch + 2]).toBe(pages[0].data[i * 4 + 2]);
    }
  });

  it('writes a structurally valid PDF with exact page size', () => {
    const pdf = new PdfBuilder('test');
    pdf.addImagePage(pages[0], 210, 297);
    const grey = createRaster(40, 50, [128, 128, 128, 255]);
    pdf.addImagePage(grey, 100, 150);
    const bytes = pdf.finish();
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const sx = text.lastIndexOf('startxref');
    const xrefPos = Number(text.slice(sx + 9).trim().split('\n')[0]);
    expect(text.slice(xrefPos, xrefPos + 4)).toBe('xref');
    const lines = text.slice(xrefPos).split('\n');
    const [, count] = lines[1].split(' ').map(Number);
    expect(count).toBe(3 + 2 * 3 + 1);
    for (let id = 1; id < count; id++) {
      const off = Number(lines[2 + id].slice(0, 10));
      expect(text.slice(off, off + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(2);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('/DeviceGray');
    expect(text).toContain('/DeviceRGB');
    // the first image stream inflates to the right number of bytes
    const imgObj = text.indexOf('/Subtype /Image');
    const len = Number(/\/Length (\d+)/.exec(text.slice(imgObj))![1]);
    const start = text.indexOf('stream\n', imgObj) + 7;
    const raw = unzlibSync(bytes.subarray(start, start + len));
    expect(raw.length).toBe(pages[0].width * pages[0].height * 3);
  });
});

describe('print export kind', () => {
  it('reads params with defaults and exports PDF + PNG pages for every Nth frame', async () => {
    const { exportPrint, readPrintParams } = await import('./export');
    const params = readPrintParams({ printColumns: 2, printRows: 2, printDpi: 100, printOutput: 'both', step: 2, printGuide: 'faded' });
    expect(params.paper).toBe('a4');
    expect(params.step).toBe(2);
    const frames = makeFrames(10);
    const asked: number[] = [];
    const files = await exportPrint({
      params,
      title: 'demo',
      frames: 10,
      fps: 12,
      renderFrame: async (i) => {
        asked.push(i);
        return frames[i];
      },
      progress: () => undefined,
      claim: (n) => n,
      yieldNow: async () => undefined,
    });
    expect(asked).toEqual([0, 2, 4, 6, 8]);
    expect(files.map((f) => f.name)).toEqual(['demo.pdf', 'demo_page_01.png', 'demo_page_02.png']);
    expect(files[0].blob.type).toBe('application/pdf');
  });
});
