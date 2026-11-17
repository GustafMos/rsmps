import { describe, expect, it, vi } from 'vitest';
import { LongPress, tooltipFor } from './longPress';

describe('LongPress', () => {
  const make = () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    return { lp: new LongPress({ onFire }), onFire };
  };

  it('fires once after 500 ms when the finger stays put', () => {
    const { lp, onFire } = make();
    lp.start(100, 200, 1);
    vi.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onFire).toHaveBeenCalledWith(100, 200);
    expect(lp.fired).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('tolerates a little jitter but not a real move', () => {
    const { lp, onFire } = make();
    lp.start(100, 100, 1);
    expect(lp.move(104, 103, 1)).toBe(true);
    vi.advanceTimersByTime(600);
    expect(onFire).toHaveBeenCalledTimes(1);
    lp.start(100, 100, 2);
    vi.advanceTimersByTime(200);
    expect(lp.move(130, 100, 2)).toBe(false);
    vi.advanceTimersByTime(600);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(lp.pending).toBe(false);
    vi.useRealTimers();
  });

  it('is cancelled by a release, and ignores moves of other pointers', () => {
    const { lp, onFire } = make();
    lp.start(0, 0, 1);
    lp.move(500, 500, 2); // another finger
    lp.cancel();
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
    lp.start(0, 0, 1);
    lp.move(500, 500, 2);
    vi.advanceTimersByTime(600);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('starting again resets fired and restarts the clock', () => {
    const { lp, onFire } = make();
    lp.start(1, 1, 1);
    vi.advanceTimersByTime(600);
    expect(lp.fired).toBe(true);
    lp.start(5, 5, 1);
    expect(lp.fired).toBe(false);
    vi.advanceTimersByTime(499);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    expect(onFire).toHaveBeenLastCalledWith(5, 5);
    vi.useRealTimers();
  });

  it('honours a custom delay and tolerance', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const lp = new LongPress({ onFire, delay: 200, tolerance: 20 });
    lp.start(0, 0);
    expect(lp.move(15, 0)).toBe(true);
    vi.advanceTimersByTime(201);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('tooltipFor', () => {
  it('is null without a DOM element', () => {
    expect(tooltipFor(null)).toBeNull();
  });
});
