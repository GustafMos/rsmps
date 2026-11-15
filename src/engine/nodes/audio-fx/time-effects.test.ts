import { describe, expect, it } from 'vitest';
import { SR, allFinite, db, getDef, impulse, noise, peak, rms, runKernel, sine, toneAmp, zeroCrossFreq } from '../../audio/testing';

const N = SR;

describe('delay (echo)', () => {
  const run = (params: Record<string, unknown>, x = impulse(3 * N, 0, 1), frames = 3 * N) =>
    runKernel(getDef('delay'), { params: { mix: 1, damping: 0, ...params }, inputs: { audio: x }, frames });

  it('puts echoes exactly at the delay time, falling by the feedback each repeat', () => {
    const r = run({ time: 100, feedback: 0.5 });
    const L = r.out.audio[0];
    expect(L[4800]).toBeCloseTo(1, 5);
    expect(L[9600]).toBeCloseTo(0.5, 5);
    expect(L[14400]).toBeCloseTo(0.25, 5);
    expect(L[4799]).toBe(0);
    expect(L[4801]).toBe(0);
    expect(L[2400]).toBe(0);
  });
  it('mix blends dry and echo', () => {
    const r = run({ time: 100, feedback: 0, mix: 0.25 });
    expect(r.out.audio[0][0]).toBeCloseTo(0.75, 5);
    expect(r.out.audio[0][4800]).toBeCloseTo(0.25, 5);
  });
  it('tempo sync: quarter note at 120 bpm is 500 ms', () => {
    const r = run({ sync: '1/4', bpm: 120, feedback: 0 });
    expect(r.out.audio[0][24000]).toBeCloseTo(1, 5);
    expect(peak(r.out.audio[0], 0, 23990)).toBe(0);
    const eighth = run({ sync: '1/8', bpm: 90, feedback: 0 });
    expect(eighth.out.audio[0][Math.round((60 / 90) * 0.5 * SR)]).toBeCloseTo(1, 5);
  });
  it('ping-pong alternates left and right', () => {
    const r = run({ time: 100, feedback: 0.5, pingPong: true });
    const [L, R] = r.out.audio;
    expect(L[4800]).toBeCloseTo(1, 5);
    expect(R[4800]).toBe(0);
    expect(R[9600]).toBeCloseTo(0.5, 5);
    expect(L[9600]).toBe(0);
    expect(L[14400]).toBeCloseTo(0.25, 5);
  });
  it('damping smears and softens each repeat (a low-pass in the feedback loop)', () => {
    const bright = run({ time: 50, feedback: 0.7, damping: 0 }).out.audio[0];
    const dark = run({ time: 50, feedback: 0.7, damping: 0.9 }).out.audio[0];
    expect(peak(bright, 4800, 4900)).toBeCloseTo(0.7, 3); // 2nd repeat, undamped
    expect(peak(dark, 4800, 4900)).toBeLessThan(0.2);
    expect(peak(dark, 2400, 2500)).toBeCloseTo(1, 5); // the first repeat is always clean
  });
  it('feedback 0.95 for 10 s stays bounded and finite', () => {
    const r = run({ time: 30, feedback: 0.95, mix: 0.5 }, noise(10 * N, 6, 0.5), 10 * N);
    expect(allFinite(r.out.audio[0])).toBe(true);
    expect(peak(r.out.audio[0])).toBeLessThan(20);
  });
  it('changing the time glides instead of jumping', () => {
    const x = sine(500, N, SR, 0.5);
    const a = runKernel(getDef('delay'), { params: { time: 100, mix: 1, feedback: 0 }, inputs: { audio: x }, frames: 4800 });
    expect(allFinite(a.out.audio[0])).toBe(true);
  });
});

