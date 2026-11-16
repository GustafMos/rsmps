import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_PIXELS, canAutoCapture, fitCanvas, isAllowedType, pickCapturePath, shrinkScales } from './scan-capture';

describe('capture path per platform', () => {
  it('Android Chrome (ImageCapture): takePhoto first, then a big frame, then the native camera', () => {
    expect(pickCapturePath({ imageCapture: true, trackMaxSide: 4032, noStream: false })).toEqual({ first: 'takePhoto', chain: ['takePhoto', 'grabFrame', 'nativeCamera'] });
  });
  it('a browser without ImageCapture but a big stream grabs the largest frame', () => {
    expect(pickCapturePath({ imageCapture: false, trackMaxSide: 3840, noStream: false }).first).toBe('grabFrame');
  });
  it('iOS Safari (no ImageCapture, stream about 1080p): the phone camera app, which always works', () => {
    expect(pickCapturePath({ imageCapture: false, trackMaxSide: 1920, noStream: false })).toEqual({ first: 'nativeCamera', chain: ['nativeCamera'] });
  });
  it('no viewfinder at all (permission refused, no https): only the native camera', () => {
    expect(pickCapturePath({ imageCapture: true, trackMaxSide: 4000, noStream: true })).toEqual({ first: 'nativeCamera', chain: ['nativeCamera'] });
  });
  it('auto-capture needs a path without a tap', () => {
    expect(canAutoCapture('takePhoto')).toBe(true);
    expect(canAutoCapture('grabFrame')).toBe(true);
    expect(canAutoCapture('nativeCamera')).toBe(false);
  });
});

describe('size arithmetic', () => {
  it('keeps a canvas within the phone limit and never enlarges', () => {
    expect(fitCanvas(4000, 3000)).toEqual({ w: 4000, h: 3000 }); // 12 MP
    const big = fitCanvas(8000, 6000);
    expect(big.w * big.h).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(big.w / big.h).toBeCloseTo(4 / 3, 2);
  });
  it('shrinks only when over the cap, in falling steps', () => {
    expect(shrinkScales(10_000_000)).toEqual([]);
    const s = shrinkScales(60 * 1024 * 1024);
    expect(s.length).toBeGreaterThan(1);
    expect(s[0]).toBeLessThan(1);
    expect(s[1]).toBeLessThan(s[0]);
  });
  it('accepts jpeg, png, webp only (HEIC is re-encoded as JPEG first)', () => {
    expect(isAllowedType('image/jpeg')).toBe(true);
    expect(isAllowedType('image/heic')).toBe(false);
    expect(isAllowedType('')).toBe(false);
  });
});
