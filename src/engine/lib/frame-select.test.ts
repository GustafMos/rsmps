import { describe, expect, it } from 'vitest';
import { candidateTimes, lumaThumb, motionBetween, selectFrames, sharpnessOf, type FrameCandidate } from './frame-select';

/** A textured strip seen through a window at horizontal offset `x` (camera motion = x changes), optionally blurred and brighter. */
function frame(x: number, { blur = 0, gain = 1 } = {}): { rgba: Uint8ClampedArray; w: number; h: number } {
  const w = 96, h = 54;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const tex = (u: number, v: number) => (Math.sin(u * 0.9) * Math.cos(v * 1.3) > 0 ? 220 : 30) + 20 * Math.sin(u * 3.1 + v);
  for (let y = 0; y < h; y++)
    for (let px = 0; px < w; px++) {
      let s = 0;
      const taps = blur ? 9 : 1;
      for (let k = 0; k < taps; k++) s += tex(px + x + (blur ? ((k - 4) * blur) / 4 : 0), y);
      const v = Math.min(255, (s / taps) * gain);
      rgba.set([v, v, v, 255], (y * w + px) * 4);
    }
  return { rgba, w, h };
}
const cand = (seconds: number, x: number, o?: { blur?: number; gain?: number }): FrameCandidate => {
  const f = frame(x, o);
  const big = lumaThumb(f.rgba, f.w, f.h, f.w, f.h);
  return { seconds, sharpness: sharpnessOf(big, f.w, f.h), thumb: lumaThumb(f.rgba, f.w, f.h, 48, 27) };
};

describe('frame selection', () => {
  it('candidate times are whole frames inside the range', () => {
    expect(candidateTimes(0, 1, 10, 4)).toEqual([0, 0.2, 0.5, 0.7]);
    expect(candidateTimes(0, 0.3, 10, 50)).toEqual([0, 0.1, 0.2]); // every frame when there are fewer
    expect(candidateTimes(1, 2, 30, 3).every((t) => t >= 1 && t < 2)).toBe(true);
  });

  it('sharpness ranks a blurred frame below a sharp one; brightness changes are not motion', () => {
    expect(cand(0, 0).sharpness).toBeGreaterThan(cand(0, 0, { blur: 6 }).sharpness * 2);
    expect(motionBetween(cand(0, 5).thumb, cand(0, 5, { gain: 1.15 }).thumb)).toBeLessThan(0.02);
    expect(motionBetween(cand(0, 5).thumb, cand(0, 9).thumb)).toBeGreaterThan(0.05);
  });

  it('a static stretch in the middle of a pan gets almost no frames', () => {
    // 0..39: moving 1 px per frame; 40..119: standing still; 120..159: moving again
    const c: FrameCandidate[] = [];
    let x = 0;
    for (let i = 0; i < 160; i++) {
      if (i < 40 || i >= 120) x += 1;
      c.push(cand(i / 30, x));
    }
    const { picks } = selectFrames(c, 20, 0);
    const inStill = picks.filter((i) => i > 41 && i < 119).length;
    expect(picks.length).toBeGreaterThanOrEqual(15);
    expect(inStill).toBeLessThanOrEqual(1);
  });

  it('within each window the sharpest frame wins', () => {
    const c: FrameCandidate[] = [];
    for (let i = 0; i < 60; i++) c.push(cand(i / 30, i, { blur: i % 3 === 1 ? 0 : 6 })); // only every third frame is sharp
    const { picks } = selectFrames(c, 10, 0);
    expect(picks.length).toBe(10);
    expect(picks.every((i) => i % 3 === 1)).toBe(true);
  });

  it('a clip that hardly moves gives few picks (minimum motion between picks), never zero', () => {
    const still = Array.from({ length: 50 }, (_, i) => cand(i / 30, i * 0.02));
    const { picks } = selectFrames(still, 80, 0.05);
    expect(picks.length).toBeGreaterThanOrEqual(1);
    expect(picks.length).toBeLessThan(5);
    expect(selectFrames([], 10, 0).picks).toEqual([]);
  });
});
