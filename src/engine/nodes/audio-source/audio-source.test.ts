import { describe, expect, it } from 'vitest';
import { SR, saw, db, getDef, noise, peak, rms, runKernel, sine, toneAmp, zeroCrossFreq, allFinite } from '../../audio/testing';
import type { AudioAsset } from '../../audio/types';

describe('oscillator', () => {
  it('produces the requested pitch and level', () => {
    const r = runKernel(getDef('oscillator'), { params: { wave: 'sine', frequency: 440, level: -6 }, frames: SR });
    const L = r.out.audio[0];
    expect(zeroCrossFreq(L, SR, 1000)).toBeCloseTo(440, 0);
    expect(db(peak(L))).toBeCloseTo(-6, 1);
    expect(r.out.audio[1]).toEqual(L);
  });
  it('saw is band-limited: almost no energy above Nyquist-folded images of a 5 kHz saw', () => {
    const r = runKernel(getDef('oscillator'), { params: { wave: 'saw', frequency: 5000, level: -6 }, frames: SR });
    const L = r.out.audio[0];
    expect(toneAmp(L, 5000, SR, 2000, 20000)).toBeGreaterThan(0.2);
    // harmonic 5 (25 kHz) folds to 23 kHz. polyBLEP must cut that alias well below a naive saw's.
    const naive = saw(5000, SR, SR, 0.5);
    expect(toneAmp(L, 23000, SR, 2000, 20000)).toBeLessThan(0.5 * toneAmp(naive, 23000, SR, 2000, 20000));
  });
  it('noise is seeded (identical on re-run) and has roughly flat level', () => {
    const a = runKernel(getDef('oscillator'), { params: { wave: 'noise', level: -6 }, frames: 4800 }).out.audio[0];
    const b = runKernel(getDef('oscillator'), { params: { wave: 'noise', level: -6 }, frames: 4800 }).out.audio[0];
    expect(a).toEqual(b);
    expect(rms(a)).toBeGreaterThan(0.1);
  });
});

describe('microphone', () => {
  it('is silent without live input', () => {
    const r = runKernel(getDef('microphone'), { params: { monitor: true }, frames: 4800 });
    expect(peak(r.out.audio[0])).toBe(0);
    expect(peak(r.out.tap[0])).toBe(0);
  });
  it('passes the mic to the tap always and to Audio only when monitoring; applies gain', () => {
    const mic = sine(440, 9600, SR, 0.25);
    const q = runKernel(getDef('microphone'), { params: { gain: 6.0206, monitor: false }, mic, frames: 9600 });
    expect(peak(q.out.audio[0])).toBe(0);
    expect(peak(q.out.tap[0], 4800)).toBeCloseTo(0.5, 2);
    const m = runKernel(getDef('microphone'), { params: { gain: 0, monitor: true }, mic, frames: 9600 });
    expect(peak(m.out.audio[0], 4800)).toBeCloseTo(0.25, 2);
  });
  it('noise gate silences hiss but passes a loud tone', () => {
    const hiss = noise(24000, 3, 0.002);
    const tone = sine(300, 24000, SR, 0.5);
    const mic = new Float32Array(48000);
    mic.set(hiss, 0);
    mic.set(tone, 24000);
    const r = runKernel(getDef('microphone'), { params: { gate: true, gateThreshold: -40, monitor: true }, mic, frames: 48000 });
    expect(rms(r.out.audio[0], 6000, 20000)).toBeLessThan(0.0003);
    expect(rms(r.out.audio[0], 30000, 48000)).toBeGreaterThan(0.3);
  });
});

describe('audio-file', () => {
  const asset: AudioAsset = (() => {
    const l = sine(1000, SR, SR, 0.5);
    return { sampleRate: SR, frames: SR, left: l, right: l.map((x) => -x) };
  })();
  const run = (params: Record<string, unknown>, time: Record<string, unknown>, frames = 9600) =>
    runKernel(getDef('audio-file'), { params: { assets: ['a'], ...params }, assets: { a: asset }, frames, time });

  it('plays the file with the transport and keeps channels', () => {
    const r = run({}, { playing: true });
    expect(r.out.audio[0][100]).toBeCloseTo(asset.left[100], 5);
    expect(r.out.audio[1][100]).toBeCloseTo(asset.right[100], 5);
  });
  it('is silent while paused, and with no/missing file', () => {
    expect(peak(run({}, { playing: false }).out.audio[0])).toBe(0);
    expect(peak(runKernel(getDef('audio-file'), { params: { assets: ['zzz'] }, frames: 1000 }).out.audio[0])).toBe(0);
  });
  it('seeks: starting at 0.25 s plays from that position', () => {
    const r = run({}, { playing: true, sample: SR / 4 }, 2000);
    expect(r.out.audio[0][1500]).toBeCloseTo(asset.left[SR / 4 + 1500], 5); // after the 64-sample de-click fade
  });
  it('applies gain in dB and the skip offset', () => {
    const r = run({ gain: -6.0206, startOffset: 0.001 }, { playing: true });
    expect(r.out.audio[0][500]).toBeCloseTo(asset.left[500 + 48] * 0.5, 4);
  });
  it('loops when asked and stops at the end otherwise', () => {
    const t = { playing: true, sample: SR - 100 };
    const noLoop = run({ loop: false }, t, 400);
    expect(peak(noLoop.out.audio[0], 150)).toBe(0);
    const loop = run({ loop: true }, t, 400);
    expect(peak(loop.out.audio[0], 150)).toBeGreaterThan(0.1);
    expect(allFinite(loop.out.audio[0])).toBe(true);
  });
});

describe('audio-out', () => {
  it('applies master gain and limits at the ceiling', () => {
    const loud = sine(200, 9600, SR, 3);
    const r = runKernel(getDef('audio-out'), { params: { gain: 0, limiter: true, ceiling: -1 }, inputs: { audio: loud }, frames: 9600 });
    expect(peak(r.out.master[0])).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
    expect(peak(r.out.master[0], 4800)).toBeGreaterThan(0.8);
  });
  it('plain gain when the limiter is off', () => {
    const r = runKernel(getDef('audio-out'), { params: { gain: -6.0206, limiter: false }, inputs: { audio: sine(200, 9600, SR, 0.8) }, frames: 9600 });
    expect(peak(r.out.master[0], 4800)).toBeCloseTo(0.4, 2);
  });
  it('with nothing connected outputs silence', () => {
    expect(peak(runKernel(getDef('audio-out'), { frames: 1000 }).out.master[0])).toBe(0);
  });
});
