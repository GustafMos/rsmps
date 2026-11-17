import { describe, expect, it } from 'vitest';
import { wheelDeltaForZoom } from './viewerTouch';

describe('wheelDeltaForZoom', () => {
  it('inverts the viewer wheel formula exp(-deltaY * 0.0015)', () => {
    for (const ratio of [0.5, 0.9, 1, 1.25, 2, 4]) {
      expect(Math.exp(-wheelDeltaForZoom(ratio) * 0.0015)).toBeCloseTo(ratio, 6);
    }
  });
  it('zooms in with a negative delta and out with a positive one, like a wheel', () => {
    expect(wheelDeltaForZoom(2)).toBeLessThan(0);
    expect(wheelDeltaForZoom(0.5)).toBeGreaterThan(0);
  });
});
