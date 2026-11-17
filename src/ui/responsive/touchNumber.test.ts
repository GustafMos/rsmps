import { describe, expect, it } from 'vitest';
import { scrubIntent, stepValue, wantsSteppers } from './touchNumber';

describe('scrubIntent', () => {
  it('waits inside the slop (a tap may follow)', () => {
    expect(scrubIntent(3, 2)).toBe('undecided');
  });
  it('horizontal drags scrub, vertical ones are page scroll', () => {
    expect(scrubIntent(20, 4)).toBe('scrub');
    expect(scrubIntent(-20, 8)).toBe('scrub');
    expect(scrubIntent(4, 30)).toBe('scroll');
    expect(scrubIntent(14, 14)).toBe('scroll'); // a diagonal is ambiguous: scrolling wins
  });
});

describe('stepValue', () => {
  it('adds and subtracts one step without float dust', () => {
    expect(stepValue(0.2, 1, { step: 0.1 })).toBe(0.3);
    expect(stepValue(0.3, -1, { step: 0.1 })).toBe(0.2);
    expect(stepValue(1.005, 1, { step: 0.01 })).toBe(1.015);
  });
  it('clamps to the range', () => {
    expect(stepValue(0.95, 1, { step: 0.1, max: 1 })).toBe(1);
    expect(stepValue(1, -1, { step: 5, min: 1 })).toBe(1);
  });
  it('moves integers by at least one', () => {
    expect(stepValue(24, 1, { step: 0.1, integer: true })).toBe(25);
    expect(stepValue(24, -1, { step: 2, integer: true })).toBe(22);
  });
});

describe('wantsSteppers', () => {
  it('only on touch and only when there is room', () => {
    expect(wantsSteppers(true, 300)).toBe(true);
    expect(wantsSteppers(true, 92)).toBe(false);
    expect(wantsSteppers(false, 300)).toBe(false);
  });
});
