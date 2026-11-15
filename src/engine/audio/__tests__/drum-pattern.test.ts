import { describe, expect, it } from 'vitest';
import { DRUM_VOICES, clearAll, clearVoice, countHits, defaultPattern, emptyPattern, euclidean, fillEvery, normalizePattern, randomizeVoice, rotateVoice, setStep, setSteps, setSwing, stepTime, toggleStep } from '../drum-pattern';

describe('drum pattern helpers', () => {
  it('empty and default patterns are well formed', () => {
    const e = emptyPattern();
    expect(e.steps).toBe(16);
    for (const v of DRUM_VOICES) expect(e.tracks[v]).toHaveLength(16);
    expect(countHits(e)).toBe(0);
    const d = defaultPattern();
    expect(d.tracks.kick[0]).toBe(1);
    expect(d.tracks.snare[4]).toBe(1);
    expect(countHits(d)).toBeGreaterThan(8);
  });
  it('edits are immutable', () => {
    const p = emptyPattern();
    const q = setStep(p, 'kick', 3, 0.7);
    expect(p.tracks.kick[3]).toBe(0);
    expect(q.tracks.kick[3]).toBe(0.7);
    expect(toggleStep(q, 'kick', 3).tracks.kick[3]).toBe(0);
    expect(toggleStep(p, 'snare', 5, 0.5).tracks.snare[5]).toBe(0.5);
    expect(setStep(p, 'kick', 99, 1)).toBe(p);
    expect(setStep(p, 'kick', 1, 7).tracks.kick[1]).toBe(1); // clamped
  });
  it('clear, steps, swing, rotate', () => {
    let p = setStep(setStep(emptyPattern(), 'kick', 0, 1), 'kick', 4, 1);
    expect(clearVoice(p, 'kick').tracks.kick.every((x) => x === 0)).toBe(true);
    expect(countHits(clearAll(setSwing(p, 0.3)))).toBe(0);
    const big = setSteps(p, 32);
    expect(big.steps).toBe(32);
    expect(big.tracks.kick.filter((x) => x > 0)).toHaveLength(4); // repeated
    expect(setSteps(big, 16).tracks.kick.filter((x) => x > 0)).toHaveLength(2);
    expect(setSwing(p, 5).swing).toBe(0.75);
    p = rotateVoice(p, 'kick', 2);
    expect(p.tracks.kick.map((x, i) => (x ? i : -1)).filter((i) => i >= 0)).toEqual([2, 6]);
    expect(rotateVoice(p, 'kick', -2).tracks.kick[0]).toBe(1);
  });
  it('fill, euclidean, random', () => {
    const p = emptyPattern();
    expect(fillEvery(p, 'chat', 2).tracks.chat.filter((x) => x > 0)).toHaveLength(8);
    const e = euclidean(p, 'kick', 5).tracks.kick;
    expect(e.filter((x) => x > 0)).toHaveLength(5);
    expect(euclidean(p, 'kick', 4).tracks.kick.map((x, i) => (x ? i : -1)).filter((i) => i >= 0)).toEqual([0, 4, 8, 12]);
    const a = randomizeVoice(p, 'snare', 0.5, 7).tracks.snare;
    expect(a).toEqual(randomizeVoice(p, 'snare', 0.5, 7).tracks.snare);
    expect(a).not.toEqual(randomizeVoice(p, 'snare', 0.5, 8).tracks.snare);
    expect(randomizeVoice(p, 'snare', 0, 1).tracks.snare.every((x) => x === 0)).toBe(true);
  });
  it('normalizePattern repairs bad data and survives a JSON round trip', () => {
    expect(normalizePattern(null).steps).toBe(16);
    const n = normalizePattern({ steps: 32, swing: 9, tracks: { kick: [1, 2, 'x'], bogus: [1] } });
    expect(n.steps).toBe(32);
    expect(n.swing).toBe(0.75);
    expect(n.tracks.kick.slice(0, 3)).toEqual([1, 1, 0]);
    expect(n.tracks.kick).toHaveLength(32);
    const d = defaultPattern();
    expect(normalizePattern(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it('step time includes swing on odd steps', () => {
    const p = setSwing(emptyPattern(), 0.5);
    expect(stepTime(p, 2, 0.125)).toBe(0.25);
    expect(stepTime(p, 3, 0.125)).toBeCloseTo(0.4375, 9);
  });
});