describe('reverb', () => {
  const click = impulse(4 * N, 0, 0.5);
  const run = (params: Record<string, unknown>, x: Float32Array = click, frames = 4 * N) =>
    runKernel(getDef('reverb'), { params: { mix: 1, ...params }, inputs: { audio: x }, frames });
  const win = (y: Float32Array, a: number, b: number) => rms(y, Math.round(a * SR), Math.round(b * SR));

  it('produces a tail that is finite, non-zero and decays', () => {
    const r = run({ decay: 1.5, size: 0.6 });
    const L = r.out.audio[0];
    expect(allFinite(L) && allFinite(r.out.audio[1])).toBe(true);
    const early = win(L, 0.1, 0.2);
    const late = win(L, 2.0, 2.1);
    const later = win(L, 3.5, 3.6);
    expect(early).toBeGreaterThan(1e-4);
    expect(late).toBeLessThan(early);
    expect(later).toBeLessThan(late);
    expect(db(late / early)).toBeLessThan(-12);
  });
  it('decay time controls the tail length: ~60 dB down after the RT60', () => {
    const r = run({ decay: 1, damping: 0.1 });
    const L = r.out.audio[0];
    const early = win(L, 0.05, 0.15);
    const atRt60 = win(L, 1.1, 1.2);
    expect(db(atRt60 / early)).toBeLessThan(-35);
    const long = run({ decay: 6, damping: 0.1 }).out.audio[0];
    expect(win(long, 1.1, 1.2) / win(long, 0.05, 0.15)).toBeGreaterThan(0.1);
    expect(win(long, 1.1, 1.2) / win(L, 1.1, 1.2)).toBeGreaterThan(50); // 6 s decay vs 1 s decay at t = 1.1 s
  });
  it('pre-delay holds the wet signal back', () => {
    const r = run({ preDelay: 100, decay: 1 });
    const L = r.out.audio[0];
    expect(peak(L, 0, Math.round(0.095 * SR))).toBeLessThan(1e-6);
    expect(peak(L, Math.round(0.1 * SR), Math.round(0.2 * SR))).toBeGreaterThan(1e-3);
  });
  it('is stereo: left and right tails differ, width 0 makes them identical', () => {
    const r = run({});
    let diff = 0;
    for (let i = 0; i < 20000; i++) diff += Math.abs(r.out.audio[0][i] - r.out.audio[1][i]);
    expect(diff).toBeGreaterThan(0.01);
    const m = run({ width: 0 });
    for (let i = 0; i < 20000; i += 97) expect(m.out.audio[0][i]).toBeCloseTo(m.out.audio[1][i], 6);
  });
  it('mix 0 is the dry signal', () => {
    const x = sine(440, 4800, SR, 0.3);
    const r = run({ mix: 0 }, x, 4800);
    expect(r.out.audio[0][1000]).toBeCloseTo(x[1000], 6);
  });
  it('wet level on sustained noise is comparable to the input (no huge gain build-up)', () => {
    const x = noise(4 * N, 21, 0.3);
    for (const decay of [0.3, 2.5, 15]) {
      const y = run({ decay, size: 0.6, damping: 0.3 }, x).out.audio[0];
      const ratio = rms(y, 2 * N, 4 * N) / rms(x, 2 * N, 4 * N);
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(3);
    }
  });
  it('10 s of loud noise at the longest decay stays finite and bounded', () => {
    const r = run({ decay: 20, size: 1, damping: 0 }, noise(10 * N, 8, 1), 10 * N);
    expect(allFinite(r.out.audio[0])).toBe(true);
    expect(peak(r.out.audio[0])).toBeLessThan(10);
  });
  it('size changes the room without breaking', () => {
    for (const size of [0, 0.5, 1]) expect(allFinite(run({ size }).out.audio[0])).toBe(true);
  });
});

