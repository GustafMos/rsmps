import { describe, expect, it } from 'vitest';
import { SR, allFinite, db, getDef, noise, peak, rms, runKernel, sine, toneAmp } from '../../audio/testing';

const N = SR;
const gainAt = (id: string, params: Record<string, unknown>, freq: number): number => {
  const x = sine(freq, N, SR, 0.25);
  const r = runKernel(getDef(id), { params, inputs: { audio: x }, frames: N });
  return db(toneAmp(r.out.audio[0], freq, SR, 12000, N - 100)) - db(0.25);
};

describe('eq', () => {
  it('is flat with all gains at 0', () => {
    for (const f of [60, 1000, 10000]) expect(gainAt('eq', {}, f)).toBeCloseTo(0, 1);
  });
  it('low shelf boosts bass and leaves the highs alone', () => {
    expect(gainAt('eq', { lowGain: 12, lowFreq: 200 }, 40)).toBeCloseTo(12, 0);
    expect(gainAt('eq', { lowGain: 12, lowFreq: 200 }, 4000)).toBeCloseTo(0, 0);
  });
  it('peaking band boosts at its centre, cuts when negative, and is narrow', () => {
    expect(gainAt('eq', { m1Gain: 10, m1Freq: 1000, m1Q: 2 }, 1000)).toBeCloseTo(10, 0);
    expect(gainAt('eq', { m1Gain: -10, m1Freq: 1000, m1Q: 2 }, 1000)).toBeCloseTo(-10, 0);
    expect(Math.abs(gainAt('eq', { m1Gain: 10, m1Freq: 1000, m1Q: 2 }, 100))).toBeLessThan(0.5);
    expect(gainAt('eq', { m2Gain: 8, m2Freq: 3000, m2Q: 1 }, 3000)).toBeCloseTo(8, 0);
  });
  it('high shelf cuts treble', () => {
    expect(gainAt('eq', { highGain: -12, highFreq: 5000 }, 15000)).toBeCloseTo(-12, 0);
    expect(Math.abs(gainAt('eq', { highGain: -12, highFreq: 5000 }, 200))).toBeLessThan(0.3);
  });
});

describe('filter', () => {
  it('low-pass attenuates about 12 dB/octave above cutoff and passes below', () => {
    expect(gainAt('filter', { type: 'lowpass', cutoff: 1000, resonance: 0.707 }, 100)).toBeCloseTo(0, 0);
    expect(gainAt('filter', { type: 'lowpass', cutoff: 1000, resonance: 0.707 }, 1000)).toBeCloseTo(-3, 0);
    expect(gainAt('filter', { type: 'lowpass', cutoff: 1000, resonance: 0.707 }, 4000)).toBeCloseTo(-24, 0);
  });
  it('high-pass mirrors it', () => {
    expect(gainAt('filter', { type: 'highpass', cutoff: 1000 }, 4000)).toBeCloseTo(0, 0);
    expect(gainAt('filter', { type: 'highpass', cutoff: 1000 }, 250)).toBeCloseTo(-24, 0);
  });
  it('band-pass peaks at centre; notch removes it', () => {
    expect(gainAt('filter', { type: 'bandpass', cutoff: 1000, resonance: 4 }, 1000)).toBeCloseTo(0, 0);
    expect(gainAt('filter', { type: 'bandpass', cutoff: 1000, resonance: 4 }, 100)).toBeLessThan(-15);
    expect(gainAt('filter', { type: 'notch', cutoff: 1000, resonance: 4 }, 1000)).toBeLessThan(-40);
    expect(gainAt('filter', { type: 'notch', cutoff: 1000, resonance: 4 }, 100)).toBeCloseTo(0, 0);
  });
  it('resonance boosts at the cutoff', () => {
    expect(gainAt('filter', { type: 'lowpass', cutoff: 1000, resonance: 8 }, 1000)).toBeCloseTo(18, 0);
  });
  it('mix 0 is the dry signal', () => {
    expect(gainAt('filter', { type: 'lowpass', cutoff: 200, mix: 0 }, 5000)).toBeCloseTo(0, 1);
  });
  it('sweep follows the project loop: whole cycles, brightest a quarter of the way through', () => {
    const frames = 4 * SR;
    const x = noise(frames, 11, 0.5);
    const r = runKernel(getDef('filter'), {
      params: { type: 'lowpass', cutoff: 1000, resonance: 0.707, sweepDepth: 2, sweepCycles: 1 },
      inputs: { audio: x },
      frames,
      time: { duration: 4, playing: true, loop: true },
    });
    const L = r.out.audio[0];
    const open = rms(L, SR - 2400, SR + 2400); // t = 1 s: cutoff x4
    const closed = rms(L, 3 * SR - 2400, 3 * SR + 2400); // t = 3 s: cutoff /4
    expect(open / closed).toBeGreaterThan(3.3); // white noise RMS ~ sqrt(cutoff): sqrt(16) = 4
    // seamless loop: the filter is at the same cutoff at t = 0 and t = duration
    const a = runKernel(getDef('filter'), { params: { sweepDepth: 2, sweepCycles: 3 }, inputs: { audio: x.subarray(0, 4800) }, frames: 4800, time: { duration: 4, playing: true, sample: 0 } });
    const b = runKernel(getDef('filter'), { params: { sweepDepth: 2, sweepCycles: 3 }, inputs: { audio: x.subarray(0, 4800) }, frames: 4800, time: { duration: 4, playing: true, sample: 4 * SR } });
    for (let i = 4000; i < 4800; i++) expect(a.out.audio[0][i]).toBeCloseTo(b.out.audio[0][i], 3);
  });
  it('stays stable at extreme settings', () => {
    const r = runKernel(getDef('filter'), { params: { cutoff: 20000, resonance: 20, sweepDepth: 4, sweepCycles: 64 }, inputs: { audio: noise(N, 2, 1) }, frames: N, time: { duration: 1, playing: true } });
    expect(allFinite(r.out.audio[0])).toBe(true);
  });
});

