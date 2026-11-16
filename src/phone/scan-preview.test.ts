import { describe, expect, it } from 'vitest';
import { counterText, frameAt, isMissingFrame, realFrameNumber, spriteRect } from './scan-preview';

describe('preview playback', () => {
  const meta = { count: 10, cols: 4, fw: 100, fh: 50, step: 2, total: 20, missingFrames: [5] };
  it('finds the cell of a sprite frame', () => {
    expect(spriteRect(meta, 0)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50 });
    expect(spriteRect(meta, 5)).toEqual({ sx: 100, sy: 50, sw: 100, sh: 50 });
    expect(spriteRect(meta, 12)).toEqual(spriteRect(meta, 2)); // wraps
  });
  it('loops at the playback rate', () => {
    expect(frameAt(0, 6, 10)).toBe(0);
    expect(frameAt(1000, 6, 10)).toBe(6);
    expect(frameAt(2000, 6, 10)).toBe(2);
    expect(frameAt(500, 6, 10, 8)).toBe(1);
    expect(frameAt(-5, 6, 10)).toBe(0);
    expect(frameAt(100, 0, 10)).toBe(0);
  });
  it('counts in the real animation even when frames were skipped', () => {
    expect(realFrameNumber(meta, 3)).toBe(7);
    expect(counterText(meta, 3)).toBe('Frame 7 / 20');
    expect(isMissingFrame(meta, 2)).toBe(true); // real frame 5
    expect(isMissingFrame(meta, 3)).toBe(false);
  });
});
