import { expect, it } from 'vitest';
import { harness } from '../../testing';

/** Bright 3x3 blob on black, centred. */
const blob = (w: number, h: number, s = 3) => (x: number, y: number): [number, number, number, number] =>
  Math.abs(x - w / 2) < s / 2 + 0.5 && Math.abs(y - h / 2) < s / 2 + 0.5 ? [255, 255, 255, 255] : [0, 0, 0, 255];

/** Mean brightness of pixels whose distance from the centre lies in [r0, r1) within an angular wedge (deg, +-half). */
function ring(px: { at(x: number, y: number): number[]; width: number; height: number }, r0: number, r1: number, centre = 0, half = 180) {
  let sum = 0;
  let n = 0;
  const cx = px.width / 2;
  const cy = px.height / 2;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      let a = (Math.atan2(dy, dx) * 180) / Math.PI - centre;
      a = ((a + 540) % 360) - 180;
      if (r >= r0 && r < r1 && Math.abs(a) <= half) {
        sum += px.at(x, y)[0];
        n++;
      }
    }
  return sum / Math.max(1, n);
}

it('a bright spot becomes a flat-topped disc of about the radius', async () => {
  const t = await harness();
  const src = t.fromFn(96, 96, blob(96, 96));
  const px = await t.pixels((await t.run('lens-blur', { radius: 12, highlightGain: 0, quality: 'high' }, { image: src })).image as never);
  const inner = ring(px, 0, 6);
  const mid = ring(px, 6, 10);
  const outside = ring(px, 15, 30);
  expect(inner).toBeGreaterThan(8);
  expect(mid).toBeGreaterThan(inner * 0.5); // flat top, not a bell
  expect(mid).toBeLessThan(inner * 1.8);
  expect(outside).toBeLessThan(inner * 0.15);
});

it('hexagon reaches further toward its corners than its flats', async () => {
  const t = await harness();
  const src = t.fromFn(128, 128, blob(128, 128, 7));
  const px = await t.pixels((await t.run('lens-blur', { radius: 24, shape: 'hexagon', rotation: 0, highlightGain: 0, quality: 'high' }, { image: src })).image as never);
  // corners at 0 deg (and every 60); flats at 30 deg
  const corner = ring(px, 22.5, 24, 0, 10) + ring(px, 22.5, 24, 60, 10) + ring(px, 22.5, 24, 120, 10);
  const flat = ring(px, 22.5, 24, 30, 10) + ring(px, 22.5, 24, 90, 10) + ring(px, 22.5, 24, 150, 10);
  expect(corner).toBeGreaterThan(flat * 1.2);
  const circle = await t.pixels((await t.run('lens-blur', { radius: 24, highlightGain: 0, quality: 'high' }, { image: src })).image as never);
  const cc = ring(circle, 22.5, 24, 0, 10);
  const cf = ring(circle, 22.5, 24, 30, 10);
  expect(Math.abs(cc - cf)).toBeLessThan(Math.max(cc, cf) * 0.5 + 0.5);
});

it('highlight boost makes bright spots bloom stronger than a plain blur', async () => {
  const t = await harness();
  const src = t.fromFn(96, 96, (x, y) => (Math.hypot(x - 48, y - 48) < 2 ? [255, 255, 255, 255] : [60, 60, 60, 255]));
  const plain = await t.pixels((await t.run('lens-blur', { radius: 10, highlightGain: 0 }, { image: src })).image as never);
  const boosted = await t.pixels((await t.run('lens-blur', { radius: 10, highlightGain: 12 }, { image: src })).image as never);
  expect(ring(boosted, 0, 5)).toBeGreaterThan(ring(plain, 0, 5) + 8);
});

it('same look at 2x resolution with unit 2', async () => {
  const t = await harness();
  const small = t.fromFn(64, 64, blob(64, 64, 3));
  const big = t.fromFn(128, 128, blob(128, 128, 6), 2);
  const a = await t.pixels((await t.run('lens-blur', { radius: 8, highlightGain: 0, quality: 'high' }, { image: small })).image as never);
  const b = await t.pixels((await t.run('lens-blur', { radius: 8, highlightGain: 0, quality: 'high' }, { image: big })).image as never);
  expect(Math.abs(ring(a, 0, 5) - ring(b, 0, 10) / 1)).toBeLessThan(ring(a, 0, 5) * 0.5 + 2);
  expect(ring(b, 24, 40)).toBeLessThan(ring(b, 0, 10) * 0.2);
  expect(ring(a, 12, 20)).toBeLessThan(ring(a, 0, 5) * 0.2);
});

it('transparent sprites defocus without a dark fringe', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 14 ? [255, 200, 0, 255] : [0, 0, 0, 0]));
  const px = await t.pixels((await t.run('lens-blur', { radius: 8, highlightGain: 0 }, { image: src })).image as never);
  let checked = 0;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const [r, g, , a] = px.at(x, y);
      if (a > 40 && a < 230) {
        checked++;
        expect(r).toBeGreaterThan(235);
        expect(g).toBeGreaterThan(180);
      }
    }
  expect(checked).toBeGreaterThan(20);
  expect(px.at(2, 2)[3]).toBe(0);
  expect(px.at(32, 32)[3]).toBe(255);
});

it('a depth map keeps the in-focus band sharp and blurs the rest', async () => {
  const t = await harness();
  const src = t.fromFn(64, 64, (x) => (x % 8 < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  // depth: left half in focus (0.5), right half far (1)
  const depth = t.fromFn(64, 64, (x) => (x < 32 ? [128, 128, 128, 255] : [255, 255, 255, 255]));
  const px = await t.pixels((await t.run('lens-blur', { radius: 8, focus: 0.5, range: 0.1, highlightGain: 0 }, { image: src, depth })).image as never);
  expect(px.at(10, 20)[0]).toBe(255); // in focus: untouched
  expect(px.at(12, 20)[0]).toBe(0);
  const far: number[] = [];
  for (let x = 44; x < 56; x++) far.push(px.at(x, 20)[0]);
  expect(Math.max(...far) - Math.min(...far)).toBeLessThan(120); // stripes washed out
});

it('radius 0 returns the input', async () => {
  const t = await harness();
  const src = t.solid(8, 8, [1, 2, 3, 255]);
  expect((await t.run('lens-blur', { radius: 0 }, { image: src })).image).toBe(src);
});
