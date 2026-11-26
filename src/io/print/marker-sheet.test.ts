import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARKER_COUNT } from '../../engine/lib/marker-code';
import { detectMarkers } from '../../engine/lib/marker-detect';
import { markerSheetPdf, markerSheetPng, maxMarkerMm, renderMarkerSheet } from './marker-sheet';
import { resizeRaster, toGray8 } from './raster';

/** Set MARKER_DUMP to a folder to get the sheet as files. */
const DUMP = process.env.MARKER_DUMP ?? '';

describe('printable marker sheet', () => {
  it('the square is exactly the asked size on the page, and the sheet (captions and all) is read back as that marker, upright', () => {
    for (let id = 0; id < MARKER_COUNT; id++) {
      const s = renderMarkerSheet({ id, sizeMm: 100, dpi: 100 });
      expect(s.square.size).toBe(100);
      // the whole page as a phone would see it from straight above, shrunk to the search size
      const small = resizeRaster(s.image, Math.round(s.image.width * 0.4), Math.round(s.image.height * 0.4), 'area');
      const found = detectMarkers(toGray8(small), small.width, small.height);
      expect(found.length).toBe(1);
      expect(found[0].id).toBe(id);
      expect(found[0].mirrored).toBe(false);
      const k = (0.4 * 100) / 25.4;
      // top-left corner first: the caption's "top" is the marker's top
      expect(Math.abs(found[0].corners[0][0] / k - s.square.x)).toBeLessThan(0.5);
      expect(Math.abs(found[0].corners[0][1] / k - s.square.y)).toBeLessThan(0.5);
      expect(Math.abs((found[0].corners[1][0] - found[0].corners[0][0]) / k - 100)).toBeLessThan(0.5);
    }
  });
  it('sizes are kept within what fits the paper with its white margin; PDF and PNG are written', () => {
    expect(maxMarkerMm('a4')).toBe(135);
    expect(renderMarkerSheet({ id: 0, sizeMm: 500, dpi: 50 }).square.size).toBe(135);
    expect(renderMarkerSheet({ id: 0, sizeMm: 1, dpi: 50 }).square.size).toBe(20);
    const pdf = markerSheetPdf({ id: 1, sizeMm: 50, dpi: 72 });
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toContain('%PDF-1.4');
    const png = markerSheetPng({ id: 1, sizeMm: 50, dpi: 72, paper: 'letter' });
    expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    if (DUMP) {
      mkdirSync(DUMP, { recursive: true });
      writeFileSync(`${DUMP}/marker-1-100mm.pdf`, markerSheetPdf({ id: 0, sizeMm: 100 }));
      writeFileSync(`${DUMP}/marker-1-100mm.png`, markerSheetPng({ id: 0, sizeMm: 100, dpi: 100 }));
    }
  });
});
