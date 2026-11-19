import { describe, expect, it } from 'vitest';
import { datamoshFacts, datamoshStateText } from './DatamoshPanel';

describe('Codec Datamosh panel texts', () => {
  it('says plainly that it has to be moshed, and what is shown meanwhile', () => {
    expect(datamoshStateText('none', null)).toMatch(/Not moshed yet: the picture passes through unchanged.*Press Mosh/);
    expect(datamoshStateText('missing', null)).toMatch(/gone.*passes through unchanged.*Press Mosh/);
    expect(datamoshStateText('stale', null)).toMatch(/Out of date.*old mosh is still shown.*Mosh again/);
  });
  it('leaves progress and "done" to the generic sentences', () => {
    expect(datamoshStateText('done', null)).toBeNull();
    expect(datamoshStateText('none', { state: 'running' })).toBeNull();
    expect(datamoshStateText('stale', { state: 'queued' })).toBeNull();
  });
  it('a failed mosh says why and what is on screen now', () => {
    expect(datamoshStateText('none', { state: 'failed', error: 'no encoder' })).toBe('Mosh failed: no encoder. Nothing was stored; the picture passes through unchanged.');
    expect(datamoshStateText('stale', { state: 'failed', error: 'no encoder' }, true)).toBe('Mosh failed: no encoder. Nothing was stored; the last mosh is still shown.');
  });
  it('sums up what the last mosh did', () => {
    expect(datamoshFacts({ codec: 'H.264', mode: 'both', frames: 120, cuts: 2, removed: 2, removedAt: [25, 73], blooms: 2, item: null })).toBe('H.264 · 120 frames · 2 key frames removed at 25, 73 · 2 blooms');
    expect(datamoshFacts({ codec: 'VP9', mode: 'keys', frames: 48, cuts: 1, removed: 1, removedAt: [13], blooms: 0, item: 2 })).toBe('VP9 · 48 frames · 1 key frame removed at 13 · batch item 3 only');
  });
  it('tells the user when nothing was removed, and why; Bloom alone does not talk about key frames', () => {
    expect(datamoshFacts({ codec: 'H.264', mode: 'keys', frames: 60, cuts: 0, removed: 0, blooms: 0 })).toBe('H.264 · 60 frames · no cut found, no key frame removed');
    expect(datamoshFacts({ codec: 'H.264', mode: 'keys', frames: 60, cuts: 3, removed: 0, blooms: 0 })).toBe('H.264 · 60 frames · no key frame removed');
    expect(datamoshFacts({ codec: 'H.264', mode: 'bloom', frames: 60, cuts: 0, removed: 0, blooms: 1 })).toBe('H.264 · 60 frames · 1 bloom');
    expect(datamoshFacts({ codec: 'H.264', mode: 'bloom', frames: 60, cuts: 0, removed: 0, blooms: 0 })).toBe('H.264 · 60 frames · no bloom: nothing to repeat there');
    expect(datamoshFacts({})).toBeNull();
  });
});