describe('distortion', () => {
  const x = sine(1000, N, SR, 0.5);
  const run = (params: Record<string, unknown>) => runKernel(getDef('distortion'), { params, inputs: { audio: x }, frames: N }).out.audio[0];
  it('soft clip adds odd harmonics and bounds the level', () => {
    const y = run({ type: 'soft', drive: 24, level: 0, tone: 1 });
    expect(peak(y)).toBeLessThanOrEqual(1.0001);
    expect(toneAmp(y, 3000, SR, 2000, N - 2000)).toBeGreaterThan(0.1);
    expect(toneAmp(y, 2000, SR, 2000, N - 2000)).toBeLessThan(0.01); // symmetric => no even harmonics
  });
  it('hard clip flattens at the output level', () => {
    const y = run({ type: 'hard', drive: 24, level: -6.0206, tone: 1 });
    expect(peak(y)).toBeCloseTo(0.5, 3);
  });
  it('fold keeps the signal inside +-1', () => {
    expect(peak(run({ type: 'fold', drive: 30, level: 0, tone: 1 }))).toBeLessThanOrEqual(1.0001);
  });
  it('bit crush quantises to a few levels', () => {
    const y = run({ type: 'crush', drive: 12, bits: 2, level: 0, tone: 1 });
    const levels = new Set<number>();
    for (let i = 100; i < N; i++) levels.add(Math.round(y[i] * 1e4));
    expect(levels.size).toBeLessThanOrEqual(6);
  });
  it('tone darkens: less treble than bright, and mix 0 is dry', () => {
    const bright = run({ type: 'hard', drive: 30, tone: 1, level: 0 });
    const dark = run({ type: 'hard', drive: 30, tone: 0, level: 0 });
    expect(toneAmp(dark, 9000, SR, 2000, N - 2000)).toBeLessThan(toneAmp(bright, 9000, SR, 2000, N - 2000) * 0.5);
    const dry = run({ mix: 0 });
    expect(dry[1234]).toBeCloseTo(x[1234], 6);
  });
});

describe('stereo-width', () => {
  const L = sine(300, 4800, SR, 0.5);
  const R = sine(700, 4800, SR, 0.5);
  const run = (width: number) => runKernel(getDef('stereo-width'), { params: { width }, inputs: { audio: [L, R] }, frames: 4800 }).out.audio;
  it('0 = mono, 1 = unchanged, 2 = side doubled', () => {
    const mono = run(0);
    for (let i = 3000; i < 3100; i++) {
      expect(mono[0][i]).toBeCloseTo((L[i] + R[i]) / 2, 5);
      expect(mono[1][i]).toBeCloseTo(mono[0][i], 6);
    }
    const same = run(1);
    expect(same[0][4000]).toBeCloseTo(L[4000], 5);
    expect(same[1][4000]).toBeCloseTo(R[4000], 5);
    const wide = run(2);
    expect(wide[0][4000]).toBeCloseTo((L[4000] + R[4000]) / 2 + (L[4000] - R[4000]), 5);
  });
});
