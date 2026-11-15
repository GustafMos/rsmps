import { beforeAll, describe, expect, it } from 'vitest';
import { planSheet, type SheetLayout } from './layout';
import { renderPage } from './render';
import { createRaster, type RasterImage } from './raster';
import { scanPage } from './scan/page';
import { assembleScan } from './scan/pipeline';
import { estimateShift, makeFrames, meanAbsError, photograph, type PhotoOptions } from './testkit.test-util';

const N = 24;
const FW = 96;
const FH = 72;
const frames = makeFrames(N, FW, FH, 11);
let sheet: SheetLayout;
let pages: RasterImage[] = [];

const stats: string[] = [];

function evaluate(label: string, out: ReturnType<typeof assembleScan>, expectFrames: number[]) {
  let worstShift = 0;
  let sumErr = 0;
  let worstErr = 0;
  let n = 0;
  for (const i of expectFrames) {
    const f = out.frames[i];
    expect(f, `frame ${i}`).not.toBeNull();
    expect(f!.width).toBe(FW);
    expect(f!.height).toBe(FH);
    const err = meanAbsError(f!, frames[i]);
    const s = estimateShift(f!, frames[i]);
    worstShift = Math.max(worstShift, Math.hypot(s.dx, s.dy));
    sumErr += err;
    worstErr = Math.max(worstErr, err);
    n++;
  }
  stats.push(`${label}: frames=${n} meanErr=${(sumErr / n).toFixed(2)} worstErr=${worstErr.toFixed(2)} worstShift=${worstShift.toFixed(2)}px`);
  expect(worstShift).toBeLessThan(1.0);
  expect(sumErr / n).toBeLessThan(14);
  return { worstShift, meanErr: sumErr / n };
}

beforeAll(() => {
  sheet = planSheet({ columns: 3, rows: 4, name: 'scan test', dpi: 300 }, { width: FW, height: FH, count: N, fps: 12 });
  pages = [0, 1].map((p) => renderPage(sheet, p, (i) => frames[i]));
}, 120000);

async function shoot(page: number, o: PhotoOptions = {}) {
  return (await photograph(pages[page], { seed: 100 + page, ...o })).image;
}

