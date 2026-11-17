import { describe, expect, it } from 'vitest';
import { mixToStereo, stereoWeights } from './audio-util';

const ch = (v: number, n = 4) => new Float32Array(n).fill(v);

describe('stereo fold-down of decoded sound', () => {
  it('mono and stereo pass unchanged', () => {
    expect(stereoWeights(1)).toEqual({ left: [1], right: [1] });
    expect(stereoWeights(2)).toEqual({ left: [1, 0], right: [0, 1] });
    const out = [new Float32Array(6), new Float32Array(6)];
    mixToStereo(out, 1, [ch(0.25), ch(-0.5)]);
    expect([...out[0]]).toEqual([0, 0.25, 0.25, 0.25, 0.25, 0]);
    expect([...out[1]]).toEqual([0, -0.5, -0.5, -0.5, -0.5, 0]);
    const mono = [new Float32Array(4), new Float32Array(4)];
    mixToStereo(mono, 0, [ch(0.5)]);
    expect([...mono[0]]).toEqual([...mono[1]]);
    expect(mono[0][0]).toBe(0.5);
  });
  it('5.1 keeps the centre (speech) on both sides, the surrounds on their side, and leaves the LFE out', () => {
    const w = stereoWeights(6); // L R C LFE Ls Rs
    expect(w.left[2]).toBeGreaterThan(0);
    expect(w.left[2]).toBeCloseTo(w.right[2], 9);
    expect(w.left[3]).toBe(0);
    expect(w.right[3]).toBe(0);
    expect(w.left[4]).toBeGreaterThan(0);
    expect(w.right[4]).toBe(0);
    expect(w.right[5]).toBeGreaterThan(0);
    expect(w.left.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9); // full scale everywhere cannot clip
    const out = [new Float32Array(4), new Float32Array(4)];
    mixToStereo(out, 0, [ch(0), ch(0), ch(1), ch(1), ch(0), ch(0)]); // only centre and LFE carry sound
    expect(out[0][0]).toBeCloseTo(w.left[2], 6);
    expect(out[1][3]).toBeCloseTo(w.right[2], 6);
  });
  it('quad has no centre; a packet that reaches past the end is cut', () => {
    const w = stereoWeights(4);
    expect(w.left[2]).toBeGreaterThan(0);
    expect(w.right[2]).toBe(0);
    expect(w.right[3]).toBeGreaterThan(0);
    const out = [new Float32Array(3), new Float32Array(3)];
    mixToStereo(out, 2, [ch(1), ch(1), ch(1), ch(1), ch(1), ch(1)]);
    expect(out[0][2]).toBeCloseTo(1, 6);
    expect(out[0][1]).toBe(0);
  });
});
