import { describe, expect, it } from 'vitest';
import { RenderedFrameCache } from './frame-cache';

/** Plays `loops` passes over `total` frames, saving every frame that misses; returns the hits of each pass. */
function play(cache: RenderedFrameCache<number>, total: number, loops: number): number[] {
  const hits: number[] = [];
  for (let l = 0; l < loops; l++) {
    let h = 0;
    for (let f = 0; f < total; f++) {
      cache.setPlayhead(f, total, true);
      if (cache.get(f, 0)) h++;
      else cache.put(f, f, 1, 10);
    }
    hits.push(h);
  }
  return hits;
}

describe('RenderedFrameCache eviction by distance from the playhead', () => {
  it('a loop longer than the cache keeps what comes next: every later pass hits the same frames', () => {
    const cache = new RenderedFrameCache<number>(30 * 10, () => undefined); // room for 30 of 100
    const hits = play(cache, 100, 4);
    expect(hits).toEqual([0, 30, 30, 30]);
    expect(cache.frames.size).toBe(30);
  });
  it('oldest-first (no playhead known) thrashes: zero hits on every pass', () => {
    const cache = new RenderedFrameCache<number>(30 * 10, () => undefined);
    let hits = 0;
    for (let l = 0; l < 3; l++) {
      for (let f = 0; f < 100; f++) {
        if (cache.get(f, 0)) hits++;
        else cache.put(f, f, 1, 10);
      }
    }
    expect(hits).toBe(0);
  });
  it('a loop that fits is cached whole', () => {
    const cache = new RenderedFrameCache<number>(100 * 10, () => undefined);
    expect(play(cache, 100, 2)).toEqual([0, 100]);
  });
  it('paused: the frame farthest from the playhead (either direction) goes first', () => {
    const cache = new RenderedFrameCache<number>(3 * 10, () => undefined);
    cache.setPlayhead(50, 100, false);
    for (const f of [10, 49, 51]) cache.put(f, f, 1, 10);
    cache.put(52, 52, 1, 10);
    expect([...cache.frames].sort((a, b) => a - b)).toEqual([49, 51, 52]);
  });
  it('wraps around the end of the clip when measuring distance', () => {
    const cache = new RenderedFrameCache<number>(2 * 10, () => undefined);
    cache.setPlayhead(98, 100, false);
    for (const f of [1, 50, 99]) cache.put(f, f, 1, 10);
    expect([...cache.frames].sort((a, b) => a - b)).toEqual([1, 99]);
  });
  it('does not replace a sharper frame with a blurrier one', () => {
    const cache = new RenderedFrameCache<number>(100, () => undefined);
    cache.put(1, 1, 1, 10);
    expect(cache.put(1, 2, 0.5, 10)).toBe(false);
  });
});