describe('scan end to end', () => {
  it('recovers two pages from a skewed, noisy, JPEG-compressed phone photo', async () => {
    const photos = [await shoot(0, { rotateDeg: 6, seed: 1 }), await shoot(1, { rotateDeg: -8, seed: 2 })];
    const out = assembleScan(photos.map((p, i) => scanPage(p, `p${i}.jpg`, i)));
    const rep = out.report;
    expect(rep.pages.map((p) => p.status)).toEqual(['ok', 'ok']);
    expect(rep.totalFrames).toBe(N);
    expect(rep.pageCount).toBe(2);
    expect(rep.fps).toBe(12);
    expect(rep.frameWidthPx).toBe(FW);
    expect(rep.missingFrames).toEqual([]);
    expect(rep.complete).toBe(true);
    expect(rep.pages[0].layout!.columns).toBe(3);
    expect(rep.pages[0].layout!.rows).toBe(4);
    expect(rep.pages[0].layout!.projectId).toBe(rep.pages[1].layout!.projectId);
    expect(rep.pages[1].frameRange).toEqual([12, 23]);
    expect(rep.pages[0].marksFound).toBe(rep.pages[0].marksExpected);
    expect(rep.pages[0].reprojectionErrorPx!).toBeLessThan(3);
    evaluate('base', out, [...Array(N).keys()]);
  }, 180000);

  it.each([90, 180, 270])('handles a page photographed rotated by %i degrees', async (deg) => {
    const photos = [await shoot(0, { rotateDeg: deg + 4, seed: 5 }), await shoot(1, { rotateDeg: deg - 5, seed: 6 })];
    const out = assembleScan(photos.map((p, i) => scanPage(p, `r${deg}-${i}.jpg`, i)));
    expect(out.report.pages.every((p) => p.status !== 'failed')).toBe(true);
    expect(out.report.pages[0].rotation).toBe(deg);
    expect(out.report.missingFrames).toEqual([]);
    evaluate(`rot${deg}`, out, [...Array(N).keys()]);
  }, 180000);

  it('orders pages by decoded index when supplied in reverse', async () => {
    const photos = [await shoot(1, { rotateDeg: 3, seed: 8 }), await shoot(0, { rotateDeg: -4, seed: 9 })];
    const out = assembleScan(photos.map((p, i) => scanPage(p, `rev${i}.jpg`, i)));
    expect(out.report.pages[0].pageIndex).toBe(1);
    expect(out.report.pages[1].pageIndex).toBe(0);
    expect(out.report.missingFrames).toEqual([]);
    evaluate('reverse', out, [...Array(N).keys()]);
  }, 180000);

  it('survives user drawing over the frames and reports missing pages', async () => {
    const scribble = (page: RasterImage) => {
      const d = page.data;
      const w = page.width;
      const pen = (x: number, y: number, r: number, c: [number, number, number]) => {
        for (let j = -r; j <= r; j++)
          for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) d.set([c[0], c[1], c[2], 255], ((y + j) * w + x + i) * 4);
      };
      for (let t = 0; t < 1; t += 0.0004) {
        pen(Math.round(500 + t * 1400), Math.round(700 + Math.sin(t * 12) * 160 + t * 900), 6, [220, 20, 30]);
        pen(Math.round(300 + t * 1700), Math.round(2600 - t * 1200), 5, [20, 60, 200]);
      }
    };
    const photo = await shoot(0, { rotateDeg: 5, seed: 12, mutate: scribble });
    const out = assembleScan([scanPage(photo, 'drawn.jpg', 0)]);
    expect(out.report.pages[0].status).not.toBe('failed');
    expect(out.report.missingPages).toEqual([1]);
    expect(out.report.missingFrames).toEqual([...Array(12).keys()].map((i) => i + 12));
    expect(out.report.complete).toBe(false);
    expect(out.report.warnings.join(' ')).toMatch(/Missing page/);
    // frames the strokes do not touch still match to sub-pixel; the strokes show up in the others
    const per = [...Array(12).keys()].map((i) => ({ err: meanAbsError(out.frames[i]!, frames[i]), shift: estimateShift(out.frames[i]!, frames[i]) }));
    const clean = per.filter((p) => p.err < 3.5);
    const worst = Math.max(...clean.map((p) => Math.hypot(p.shift.dx, p.shift.dy)));
    stats.push(`drawn: ${clean.length}/12 untouched frames, worstShift=${worst.toFixed(2)}px, max error with strokes=${Math.max(...per.map((p) => p.err)).toFixed(1)}`);
    expect(clean.length).toBeGreaterThanOrEqual(5);
    expect(worst).toBeLessThan(1);
    expect(Math.max(...per.map((p) => p.err))).toBeGreaterThan(4.5);
  }, 180000);

  it('reports a clear warning when a corner marker is covered', async () => {
    const cover = (page: RasterImage) => {
      // paper-white rectangle over the bottom-right finder
      const mm = 300 / 25.4;
      for (let y = Math.round(page.height - 20 * mm); y < page.height - 3 * mm; y++)
        for (let x = Math.round(page.width - 20 * mm); x < page.width - 3 * mm; x++) page.data.set([240, 240, 240, 255], (y * page.width + x) * 4);
    };
    const photo = await shoot(0, { rotateDeg: 4, seed: 14, mutate: cover });
    const scan = scanPage(photo, 'covered.jpg', 0);
    expect(scan.report.status).toBe('failed');
    expect(scan.frames).toHaveLength(0);
    expect(scan.report.warnings.join(' ')).toMatch(/Not all four corner markers were found/);
    expect(scan.report.foundCorners.length).toBeGreaterThanOrEqual(3);
    const out = assembleScan([scan]);
    expect(out.report.recoveredFrames).toBe(0);
    expect(out.report.complete).toBe(false);
  }, 180000);

  it('falls back to a manual layout when the data strip is destroyed, using the page-corner order', async () => {
    const wipe = (page: RasterImage) => {
      const mm = 300 / 25.4;
      for (let y = Math.round(6 * mm); y < Math.round(17 * mm); y++)
        for (let x = Math.round(page.width / 2 - 25 * mm); x < Math.round(page.width / 2 + 25 * mm); x++) page.data.set([255, 255, 255, 255], (y * page.width + x) * 4);
    };
    const photo = await shoot(0, { rotateDeg: 3, seed: 16, mutate: wipe });
    const auto = scanPage(photo, 'nostrip.jpg', 0);
    expect(auto.report.status).toBe('failed');
    expect(auto.report.warnings.join(' ')).toMatch(/data strip could not be read/);
    expect(auto.report.corners).not.toBeNull();
    const manual = scanPage(photo, 'nostrip.jpg', 0, {
      manual: { corners: auto.report.corners!, layout: { paper: 'a4', columns: 3, rows: 4, frameAspect: FW / FH }, pageIndex: 0, totalFrames: N, frameWidthPx: FW, frameHeightPx: FH, fps: 12 },
    });
    expect(manual.report.status).not.toBe('failed');
    expect(manual.report.layoutSource).toBe('manual');
    const out = assembleScan([manual]);
    evaluate('manual-layout', out, [...Array(12).keys()]);
  }, 180000);

  it('reproduces a lower-resolution photo too (1500x2000)', async () => {
    const photo = await shoot(0, { width: 1500, height: 2000, rotateDeg: -5, seed: 21, blur: 0.8 });
    const out = assembleScan([scanPage(photo, 'small.jpg', 0)]);
    expect(out.report.pages[0].status).not.toBe('failed');
    evaluate('lowres', out, [...Array(12).keys()]);
  }, 180000);

  it('drawing only mode and guide removal work on scanned frames', async () => {
    const faded = planSheet({ columns: 3, rows: 4, dpi: 300, guide: 'faded', guideOpacity: 40 }, { width: FW, height: FH, count: 12, fps: 12 });
    const page = renderPage(faded, 0, (i) => frames[i]);
    const photo = (await photograph(page, { seed: 31, rotateDeg: 2 })).image;
    const scan = scanPage(photo, 'faded.jpg', 0);
    expect(scan.report.layout!.guide).toBe('faded');
    expect(scan.report.layout!.guideOpacity).toBe(40);
    const { removeGuide, extractDrawing } = await import('./scan/clean');
    const f = scan.frames[0].image;
    removeGuide(f, frames[0], 'faded', 40);
    const drawing = extractDrawing(f, { threshold: 0.2 });
    let ink = 0;
    for (let i = 3; i < drawing.data.length; i += 4) if (drawing.data[i] > 40) ink++;
    stats.push(`guide removal: residual ink ${(ink / (FW * FH) * 100).toFixed(1)}% of frame`);
    expect(ink / (FW * FH)).toBeLessThan(0.08);
  }, 180000);

  it('prints stats', () => {
    console.log('\n' + stats.join('\n'));
    expect(createRaster(1, 1).data.length).toBe(4);
  });
});
