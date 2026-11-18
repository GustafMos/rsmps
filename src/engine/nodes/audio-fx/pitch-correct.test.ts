import { describe, expect, it } from 'vitest';
import { SR, allFinite, getDef, noise, pitchHz, rms, runKernel, sine, voice } from '../../audio/testing';

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const cents = (f: number, note: number) => 1200 * Math.log2(f / hz(note));
const secs = (s: number) => Math.round(s * SR);
const run = (x: Float32Array, params: Record<string, unknown> = {}) => runKernel(getDef('pitch-correct'), { params, inputs: { audio: x }, frames: x.length }).out.audio[0];
/** A voice-like tone whose pitch follows `pitch(t)` (fractional MIDI note). */
function sing(seconds: number, pitch: (t: number) => number, amp = 0.4): Float32Array {
  const n = secs(seconds);
  const o = new Float32Array(n);
  const g = [0.5, 1, 0.8, 0.5, 0.3, 0.2];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * hz(pitch(i / SR))) / SR;
    let v = 0;
    for (let h = 0; h < g.length; h++) v += g[h] * Math.sin(ph * (h + 1));
    o[i] = (amp * v) / 2.6;
  }
  return o;
}
/** Pitch of the output in the settled part. */
const settled = (y: Float32Array, at = 0.9) => pitchHz(y, SR, secs(at));

describe('pitch-correct', () => {
  it.each([
    ['30 cents sharp', 60.3, 60],
    ['45 cents flat', 63.55, 64],
    ['low voice, 40 cents flat', 44.6, 45],
    ['high voice, 35 cents sharp', 76.35, 76],
  ])('a voice %s lands on the note', (_n, sung, want) => {
    const y = run(sing(1.6, () => sung as number));
    expect(Math.abs(cents(settled(y), want as number))).toBeLessThan(6);
    expect(allFinite(y)).toBe(true);
  });
  it('a sine is tuned too, and a voice already in tune is left where it is', () => {
    expect(Math.abs(cents(settled(run(sine(hz(57.4), secs(1.6), SR, 0.4))), 57))).toBeLessThan(6);
    expect(Math.abs(cents(settled(run(voice(hz(62), secs(1.6), SR, 0.4))), 62))).toBeLessThan(4);
  });
  it('keeps to the scale: C#4 sung in C major becomes D4 or C4, whichever is nearer', () => {
    expect(Math.abs(cents(settled(run(sing(1.6, () => 61.4), { scale: 'major', key: '0' })), 62))).toBeLessThan(8);
    expect(Math.abs(cents(settled(run(sing(1.6, () => 60.7), { scale: 'major', key: '0' })), 60))).toBeLessThan(8);
    // the same note in D major (which has C#) goes to C#
    expect(Math.abs(cents(settled(run(sing(1.6, () => 61.3), { scale: 'major', key: '2' })), 61))).toBeLessThan(8);
  });
  it('Amount 0 leaves the pitch as sung; Mix 0 is the dry voice, delayed', () => {
    expect(Math.abs(cents(settled(run(sing(1.6, () => 60.3), { amount: 0 })), 60.3))).toBeLessThan(5);
    const x = sing(1, () => 60.3);
    const delayOf = (params: Record<string, unknown>) => {
      const y = run(x, { mix: 0, ...params });
      const delay = y.findIndex((v) => Math.abs(v) > 1e-6) - x.findIndex((v) => Math.abs(v) > 1e-6);
      for (const i of [12000, 20000, 33333]) expect(y[i + delay]).toBeCloseTo(x[i], 6);
      return delay / SR;
    };
    const normal = delayOf({});
    expect(normal).toBeGreaterThan(0.06);
    expect(normal).toBeLessThan(0.085);
    const low = delayOf({ lowDelay: true }); // for live singing: about 30 ms sooner
    expect(low).toBeGreaterThan(0.035);
    expect(low).toBeLessThan(0.05);
    expect(Math.abs(cents(settled(run(sing(1.6, () => 60.3), { lowDelay: true })), 60))).toBeLessThan(6);
  });
  it('Shift moves the voice by whole semitones on top of the tuning', () => {
    expect(Math.abs(cents(settled(run(sing(1.6, () => 60.3), { shift: 7 })), 67))).toBeLessThan(8);
    expect(Math.abs(cents(settled(run(sing(1.6, () => 60.3), { shift: -5 })), 55))).toBeLessThan(8);
    expect(Math.abs(cents(settled(run(sing(1.6, () => 57), { shift: 12 })), 69))).toBeLessThan(8);
  });
  it('keeps the level, tuned up or down', () => {
    const x = sing(1.6, () => 60.4);
    const lvl = (y: Float32Array) => rms(y, secs(0.8), secs(1.4)) / rms(x, secs(0.8), secs(1.4));
    for (const shift of [0, 5, -5, 12]) {
      const r = lvl(run(x, { shift }));
      expect(r, `shift ${shift}`).toBeGreaterThan(0.8);
      expect(r, `shift ${shift}`).toBeLessThan(1.25);
    }
  });
  it('Retune 0 flattens vibrato (the hard effect); a slow retune keeps it', () => {
    const vib = sing(2.2, (t) => 62 + 0.5 * Math.sin(2 * Math.PI * 5.5 * t));
    /** Largest distance of the output pitch from D4 over the settled part, in cents. */
    const wobble = (y: Float32Array) => {
      let worst = 0;
      for (let t = 0.8; t < 1.9; t += 0.03) {
        const f = pitchHz(y, SR, secs(t), 150, 600);
        if (f > 0) worst = Math.max(worst, Math.abs(cents(f, 62)));
      }
      return worst;
    };
    const hard = wobble(run(vib, { speed: 0 }));
    const soft = wobble(run(vib, { speed: 400 }));
    expect(hard).toBeLessThan(22);
    expect(soft).toBeGreaterThan(30);
    expect(soft).toBeGreaterThan(hard * 1.5);
  });
  it('sound without a pitch passes through: noise keeps its level, silence stays silent, quiet sound is not tuned', () => {
    const nz = noise(secs(1), 3, 0.2);
    const y = run(nz);
    const r = rms(y, secs(0.3), secs(0.9)) / rms(nz, secs(0.3), secs(0.9));
    expect(r).toBeGreaterThan(0.85);
    expect(r).toBeLessThan(1.15);
    expect(rms(run(new Float32Array(secs(0.5))))).toBe(0);
    expect(Math.abs(cents(settled(run(sing(1.6, () => 60.3, 0.001))), 60.3))).toBeLessThan(6); // below the gate: as sung
  });
  it('a melody with pauses comes out as the tuned notes, in order', () => {
    const part = (note: number) => [...sing(0.6, () => note), ...new Float32Array(secs(0.15))];
    const x = Float32Array.from([...part(57.3), ...part(60.4), ...part(63.6)]);
    const y = run(x);
    expect(Math.abs(cents(pitchHz(y, SR, secs(0.35)), 57))).toBeLessThan(8);
    expect(Math.abs(cents(pitchHz(y, SR, secs(1.1)), 60))).toBeLessThan(8);
    expect(Math.abs(cents(pitchHz(y, SR, secs(1.85)), 64))).toBeLessThan(8);
    expect(allFinite(y)).toBe(true);
  });
});
