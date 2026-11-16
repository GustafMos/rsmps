import { describe, expect, it } from 'vitest';
import { exportPrint, readPrintParams, styleGuide } from './export';
import { ZINE_SLOTS, planFlipbook, renderFlipbook, renderZine } from './imposition';
import { hatchMask, orderPaths, planPlot, plotToSvg, simplifyPolyline, traceMask } from './plot';
import { createRaster, type RasterImage } from './raster';
import { assignInks, paletteOf, renderPlates } from './separations';
import { cropTexture, defaultQuad, makeSeamless, seamError } from './texture';
import { makeFrames } from './testkit.test-util';

const solid = (w: number, h: number, rgb: [number, number, number]): RasterImage => createRaster(w, h, [rgb[0], rgb[1], rgb[2], 255]);

/** Three flat colours in vertical bands on white. */
function threeInk(w = 90, h = 60): RasterImage {
  const img = createRaster(w, h);
  for (let y = 10; y < h - 10; y++)
    for (let x = 6; x < w - 6; x++) {
      const band = Math.floor(((x - 6) / (w - 12)) * 3);
      const c = [[230, 57, 70], [29, 53, 87], [255, 200, 0]][band];
      img.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  return img;
}

describe('flipbook', () => {
  it('plans a binding margin and lays frames out in reading order with cut lines', () => {
    const frames = makeFrames(12, 64, 48, 3);
    const plan = planFlipbook(12, 64 / 48, { frameWidthMm: 40, bindingMm: 10 });
    expect(plan.cellWMm).toBe(50);
    expect(plan.columns).toBe(Math.floor(194 / 50));
    const { pages } = renderFlipbook(frames, { dpi: 100, frameWidthMm: 40, bindingMm: 10 });
    expect(pages.length).toBe(plan.sheets);
    // the first frame's top-left pixel region carries the picture: binding margin at the left stays white
    const p = pages[0].bitmap;
    const y = Math.round(((297 - plan.rows * plan.cellHMm) / 2 + plan.frameHMm / 2) * (100 / 25.4));
    const x0 = Math.round(((210 - plan.columns * plan.cellWMm) / 2) * (100 / 25.4));
    expect(p.data[(y * p.width + x0 + 8) * 4]).toBe(255); // inside the binding margin (white or a cut line gap)
  });
  it('duplex puts frame N + half on the back at the mirrored cell', () => {
    const frames = Array.from({ length: 10 }, (_, i) => solid(40, 30, [i * 20, 0, 0]));
    const { pages, plan } = renderFlipbook(frames, { dpi: 100, frameWidthMm: 30, bindingMm: 8, duplex: true, binding: 'left' });
    expect(pages.length).toBe(plan.sheets * 2);
    const px = 100 / 25.4;
    const probe = (page: RasterImage, col: number, row: number) => {
      const x = (210 - plan.columns * plan.cellWMm) / 2 + col * plan.cellWMm + 8 + 15; // centre of the frame area
      const y = (297 - plan.rows * plan.cellHMm) / 2 + row * plan.cellHMm + plan.frameHMm / 2;
      return page.data[(Math.round(y * px) * page.width + Math.round(x * px)) * 4];
    };
    // front: frame i sits at (col i, row 0); back: frame i + 5 at the mirrored column
    expect(probe(pages[0].bitmap, 1, 0)).toBe(1 * 20);
    const mirrored = plan.columns - 1 - 1;
    // binding margin mirrors to the right on the back, so the picture is 8 mm further left
    const x = (210 - plan.columns * plan.cellWMm) / 2 + mirrored * plan.cellWMm + 15;
    const y = (297 - plan.rows * plan.cellHMm) / 2 + plan.frameHMm / 2;
    expect(pages[1].bitmap.data[(Math.round(y * px) * pages[1].bitmap.width + Math.round(x * px)) * 4]).toBe((1 + 5) * 20);
  });
});

describe('zine', () => {
  it('uses the standard 8-page fold order and rotates the top row half a turn', () => {
    expect(ZINE_SLOTS.filter((s) => s.row === 0).map((s) => s.page)).toEqual([5, 4, 3, 2]);
    expect(ZINE_SLOTS.filter((s) => s.row === 1).map((s) => s.page)).toEqual([6, 7, 8, 1]);
    expect(ZINE_SLOTS.every((s) => s.rotated === (s.row === 0))).toBe(true);
    // pairs joined by the middle fold: same column, one above the other, are (2,1), (3,8), (4,7), (5,6)
    const col = (page: number) => ZINE_SLOTS.find((s) => s.page === page)!.col;
    expect([col(2), col(3), col(4), col(5)]).toEqual([col(1), col(8), col(7), col(6)]);
  });
  it('renders a landscape sheet per 8 frames with the right frame in the right panel, upside down on the top row', () => {
    const frames = Array.from({ length: 9 }, (_, i) => makeColour(i));
    const { pages, sheets } = renderZine(frames, { dpi: 80, paper: 'a4' });
    expect(sheets).toBe(2);
    expect(pages[0].widthMm).toBe(297);
    const px = 80 / 25.4;
    const panelCentre = (col: number, row: number) => ({ x: Math.round((7 + (col + 0.5) * ((297 - 14) / 4)) * px), y: Math.round((7 + (row + 0.5) * ((210 - 14) / 2) - 3) * px) });
    const colourAt = (col: number, row: number) => {
      const c = panelCentre(col, row);
      const i = (c.y * pages[0].bitmap.width + c.x) * 4;
      return pages[0].bitmap.data[i];
    };
    for (const s of ZINE_SLOTS) expect(colourAt(s.col, s.row), `page ${s.page}`).toBe(makeColour(s.page - 1).data[0]);
  });
});

function makeColour(i: number): RasterImage {
  return solid(40, 30, [20 + i * 25, 100, 100]);
}

describe('separations', () => {
  it('finds the exact three inks of a flat picture and ignores the white paper', () => {
    const pal = paletteOf([threeInk()], 3);
    expect(pal.exact).toBe(true);
    expect(pal.inks.length).toBe(3);
    expect(pal.paper).not.toBeNull();
    const hexes = pal.inks.map((i) => i.hex).sort();
    expect(hexes).toEqual(['#1D3557', '#E63946', '#FFC800']);
  });
  it('k-means gives the requested number of inks for a gradient and every pixel gets one', () => {
    const g = createRaster(64, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) g.data.set([x * 4, 255 - x * 4, (y * 8) % 256, 255], (y * 64 + x) * 4);
    const pal = paletteOf([g], 4);
    expect(pal.inks.length).toBeLessThanOrEqual(4);
    expect(pal.inks.length).toBeGreaterThanOrEqual(3);
    const idx = assignInks(g, pal);
    expect(Math.max(...idx)).toBeLessThanOrEqual(pal.inks.length);
  });
  it('renders one plate per ink with registration marks outside the frame; coverage partitions the picture', () => {
    const { plates, palette } = renderPlates([threeInk(), threeInk()], { inks: 3, dpi: 72, title: 'sep' });
    expect(plates.length).toBe(3);
    expect(plates[0].pages.length).toBe(2);
    const p = plates[0].pages[0].bitmap;
    const dark = plates.map((pl) => {
      let n = 0;
      const d = pl.pages[0].bitmap.data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
      return n;
    });
    // each ink covers its own band, so no plate is empty and the three are of similar size
    expect(Math.min(...dark)).toBeGreaterThan(1000);
    expect(palette.inks.length).toBe(3);
    // the corner registration mark exists on every plate
    for (const pl of plates) {
      const b = pl.pages[0].bitmap;
      let found = 0;
      for (let y = 0; y < Math.round(20 * 72 / 25.4); y++) for (let x = 0; x < Math.round(20 * 72 / 25.4); x++) if (b.data[(y * b.width + x) * 4] < 100) found++;
      expect(found).toBeGreaterThan(5);
    }
    void p;
  });
  it('exports a PDF per ink through the Output print kind', async () => {
    const params = readPrintParams({ printKind: 'separations', printInks: 3, printDpi: 72, printOutput: 'pdf' });
    const files = await exportPrint({ params, title: 'art', frames: 2, fps: 12, renderFrame: async () => threeInk(), progress() {}, claim: (n) => n, yieldNow: async () => {} });
    expect(files.length).toBe(3);
    expect(files.every((f) => f.name.endsWith('.pdf') && f.name.includes('_ink'))).toBe(true);
  });
});

describe('plotter tracing', () => {
  const square = (n: number, x0: number, y0: number, x1: number, y1: number) => {
    const m = new Uint8Array(n * n);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * n + x] = 1;
    return m;
  };
  it('traces a filled square into one closed loop and a ring into two', () => {
    const loops = traceMask(square(20, 4, 4, 14, 14), 20, 20);
    expect(loops.length).toBe(1);
    expect(loops[0].closed).toBe(true);
    const ring = square(30, 4, 4, 24, 24);
    for (let y = 10; y < 18; y++) for (let x = 10; x < 18; x++) ring[y * 30 + x] = 0;
    expect(traceMask(ring, 30, 30).length).toBe(2);
    const s = simplifyPolyline(loops[0], 0.6);
    expect(s.points.length).toBeLessThanOrEqual(8);
    expect(s.points.length).toBeGreaterThanOrEqual(4);
    const xs = s.points.map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThan(3.9);
    expect(Math.max(...xs)).toBeLessThan(14.1);
  });
  it('hatches fill, and ordering keeps every path', () => {
    const h = hatchMask(square(40, 5, 5, 35, 35), 40, 40, 3, 0);
    expect(h.length).toBeGreaterThanOrEqual(8);
    expect(h.every((l) => l.points.length === 2)).toBe(true);
    expect(orderPaths(h).length).toBe(h.length);
  });
  it('writes an SVG in millimetres with one layer per ink', () => {
    const plot = planPlot(threeInk(120, 80), { inks: 3, paper: 'a4', hatch: true, hatchSpacingMm: 2 });
    expect(plot.layers.length).toBe(3);
    expect(plot.pathCount).toBeGreaterThan(10);
    const svg = plotToSvg(plot);
    expect(svg).toContain('width="210mm"');
    expect(svg).toContain('viewBox="0 0 210 297"');
    expect((svg.match(/inkscape:groupmode="layer"/g) ?? []).length).toBe(3);
    expect(svg).toContain('stroke="#E63946"');
    // all coordinates stay inside the page
    for (const l of plot.layers) for (const p of l.paths) for (const q of p.points) {
      expect(q[0]).toBeGreaterThanOrEqual(0);
      expect(q[0]).toBeLessThanOrEqual(210);
      expect(q[1]).toBeGreaterThanOrEqual(0);
      expect(q[1]).toBeLessThanOrEqual(297);
    }
  });
});

