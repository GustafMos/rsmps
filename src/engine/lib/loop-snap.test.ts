import { describe, expect, it } from 'vitest';
import { cyclePose, epochCount, snapMultiple, closeSequence, closingDrift, closingTurns, cyclesPerLoop, divisors, epochOf, hzForLoop, loopClockOf, loopFrameOf, snapNote, snapPeriod, stretchedStep, stretchedTurns, wholeCycles } from './loop-snap';

describe('wholeCycles', () => {
  it('rounds to the nearest whole number, half away from zero', () => {
    expect(wholeCycles(2.4)).toBe(2);
    expect(wholeCycles(2.5)).toBe(3);
    expect(wholeCycles(-2.5)).toBe(-3);
    expect(wholeCycles(-1.3)).toBe(-1);
  });
  it('never rounds a non-zero value to 0, and keeps 0', () => {
    expect(wholeCycles(0.37)).toBe(1);
    expect(wholeCycles(-0.2)).toBe(-1);
    expect(wholeCycles(0)).toBe(0);
  });
  it('does nothing with Loop off', () => {
    expect(wholeCycles(0.37, false)).toBe(0.37);
    expect(wholeCycles(1.3, false)).toBe(1.3);
  });
});

describe('per second rates', () => {
  it('fits a whole number of cycles in the loop', () => {
    expect(cyclesPerLoop(1.3, 4.625)).toBe(6); // 6.01 cycles
    expect(hzForLoop(1.3, 4.625)).toBeCloseTo(6 / 4.625, 12);
    expect(cyclesPerLoop(0.05, 3)).toBe(1); // minimum one cycle
    expect(cyclesPerLoop(0, 3)).toBe(0);
    expect(hzForLoop(1.3, 4.625, false)).toBe(1.3);
  });
});

describe('periods', () => {
  it('divisors', () => {
    expect(divisors(24)).toEqual([1, 2, 3, 4, 6, 8, 12, 24]);
    expect(divisors(37)).toEqual([1, 37]);
    expect(divisors(1)).toEqual([1]);
  });
  it('snapPeriod picks the nearest divisor of the frame count', () => {
    expect(snapPeriod(24, 5)).toBe(4); // 4 and 6 are equally near: the shorter
    expect(snapPeriod(24, 7)).toBe(6);
    expect(snapPeriod(24, 10)).toBe(8);
    expect(snapPeriod(96, 7)).toBe(6);
    expect(snapPeriod(37, 5)).toBe(1);
    expect(snapPeriod(24, 0.2)).toBe(1);
    expect(snapPeriod(24, 5, false)).toBe(5);
  });
  it('epochs of a period that does not divide the loop: the last one is shortened', () => {
    const e = Array.from({ length: 10 }, (_, f) => epochOf(f, 10, 4));
    expect(e).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
    expect(epochOf(10, 10, 4)).toBe(0); // frame N is frame 0
    expect(epochOf(-1, 10, 4)).toBe(2);
    expect(epochOf(12, 10, 4, false)).toBe(3);
  });
  it('poses cycle over a loop of any length', () => {
    expect(epochCount(37, 1)).toBe(37);
    expect(epochCount(37, 3)).toBe(13);
    // 13 epochs, 5 poses: 0 1 2 3 4 0 1 2 3 4 0 1 2, then the loop starts over with pose 0: no repeated pose at the seam
    const seq = Array.from({ length: 13 }, (_, e) => cyclePose(e, 13, 5));
    expect(seq).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2]);
    // 11 epochs, 5 poses: the last epoch would be pose 0 again (the first one): it takes pose 1
    expect(cyclePose(10, 11, 5)).toBe(1);
    expect(cyclePose(0, 1, 3)).toBe(0);
    expect(cyclePose(4, 5, 1)).toBe(0);
  });
  it('loopFrameOf wraps', () => {
    expect(loopFrameOf(37, 37)).toBe(0);
    expect(loopFrameOf(-1, 37)).toBe(36);
    expect(loopFrameOf(40, 37, false)).toBe(40);
  });
  it('loopClockOf', () => {
    expect(loopClockOf({ loop: true, duration: 4.625, fps: 8 })).toEqual({ loop: true, frames: 37, fps: 8 });
  });
});

describe('closing a discrete sequence', () => {
  it('closeSequence rounds the travel to a multiple of the length when that is close', () => {
    expect(closeSequence(2, 5)).toEqual({ travel: 2, snapped: false }); // 2 -> 5 is +150%: too far
    expect(closeSequence(4, 5)).toEqual({ travel: 5, snapped: true });
    expect(closeSequence(7, 5)).toEqual({ travel: 5, snapped: true });
    expect(closeSequence(-8, 5)).toEqual({ travel: -10, snapped: true });
    expect(closeSequence(6, 3)).toEqual({ travel: 6, snapped: false }); // already a multiple
    expect(closeSequence(3, 1)).toEqual({ travel: 3, snapped: false });
    expect(closeSequence(0, 5)).toEqual({ travel: 0, snapped: false });
  });
  it('snapMultiple always rounds to a whole tile', () => {
    expect(snapMultiple(1, 3)).toBe(3);
    expect(snapMultiple(-4, 3)).toBe(-3);
    expect(snapMultiple(5, 3)).toBe(6);
    expect(snapMultiple(0, 3)).toBe(0);
    expect(snapMultiple(2, 1)).toBe(2);
  });
  it('closingDrift makes the sequence end where it started', () => {
    for (const [travel, length] of [[2, 5], [3, 2], [-3, 4], [7, 5], [4, 4], [1, 5]] as const) {
      const d = closingDrift(travel, length);
      expect(Math.abs(d)).toBeLessThanOrEqual(length / 2 + 1e-9);
      expect((((travel + d) % length) + length) % length).toBeCloseTo(0, 9);
    }
    expect(closingDrift(6, 3)).toBe(0);
  });
  it('closingTurns closes a hue step', () => {
    const d = closingTurns(3, 37 / 360);
    expect(3 * (37 / 360) + d).toBeCloseTo(0, 9); // 111 degrees of travel is cancelled
    expect(closingTurns(2, 0.5)).toBe(0);
  });
  it('stretchedStep and stretchedTurns make the period divide the travel', () => {
    expect(stretchedStep(5, 5)).toBe(1);
    expect(stretchedStep(3, 2)).toBeCloseTo(4 / 3, 12);
    expect(3 * stretchedStep(3, 2)).toBeCloseTo(4, 12);
    expect(stretchedStep(1, 5)).toBe(5);
    expect(stretchedTurns(2, 0.25)).toBe(0.5); // half a turn in total rounds to one turn
    expect(stretchedTurns(2, 0.5)).toBe(0.5);
    expect(2 * stretchedTurns(2, 0.1)).toBeCloseTo(1, 12);
    expect(stretchedTurns(3, 0)).toBe(0);
  });
  it('snapNote says what changed', () => {
    expect(snapNote('speed', 2, 3)).toBe('speed 2 → 3 to loop');
    expect(snapNote('speed', 2, 2)).toBe('');
  });
});
