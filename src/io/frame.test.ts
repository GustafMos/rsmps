import { describe, expect, it } from 'vitest';
import { harness } from '../engine/testing';
import { conformRect, effectiveConform, isCustomFrame, readFrameParams, resolveFrame } from './frame';
import { conformImage } from './frame-gpu';

const P = { width: 1920, height: 1080 };
const frame = (o: Record<string, unknown>, project = P) => resolveFrame(project, readFrameParams(o));

describe('resolveFrame', () => {
  it('project canvas by default', () => {
    expect(frame({})).toEqual(P);
    expect(isCustomFrame(P, frame({}))).toBe(false);
  });
  it('ratio presets keep the short side', () => {
    expect(frame({ frame: '9:16' })).toEqual({ width: 1080, height: 1920 });
    expect(frame({ frame: '1:1' })).toEqual({ width: 1080, height: 1080 });
    expect(frame({ frame: '21:9' })).toEqual({ width: 2520, height: 1080 });
    expect(frame({ frame: '4:5' })).toEqual({ width: 1080, height: 1350 });
    expect(frame({ frame: '16:9' })).toEqual({ width: 1920, height: 1080 });
    expect(frame({ frame: '2:3' })).toEqual({ width: 1080, height: 1620 });
  });
  it('keeps the short side of a portrait project too', () => {
    expect(frame({ frame: '16:9' }, { width: 1080, height: 1920 })).toEqual({ width: 1920, height: 1080 });
  });
  it('rounds presets to even numbers', () => {
    const f = frame({ frame: '4:3' }, { width: 1000, height: 999 });
    expect(f.width % 2).toBe(0);
    expect(f.height % 2).toBe(0);
    expect(frame({ frame: '3:4' }, { width: 1000, height: 1001 })).toEqual({ width: 1000, height: 1334 });
  });
  it('custom is literal', () => {
    expect(frame({ frame: 'custom', frameWidth: 321, frameHeight: 123 })).toEqual({ width: 321, height: 123 });
  });
  it('orientation swaps only when it disagrees, with any frame', () => {
    expect(frame({ orientation: 'portrait' })).toEqual({ width: 1080, height: 1920 });
    expect(frame({ orientation: 'landscape' })).toEqual(P);
    expect(frame({ frame: '9:16', orientation: 'landscape' })).toEqual({ width: 1920, height: 1080 });
    expect(frame({ frame: 'custom', frameWidth: 100, frameHeight: 300, orientation: 'landscape' })).toEqual({ width: 300, height: 100 });
    expect(frame({ frame: '1:1', orientation: 'portrait' })).toEqual({ width: 1080, height: 1080 });
  });
  it('ignores junk params', () => {
    expect(frame({ frame: 'nope', orientation: 5, frameWidth: 'x' })).toEqual(P);
  });
});

describe('conform', () => {
  const src = { width: 200, height: 100 };
  it('auto means none for the project frame as-is, fill otherwise', () => {
    expect(effectiveConform(readFrameParams({}))).toBe('none');
    expect(effectiveConform(readFrameParams({ orientation: 'portrait' }))).toBe('fill');
    expect(effectiveConform(readFrameParams({ frame: '1:1' }))).toBe('fill');
    expect(effectiveConform(readFrameParams({ frame: '1:1', conform: 'none' }))).toBe('none');
  });
  it('fill covers and centre-crops', () => {
    expect(conformRect(src, { width: 100, height: 100 }, 'fill')).toEqual({ x: -50, y: 0, w: 200, h: 100 });
  });
  it('fill honours the anchor', () => {
    const dst = { width: 100, height: 100 };
    expect(conformRect(src, dst, 'fill', 'left')?.x).toBe(0);
    expect(conformRect(src, dst, 'fill', 'right')?.x).toBe(-100);
    expect(conformRect({ width: 100, height: 200 }, dst, 'fill', 'top')?.y).toBe(0);
    expect(conformRect({ width: 100, height: 200 }, dst, 'fill', 'bottom')?.y).toBe(-100);
  });
  it('fit leaves bars', () => {
    expect(conformRect(src, { width: 100, height: 100 }, 'fit')).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });
  it('stretch fills the frame; none and same size do nothing', () => {
    expect(conformRect(src, { width: 50, height: 80 }, 'stretch')).toEqual({ x: 0, y: 0, w: 50, h: 80 });
    expect(conformRect(src, { width: 50, height: 80 }, 'none')).toBeNull();
    expect(conformRect(src, src, 'fill')).toBeNull();
  });
});

describe('conformImage on the GPU', () => {
  it('fill crops, fit pads with transparency, enlarging stays crisp', async () => {
    const t = await harness();
    // 4x2: left half red, right half blue.
    const img = t.fromFn(4, 2, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const fill = conformImage(t.gpu, img, { width: 2, height: 2 }, 'fill', 'left');
    let px = await t.pixels(fill);
    expect([fill.width, fill.height]).toEqual([2, 2]);
    expect(px.at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px.at(1, 1)).toEqual([255, 0, 0, 255]);
    const fit = conformImage(t.gpu, img, { width: 4, height: 4 }, 'fit', 'center');
    px = await t.pixels(fit);
    expect(px.at(0, 0)[3]).toBe(0); // bar
    expect(px.at(0, 1)).toEqual([255, 0, 0, 255]);
    expect(px.at(3, 2)).toEqual([0, 0, 255, 255]);
    expect(px.at(2, 3)[3]).toBe(0);
    const big = conformImage(t.gpu, img, { width: 40, height: 20 }, 'stretch', 'center');
    px = await t.pixels(big);
    expect(px.at(19, 10)).toEqual([255, 0, 0, 255]); // hard edge, no blend
    expect(px.at(20, 10)).toEqual([0, 0, 255, 255]);
    expect(conformImage(t.gpu, img, { width: 4, height: 2 }, 'fill', 'center')).toBe(img);
  });
});
