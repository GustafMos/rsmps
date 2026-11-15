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
