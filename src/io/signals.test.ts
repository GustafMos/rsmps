import { describe, expect, it } from 'vitest';
import { SILENT_TRACKS, SignalRouter, needsInvalidate } from './signals';

describe('SignalRouter', () => {
  it('answers from the live source until an export begins, then from tracks, then live again', () => {
    const r = new SignalRouter();
    r.live = (id, name) => (id === 'n' && name === 'level' ? 0.7 : 0);
    expect(r.signal('n', 'level', 1)).toBe(0.7);
    const asked: number[] = [];
    r.beginExport({ fps: 10, value: (_i, _n, f) => (asked.push(f), f / 100) });
    expect(r.exporting).toBe(true);
    expect(r.signal('n', 'level', 0.5)).toBe(0.05); // frame 5, never the live value
    expect(asked).toEqual([5]);
    let ended = 0;
    r.onExportEnd = () => ended++;
    r.endExport();
    r.endExport();
    expect(ended).toBe(1);
    expect(r.exporting).toBe(false);
    expect(r.signal('n', 'level', 0.5)).toBe(0.7);
  });
  it('silent tracks never leak live values', () => {
    const r = new SignalRouter();
    r.live = () => 9;
    r.beginExport(SILENT_TRACKS(24));
    expect(r.signal('n', 'x', 3)).toBe(0);
  });
});

describe('needsInvalidate', () => {
  it('flushes caches on every non-sequential visit, only with live signals', () => {
    for (const ev of ['play', 'seek', 'step', 'wrap'] as const) {
      expect(needsInvalidate(true, ev)).toBe(true);
      expect(needsInvalidate(false, ev)).toBe(false);
    }
    expect(needsInvalidate(true, 'tick')).toBe(false);
  });
});

import { HISTORY_FRAMES, SignalHistory } from './signals';

describe('SignalHistory', () => {
  it('is write-once per frame', () => {
    const h = new SignalHistory();
    expect(h.record(5, 0.3)).toBe(true);
    expect(h.record(5, 0.9)).toBe(false);
    expect(h.get(5)).toBeCloseTo(0.3);
  });
  it('holds across dropped frames and falls back to the oldest value', () => {
    const h = new SignalHistory();
    h.record(10, 1);
    h.record(14, 2);
    expect(h.nearest(12)).toBe(1);
    expect(h.nearest(14)).toBe(2);
    expect(h.nearest(3)).toBe(1); // before everything: the oldest available
    expect(h.nearest(99)).toBe(2); // beyond: the newest
  });
  it('overwrites frames older than the ring size', () => {
    const h = new SignalHistory();
    h.record(1, 7);
    h.record(1 + HISTORY_FRAMES, 8);
    expect(h.get(1)).toBeUndefined();
    expect(h.get(1 + HISTORY_FRAMES)).toBe(8);
  });
});

describe('SignalRouter live history', () => {
  it('records the live value per frame once, so pulls of earlier frames see the past', () => {
    const r = new SignalRouter();
    r.fps = 10;
    let level = 0;
    r.live = () => level;
    const seen: number[] = [];
    for (let f = 0; f < 5; f++) {
      level = f / 10;
      r.recordFrame(f); // before the first request nothing is known: harmless
      seen.push(r.signal('n', 'v', f / 10));
    }
    seen.forEach((v, i) => expect(v).toBeCloseTo(i / 10));
    level = 0.9; // the signal moves on...
    expect(r.signal('n', 'v', 0.2)).toBeCloseTo(0.2); // ...but frame 2 stays what it was
    expect(r.signal('n', 'v', 0.4)).toBeCloseTo(0.4); // write-once: asking again does not re-sample
    expect(r.signal('n', 'v', 0.5)).toBeCloseTo(0.9); // a new frame samples now
  });
  it('recordFrame samples dropped frames and flushHistory starts a new pass', () => {
    const r = new SignalRouter();
    r.fps = 10;
    let level = 0.1;
    r.live = () => level;
    r.signal('n', 'v', 0);
    level = 0.5;
    r.recordFrame(3);
    expect(r.signal('n', 'v', 0.3)).toBeCloseTo(0.5);
    expect(r.signal('n', 'v', 0.1)).toBeCloseTo(0.1); // hold from frame 0
    r.flushHistory();
    level = 0.8;
    expect(r.signal('n', 'v', 0.3)).toBeCloseTo(0.8);
  });
  it('export lookups clamp out-of-range frames', () => {
    const r = new SignalRouter();
    r.beginExport({ fps: 10, value: (_n, _s, f) => Math.min(Math.max(f, 0), 5) });
    expect(r.signal('n', 'v', -3)).toBe(0);
    expect(r.signal('n', 'v', 100)).toBe(5);
  });
});
