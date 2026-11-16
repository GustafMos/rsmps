import { beforeAll, describe, expect, it } from 'vitest';
import { planSheet } from '../io/print/layout';
import { renderPage } from '../io/print/render';
import { toGray8, type RasterImage } from '../io/print/raster';
import { makeFrames, photograph } from '../io/print/testkit.test-util';
import { AUTO_HOLD_MS, AutoCaptureGate, SteadyTracker, checkFrame, checkSize, markerHint, rgbaToGray, type CheckResult } from './scan-check';

let photo: RasterImage;
const W = 720;
const H = 960;

beforeAll(async () => {
  const frames = makeFrames(6, 96, 72, 5);
  const sheet = planSheet({ columns: 3, rows: 2, name: 'check', dpi: 150 }, { width: 96, height: 72, count: 6, fps: 12 });
  const page = renderPage(sheet, 0, (i) => frames[i]);
  photo = (await photograph(page, { seed: 4, width: W, height: H, rotateDeg: 3, noise: 2 })).image;
}, 60000);

describe('live corner check on a rendered, photographed sheet', () => {
  it('sees all four corner finders and a paper-shaped quad', () => {
    const r = checkFrame(toGray8(photo), photo.width, photo.height);
    expect(r.corners).toEqual([true, true, true, true]);
    expect(r.count).toBe(4);
    expect(r.quad).not.toBeNull();
    expect(r.quad).toHaveLength(4);
    for (const p of r.quad!) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
    }
    expect(r.module!).toBeGreaterThan(2.2);
  });

  it('reports fewer corners when one is out of view, and no quad', () => {
    const cut: RasterImage = { ...photo, data: new Uint8ClampedArray(photo.data) };
    // blank out the top-right corner region (the finder lives there)
    for (let y = 0; y < H * 0.25; y++) for (let x = Math.floor(W * 0.6); x < W; x++) cut.data.set([200, 200, 200, 255], (y * W + x) * 4);
    const r = checkFrame(toGray8(cut), W, H);
    expect(r.count).toBeLessThan(4);
    expect(r.quad).toBeNull();
    expect(r.corners[1]).toBe(false);
    expect(markerHint(r, 0, true).tone).toBe('warn');
    expect(markerHint(r, 0, true).text).toMatch(/Move back/);
  });

  it('finds nothing in a plain frame, and ignores tiny ones', () => {
    const plain = new Uint8Array(W * H).fill(128);
    expect(checkFrame(plain, W, H)).toMatchObject({ count: 0, quad: null, module: null });
    expect(checkFrame(new Uint8Array(10 * 10), 10, 10).count).toBe(0);
  });

  it('the cost is small enough for a few checks per second', () => {
    const g = toGray8(photo);
    const t = performance.now();
    for (let i = 0; i < 5; i++) checkFrame(g, W, H);
    expect((performance.now() - t) / 5).toBeLessThan(150); // ms per check on the test machine (a phone is several times slower)
  });
});

describe('analysis frame size and pixel conversion', () => {
  it('keeps the aspect and never enlarges', () => {
    expect(checkSize(1920, 1080)).toEqual({ w: 720, h: 405 });
    expect(checkSize(640, 480)).toEqual({ w: 640, h: 480 });
    expect(checkSize(1080, 1920)).toEqual({ w: 405, h: 720 });
  });
  it('turns RGBA into grey', () => {
    expect(Array.from(rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1))).toEqual([255, 0]);
  });
});

const sq = (dx = 0, dy = 0) => [
  { x: 0.1 + dx, y: 0.1 + dy },
  { x: 0.9 + dx, y: 0.1 + dy },
  { x: 0.9 + dx, y: 0.9 + dy },
  { x: 0.1 + dx, y: 0.9 + dy },
];

describe('steady tracking and auto-capture', () => {
  it('counts how long the sheet has held still and restarts on movement', () => {
    const t = new SteadyTracker();
    expect(t.update(sq(), 0, 0.75)).toBe(0);
    expect(t.update(sq(), 250, 0.75)).toBe(250);
    expect(t.update(sq(0.0005), 500, 0.75)).toBe(500); // sensor noise is still steady
    expect(t.update(sq(0.05), 750, 0.75)).toBe(0); // moved: starts again
    expect(t.update(sq(0.05), 1000, 0.75)).toBe(250);
    expect(t.update(null, 1250, 0.75)).toBe(0);
    expect(t.update(sq(), 1500, 0.75)).toBe(0); // a fresh quad after losing it
  });

  it('fires once after 0.7 s with all corners found, not before, and not again for the same sheet', () => {
    const g = new AutoCaptureGate();
    expect(g.update(300, true, 300)).toBe(false);
    expect(g.update(AUTO_HOLD_MS - 1, true, 700)).toBe(false);
    expect(g.update(AUTO_HOLD_MS, true, 701)).toBe(true);
    // still looking at the same sheet, still steady: no second shot
    expect(g.update(2000, true, 2800)).toBe(false);
    expect(g.update(3000, true, 4000)).toBe(false);
    // the sheet leaves the view, the next one arrives and holds still
    expect(g.update(0, false, 4100)).toBe(false);
    expect(g.update(0, false, 4500)).toBe(false);
    expect(g.isArmed).toBe(true);
    expect(g.update(800, true, 6000)).toBe(true);
  });

  it('a manual shot also disarms until the sheet is gone', () => {
    const g = new AutoCaptureGate();
    g.shotTaken(0);
    expect(g.update(5000, true, 5000)).toBe(false);
    g.update(0, false, 5100);
    g.update(0, false, 5500);
    expect(g.update(900, true, 7000)).toBe(true);
  });

  it('does not fire without a quad', () => {
    const g = new AutoCaptureGate();
    expect(g.update(5000, false, 5000)).toBe(false);
  });
});

describe('viewfinder hints', () => {
  const quad = (o: Partial<CheckResult> = {}): CheckResult => ({ corners: [true, true, true, true], count: 4, quad: sq(), module: 4, ...o });
  it('asks to move back, closer or to hold steady, then says it is ready', () => {
    expect(markerHint({ corners: [false, false, false, false], count: 0, quad: null, module: null }, 0, false).tone).toBe('idle');
    expect(markerHint({ corners: [true, false, false, true], count: 2, quad: null, module: 4 }, 0, false).text).toBe('Move back: 2 of 4 corner squares in view');
    expect(markerHint(quad({ module: 1.2 }), 900, false).text).toMatch(/Move closer/);
    expect(markerHint(quad(), 100, false)).toMatchObject({ text: 'Hold steady', tone: 'steady' });
    expect(markerHint(quad(), 900, false)).toMatchObject({ tone: 'ready', text: 'All four corners found. Tap the shutter' });
    expect(markerHint(quad(), 900, true).text).toMatch(/Capturing/);
  });
});
