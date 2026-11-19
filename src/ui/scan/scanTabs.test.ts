// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ScanResult } from '../../io/api';
import { pruneScanTabs, scanBarState, scanBusy, scanTab } from './scanTabs';

const result = () => ({ dispose: vi.fn() }) as unknown as ScanResult & { dispose: ReturnType<typeof vi.fn> };
const later = () => new Promise((r) => setTimeout(r, 5));

describe('scan state per project', () => {
  it('a scan project keeps its pages and its running scan while another tab is open', () => {
    const a = scanTab('proj-a');
    const r = result();
    a.setResult(r);
    a.setBusy('Looking for the page markers in 12 photos…');
    a.setProgress({ names: ['1.jpg'], states: ['scanning'], completed: 0, total: 12, concurrency: 4 });
    // the Scan screen goes away and comes back: the same state is there, nothing was disposed or cancelled
    const again = scanTab('proj-a');
    expect(again).toBe(a);
    expect(again.result).toBe(r);
    expect(again.ref.current).toBe(r);
    expect(again.progress?.total).toBe(12);
    expect(scanBusy('proj-a')).toBe(true);
    expect(r.dispose).not.toHaveBeenCalled();
    expect(scanTab('proj-b')).not.toBe(a);
    expect(scanBusy('proj-b')).toBe(false);
    pruneScanTabs([]);
  });
  it('tells the screen about changes, and releases a result only when another replaces it', async () => {
    const t = scanTab('proj-c');
    const seen = vi.fn();
    const off = t.subscribe(seen);
    const first = result();
    const second = result();
    t.setResult(first);
    t.setProgress((p) => p); // an updater works like a value
    t.setBusy('x');
    expect(seen).toHaveBeenCalledTimes(3);
    t.setResult(second);
    await later();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    off();
    t.setBusy(null);
    expect(seen).toHaveBeenCalledTimes(4);
    pruneScanTabs([]);
  });
  it('closing the project cancels its scan and releases its pages; open projects are untouched', () => {
    const keep = scanTab('open');
    const gone = scanTab('closed');
    const r = result();
    const ac = new AbortController();
    gone.setResult(r);
    gone.abortRef.current = ac;
    const kept = result();
    keep.setResult(kept);
    expect(pruneScanTabs(['open', 'some-graph-project'])).toEqual(['closed']);
    expect(ac.signal.aborted).toBe(true);
    expect(r.dispose).toHaveBeenCalled();
    expect(kept.dispose).not.toHaveBeenCalled();
    expect(scanTab('open')).toBe(keep);
    expect(scanTab('closed')).not.toBe(gone); // a fresh, empty state if that id is ever used again
    pruneScanTabs([]);
  });
});

describe('the scan progress bar', () => {
  const progress = (completed: number, total: number) => ({ names: [], states: [], completed, total, concurrency: 4 });
  it('counts photos while they are read', () => {
    expect(scanBarState('Looking…', progress(3, 12))).toEqual({ percent: 25, text: 'Scanning 3 of 12 (4 at a time)' });
  });
  it('does not stand at 100 % while the frames are still being put together', () => {
    const done = scanBarState('Looking…', progress(12, 12))!;
    expect(done.percent).toBeNull(); // a moving bar, not a full one
    expect(done.text).toBe('All 12 photos read. Putting the frames together…');
    expect(scanBarState('Looking…', progress(1, 1))!.text).toBe('All 1 photo read. Putting the frames together…');
  });
  it('shows the plain message before the first photo is counted, and nothing when idle', () => {
    expect(scanBarState('Restoring your scan…', null)).toEqual({ percent: null, text: 'Restoring your scan…' });
    expect(scanBarState(null, progress(12, 12))).toBeNull();
  });
});
