import { describe, expect, it } from 'vitest';
import { beatFrames, detectBeats } from './beats';
import { drawingAt, expandTimeline, resolveHolds, startFrames, totalFrames } from './holds';

describe('holds', () => {
  it('shoots on ones by default and on twos / threes globally', () => {
    expect(expandTimeline(3)).toEqual([0, 1, 2]);
    expect(expandTimeline(3, { shootOn: 2 })).toEqual([0, 0, 1, 1, 2, 2]);
    expect(resolveHolds(2, { shootOn: 3 })).toEqual([3, 3]);
  });
  it('per-drawing holds override the global rate; invalid entries fall back', () => {
    const h = resolveHolds(4, { shootOn: 2, holds: [1, 5, undefined, 0.2] });
    expect(h).toEqual([1, 5, 2, 2]);
    expect(totalFrames(h)).toBe(10);
    expect(startFrames(h)).toEqual([0, 1, 6, 8]);
    expect(drawingAt(h, 0)).toBe(0);
    expect(drawingAt(h, 5)).toBe(1);
    expect(drawingAt(h, 6)).toBe(2);
    expect(drawingAt(h, 99)).toBe(3);
  });
});

describe('beat detector', () => {
  it('finds hits in silence and ignores a steady tone', () => {
    const sr = 22050;
    const pcm = new Float32Array(sr * 4);
    const hits = [0.5, 1.5, 2.5, 3.2];
    for (const t of hits) for (let i = 0; i < 2000; i++) pcm[Math.round(t * sr) + i] = Math.sin(i * 0.3) * Math.exp(-i / 500);
    const found = detectBeats([pcm], sr);
    expect(found.length).toBe(4);
    found.forEach((f, i) => expect(Math.abs(f - hits[i])).toBeLessThan(0.08));
    expect(beatFrames(found, 12)).toEqual(hits.map((t) => Math.round(t * 12)));
    const tone = new Float32Array(sr * 3).map((_, i) => 0.4 * Math.sin(i * 0.2));
    expect(detectBeats([tone], sr)).toEqual([]);
  });
});
