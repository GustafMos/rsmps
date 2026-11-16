import { describe, expect, it } from 'vitest';
import { createRaster, type RasterImage } from './print/raster';
import { PREVIEW_MAX_FRAMES, PREVIEW_MAX_FRAME_SIDE, PREVIEW_MAX_SHEET_PIXELS, PREVIEW_MAX_SHEET_SIDE, decimate, packSprite, planPreview, previewMeta } from './phone-scan-preview';
import { parsePreviewMeta } from '../phone/scan-protocol';

describe('preview packaging', () => {
  it('keeps every frame when there are few, and decimates evenly when there are many', () => {
    expect(decimate(12)).toEqual({ indices: Array.from({ length: 12 }, (_, i) => i), step: 1 });
    expect(decimate(96).step).toBe(1);
    const d = decimate(97);
    expect(d.step).toBe(2);
    expect(d.indices.length).toBeLessThanOrEqual(PREVIEW_MAX_FRAMES);
    expect(d.indices.slice(0, 3)).toEqual([0, 2, 4]);
    expect(decimate(1000).indices.length).toBeLessThanOrEqual(PREVIEW_MAX_FRAMES);
    expect(decimate(0)).toEqual({ indices: [], step: 1 });
  });

  it('plans cells of at most 480 px and a sheet within the phone limits, whatever the frame size', () => {
    for (const [total, w, h] of [[12, 1920, 1080], [96, 1920, 1080], [300, 4000, 3000], [48, 800, 800], [96, 3000, 300], [5, 64, 48]] as const) {
      const p = planPreview(total, w, h, 12);
      expect(p.count).toBeLessThanOrEqual(PREVIEW_MAX_FRAMES);
      expect(Math.max(p.fw, p.fh)).toBeLessThanOrEqual(PREVIEW_MAX_FRAME_SIDE);
      expect(p.cols * p.fw).toBeLessThanOrEqual(PREVIEW_MAX_SHEET_SIDE);
      expect(p.rows * p.fh).toBeLessThanOrEqual(PREVIEW_MAX_SHEET_SIDE);
      expect(p.cols * p.fw * p.rows * p.fh).toBeLessThanOrEqual(PREVIEW_MAX_SHEET_PIXELS);
      expect(p.cols * p.rows).toBeGreaterThanOrEqual(p.count);
      expect(Math.abs(p.fw / p.fh - w / h) / (w / h)).toBeLessThan(0.15); // the aspect ratio survives (rounding at tiny sizes)
    }
    // small frames are not enlarged
    expect(planPreview(5, 64, 48, 12)).toMatchObject({ fw: 64, fh: 48 });
  });

  it('keeps the real duration when frames are skipped: the rate is divided by the step', () => {
    expect(planPreview(48, 320, 240, 12).fps).toBe(12);
    const p = planPreview(192, 320, 240, 24);
    expect(p.step).toBe(2);
    expect(p.fps).toBe(12);
    expect(p.count / p.fps).toBeCloseTo(192 / 24, 5);
  });

  it('refuses to plan nothing', () => {
    expect(() => planPreview(0, 100, 100, 12)).toThrow(/no frames/);
  });

  const frame = (c: number, a = 255, w = 40, h = 30): RasterImage => createRaster(w, h, [c, c, c, a]);

  it('packs frames into the grid; a missing frame repeats the previous drawing and is listed', () => {
    const frames: (RasterImage | null)[] = [frame(10), null, frame(200), frame(90)];
    const plan = planPreview(4, 40, 30, 12);
    const sheet = packSprite(frames, plan);
    expect(sheet.image.width).toBe(plan.cols * plan.fw);
    expect(sheet.missingFrames).toEqual([2]);
    const px = (k: number) => sheet.image.data[(Math.floor(k / plan.cols) * plan.fh * sheet.image.width + (k % plan.cols) * plan.fw) * 4];
    expect(px(0)).toBe(10);
    expect(px(1)).toBe(10); // repeat of the previous
    expect(px(2)).toBe(200);
    expect(px(3)).toBe(90);
  });

  it('a missing first frame shows the first present one; transparency is flattened onto white', () => {
    const plan = planPreview(2, 40, 30, 12);
    const sheet = packSprite([null, frame(50, 0)], plan);
    expect(sheet.missingFrames).toEqual([1]);
    expect(sheet.image.data[3]).toBe(255);
    expect(sheet.image.data[0]).toBe(255); // fully transparent -> white
  });

  it('only sampled frames are drawn when decimating, and the description is valid for the phone', () => {
    const frames = Array.from({ length: 200 }, (_, i) => (i === 100 ? null : frame(i % 250)));
    const plan = planPreview(200, 40, 30, 24);
    const sheet = packSprite(frames, plan);
    expect(plan.step).toBe(3);
    expect(sheet.missingFrames).toEqual([]); // frame 100 is not a sampled one (indices are multiples of 3)
    const meta = previewMeta(plan, [101], [4]);
    expect(parsePreviewMeta(meta)).toMatchObject({ count: plan.count, step: 3, total: 200, missingFrames: [101], missingSheets: [4] });
  });
});