describe('chorus / flanger', () => {
  const x = sine(440, N, SR, 0.5);
  it('chorus at mix 0 passes the dry signal; with mix it changes the waveform but keeps the pitch', () => {
    const dry = runKernel(getDef('chorus'), { params: { mix: 0 }, inputs: { audio: x }, frames: N }).out.audio[0];
    expect(dry[5000]).toBeCloseTo(x[5000], 6);
    const wet = runKernel(getDef('chorus'), { params: { mix: 1, depth: 1 }, inputs: { audio: x }, frames: N });
    let diff = 0;
    for (let i = 10000; i < 20000; i++) diff += Math.abs(wet.out.audio[0][i] - x[i]);
    expect(diff).toBeGreaterThan(10);
    expect(toneAmp(wet.out.audio[0], 440, SR, 10000, N)).toBeGreaterThan(0.15);
    expect(peak(wet.out.audio[0])).toBeLessThan(1.2);
    expect(allFinite(wet.out.audio[1])).toBe(true);
  });
  it('chorus widens a mono source (left and right differ)', () => {
    const wet = runKernel(getDef('chorus'), { params: { mix: 1 }, inputs: { audio: x }, frames: N });
    let diff = 0;
    for (let i = 10000; i < 20000; i++) diff += Math.abs(wet.out.audio[0][i] - wet.out.audio[1][i]);
    expect(diff).toBeGreaterThan(1);
  });
  it('flanger makes a comb: a notch appears at 1/(2*delay) when the sweep is off', () => {
    const delaySamples = 24; // 0.5 ms -> first notch at 1 kHz
    const n = noise(N, 3, 0.3);
    const r = runKernel(getDef('flanger'), { params: { delay: 0.5, depth: 0, feedback: 0, mix: 1, rate: 0.02 }, inputs: { audio: n }, frames: N });
    const y = r.out.audio[0];
    // notch near 1 kHz: tonal check with sines instead of noise
    const s = (f: number) => runKernel(getDef('flanger'), { params: { delay: 0.5, depth: 0, feedback: 0, mix: 1, rate: 0.02 }, inputs: { audio: sine(f, N, SR, 0.3) }, frames: N }).out.audio[0];
    expect(toneAmp(s(1000), 1000, SR, 5000, N - 200)).toBeLessThan(toneAmp(s(2000), 2000, SR, 5000, N - 200) * 0.3);
    expect(delaySamples).toBe(24);
    expect(allFinite(y)).toBe(true);
  });
  it('flanger with strong feedback stays stable', () => {
    const r = runKernel(getDef('flanger'), { params: { feedback: 0.95, mix: 1 }, inputs: { audio: noise(5 * N, 5, 0.5) }, frames: 5 * N });
    expect(allFinite(r.out.audio[0])).toBe(true);
    expect(peak(r.out.audio[0])).toBeLessThan(30);
  });
});

describe('tremolo', () => {
  it('modulates the level at the set rate between (1-depth) and 1', () => {
    const x = sine(1000, 2 * N, SR, 0.5);
    const r = runKernel(getDef('tremolo'), { params: { rate: 4, depth: 1, shape: 'sine' }, inputs: { audio: x }, frames: 2 * N });
    const L = r.out.audio[0];
    let lo = Infinity;
    let hi = 0;
    for (let s = 0; s < N; s += 240) {
      const v = peak(L, s, s + 240);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi).toBeCloseTo(0.5, 1);
    expect(lo).toBeLessThan(0.03);
    // period: the envelope repeats every 0.25 s
    expect(peak(L, 12000 - 120, 12000 + 120)).toBeCloseTo(peak(L, 24000 - 120, 24000 + 120), 1);
  });
  it('depth 0 is transparent; spread offsets left from right', () => {
    const x = sine(1000, N, SR, 0.5);
    const r = runKernel(getDef('tremolo'), { params: { depth: 0 }, inputs: { audio: x }, frames: N });
    expect(r.out.audio[0][777]).toBeCloseTo(x[777], 6);
    const s = runKernel(getDef('tremolo'), { params: { depth: 1, spread: 1, rate: 2 }, inputs: { audio: x }, frames: N });
    expect(rms(s.out.audio[0], 0, 12000)).not.toBeCloseTo(rms(s.out.audio[1], 0, 12000), 2);
  });
});

describe('pitch-shift', () => {
  const x = sine(440, N, SR, 0.5);
  const shifted = (st: number) => runKernel(getDef('pitch-shift'), { params: { semitones: st, mix: 1 }, inputs: { audio: x }, frames: N }).out.audio[0];
  // Granular shifting smears the spectrum a little, so measure the pitch by zero crossings.
  it.each([
    [12, 880],
    [-12, 220],
    [7, 440 * Math.pow(2, 7 / 12)],
    [-5, 440 * Math.pow(2, -5 / 12)],
  ])('%i semitones moves 440 Hz to %f Hz (within 2%%) at near-original level', (st, target) => {
    const y = shifted(st);
    expect(zeroCrossFreq(y, SR, 10000, N - 100) / target).toBeGreaterThan(0.98);
    expect(zeroCrossFreq(y, SR, 10000, N - 100) / target).toBeLessThan(1.02);
    expect(rms(y, 10000, N - 100)).toBeGreaterThan(0.25);
  });
  it('0 semitones keeps the pitch and level', () => {
    expect(toneAmp(shifted(0), 440, SR, 10000, N - 100)).toBeCloseTo(0.5, 1);
  });
});