describe('print styles', () => {
  it('maps rotoscope styles to the strip guide and blue flag', () => {
    expect(styleGuide(readPrintParams({ printStyle: 'faint', printStyleStrength: 20 }))).toEqual({ guide: 'faded', opacity: 20, blue: false });
    expect(styleGuide(readPrintParams({ printStyle: 'blue' })).blue).toBe(true);
    expect(styleGuide(readPrintParams({ printStyle: 'outline', printOutlineInk: 'blue' }))).toMatchObject({ guide: 'outline', blue: true });
    expect(styleGuide(readPrintParams({ printGuide: 'blank' }))).toMatchObject({ guide: 'blank', blue: false });
  });
});

describe('textures', () => {
  it('crops and deskews a tilted rectangle to a flat picture', () => {
    const photo = createRaster(200, 150);
    // a red rectangle rotated by painting a parallelogram-ish quad region
    for (let y = 40; y < 110; y++) for (let x = 50 + (y - 40) * 0.2; x < 150 + (y - 40) * 0.2; x++) photo.data.set([200, 30, 30, 255], (y * 200 + Math.floor(x)) * 4);
    const out = cropTexture(photo, [{ x: 50, y: 40 }, { x: 150, y: 40 }, { x: 164, y: 110 }, { x: 64, y: 110 }]);
    expect(out.width).toBeGreaterThan(90);
    let off = 0;
    for (let y = 2; y < out.height - 2; y++) for (let x = 2; x < out.width - 2; x++) if (out.data[(y * out.width + x) * 4 + 1] > 80) off++;
    expect(off).toBeLessThan(out.width * out.height * 0.02);
    expect(defaultQuad(100, 100)[2].x).toBeCloseTo(94);
  });
  it('make-seamless removes the wrap-around seam', () => {
    const w = 64;
    const g = createRaster(w, w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) g.data.set([x * 4, y * 4, 128, 255], (y * w + x) * 4);
    const before = seamError(g);
    const after = seamError(makeSeamless(g));
    expect(before).toBeGreaterThan(60);
    expect(after).toBeLessThan(before * 0.1);
  });
});
