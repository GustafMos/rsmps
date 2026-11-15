import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

/*
 * NOTE: all test image maths below is integer-only on purpose. In the headless Node WebGPU used by vitest, a burst of
 * JS floating-point work between two GPU awaits crashes the process (a node-webgpu/driver problem, see the report).
 */

/** Integer hash noise in [-a, a]. */
function noise(x: number, y: number, s: number, a: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return a === 0 ? 0 : (h & 0x3fffffff) % (2 * a + 1) - a;
}
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

interface Scene {
  w: number;
  inside: (x: number, y: number) => boolean;
  color: (x: number, y: number) => [number, number, number, number];
}

/** IoU of mask>=128 against the scene ground truth. */
function iou(mask: Uint8ClampedArray, scene: Scene): number {
  let inter = 0;
  let union = 0;
  const w = scene.w;
  const h = mask.length / 4 / w;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const m = mask[(y * w + x) * 4] >= 128;
      const g = scene.inside(x, y);
      if (m && g) inter++;
      if (m || g) union++;
    }
  return inter / union;
}

/**
 * A character-like subject (body ellipse + head circle, two-tone shading, a white highlight inside).
 * `s` scales the 128px design (1 or 2).
 */
function subjectScene(s: number, bg: (x: number, y: number) => [number, number, number], amp: number, shiftX = 0): Scene {
  const w = 128 * s;
  const cx = 64 * s + shiftX * s;
  const cy = 70 * s;
  const A = 28 * s;
  const B = 38 * s;
  const R = 15 * s;
  const inside = (x: number, y: number) => {
    const dx = x - cx;
    const dy = y - cy;
    const hx = x - cx;
    const hy = y - 32 * s;
    return dx * dx * B * B + dy * dy * A * A < A * A * B * B || hx * hx + hy * hy < R * R;
  };
  return {
    w,
    inside,
    color: (x, y) => {
      const n = noise(x, y, 5, amp);
      if (inside(x, y)) {
        const hx = x - cx - 8 * s;
        const hy = y - cy;
        const hl = hx * hx + hy * hy < 25 * s * s;
        const c = hl ? [250, 250, 245] : y < cy ? [200, 70, 40] : [150, 40, 90];
        return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n), 255];
      }
      const b = bg(x, y);
      return [clamp(b[0] + n), clamp(b[1] + n), clamp(b[2] + n), 255];
    },
  };
}

describe('subject-mask', () => {
  it('extracts a subject from a vertical gradient background (IoU >= 0.9)', async () => {
    const t = await harness();
    const s = subjectScene(1, (_x, y) => [60 + ((y * 120) >> 7), 110 + ((y * 100) >> 7), 200 + ((y * 40) >> 7)], 0);
    const out = await t.run('subject-mask', {}, { image: t.fromFn(128, 128, s.color) });
    const px = await t.pixels(out.mask as never);
    const score = iou(px.data, s);
    console.log('IoU gradient background', score.toFixed(3));
    expect(score).toBeGreaterThan(0.9);
  });

  it('works on a noisy background with the subject touching no border', async () => {
    const t = await harness();
    const s = subjectScene(1, () => [90, 150, 110], 10, -12);
    const px = await t.pixels((await t.run('subject-mask', {}, { image: t.fromFn(128, 128, s.color) })).mask as never);
    const score = iou(px.data, s);
    console.log('IoU noisy background', score.toFixed(3));
    expect(score).toBeGreaterThan(0.9);
  });

  it('handles a flat white sprite background with a white highlight inside the subject (hole fill)', async () => {
    const t = await harness();
    const s = subjectScene(1, () => [250, 250, 245], 0);
    const px = await t.pixels((await t.run('subject-mask', {}, { image: t.fromFn(128, 128, s.color) })).mask as never);
    const score = iou(px.data, s);
    console.log('IoU white background + highlight', score.toFixed(3));
    expect(score).toBeGreaterThan(0.9);
    expect(px.at(72, 70)[0]).toBeGreaterThan(200); // the highlight is part of the subject
  });

  it('removes small distractor islands', async () => {
    const t = await harness();
    const base = subjectScene(1, () => [90, 150, 110], 0);
    const color: Scene['color'] = (x, y) => (x > 8 && x < 14 && y > 8 && y < 14 ? [30, 30, 30, 255] : base.color(x, y));
    const px = await t.pixels((await t.run('subject-mask', {}, { image: t.fromFn(128, 128, color) })).mask as never);
    expect(px.at(11, 11)[0]).toBeLessThan(40);
    expect(iou(px.data, base)).toBeGreaterThan(0.9);
  });

  it('is resolution independent (2x image, unit 2)', async () => {
    const t = await harness();
    const s = subjectScene(2, (_x, y) => [60 + ((y * 120) >> 8), 110 + ((y * 100) >> 8), 200 + ((y * 40) >> 8)], 6);
    const px = await t.pixels((await t.run('subject-mask', {}, { image: t.fromFn(256, 256, s.color, 2) })).mask as never);
    const score = iou(px.data, s);
    console.log('IoU 2x', score.toFixed(3));
    expect(score).toBeGreaterThan(0.9);
  });

  it('treats transparent pixels as background and supports invert', async () => {
    const t = await harness();
    const s = subjectScene(1, () => [0, 0, 0], 0);
    const img = t.fromFn(128, 128, (x, y) => (s.inside(x, y) ? [200, 60, 60, 255] : [0, 0, 0, 0]));
    const px = await t.pixels((await t.run('subject-mask', {}, { image: img })).mask as never);
    expect(iou(px.data, s)).toBeGreaterThan(0.9);
    const inv = await t.pixels((await t.run('subject-mask', { invert: true }, { image: img })).mask as never);
    expect(inv.at(64, 70)[0]).toBeLessThan(30);
    expect(inv.at(2, 2)[0]).toBeGreaterThan(225);
  });
});
