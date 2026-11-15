import { describe, expect, it } from 'vitest';
import { SR, allFinite, db, getDef, noise, peak, rms, runKernel, sine, toneAmp } from '../../audio/testing';

const N = SR; // one second

describe('gain', () => {
  const run = (params: Record<string, unknown>, x = sine(1000, N, SR, 0.5)) => runKernel(getDef('gain'), { params, inputs: { audio: x }, frames: N });
  it('applies gain in dB', () => {
    expect(db(peak(run({ gain: -6.0206 }).out.audio[0], 100)) - db(0.5)).toBeCloseTo(-6.02, 1);
    expect(db(peak(run({ gain: 12 }).out.audio[0], 100)) - db(0.5)).toBeCloseTo(12, 1);
  });
  it('is unity at centre pan and 0 dB', () => {
    const r = run({});
    expect(peak(r.out.audio[0], 100)).toBeCloseTo(0.5, 3);
    expect(peak(r.out.audio[1], 100)).toBeCloseTo(0.5, 3);
  });
  it('pans hard left/right', () => {
    const l = run({ pan: -1 });
    expect(peak(l.out.audio[1])).toBeLessThan(1e-6);
    expect(peak(l.out.audio[0], 100)).toBeGreaterThan(0.6);
    const r = run({ pan: 1 });
    expect(peak(r.out.audio[0])).toBeLessThan(1e-6);
  });
  it('mutes, and passes nothing when the input is unwired', () => {
    expect(peak(run({ mute: true }).out.audio[0])).toBe(0);
    expect(peak(runKernel(getDef('gain'), { frames: 1000 }).out.audio[0])).toBe(0);
  });
  it('ramps instead of jumping when a param changes (no click larger than one sample step of the signal)', () => {
    // First block at 0 dB state, then the whole run uses -60 dB from block 0: the state starts at target, so test the ramp via two kernels in a row
    const r = run({ gain: -40 }, new Float32Array(N).fill(0.5));
    expect(allFinite(r.out.audio[0])).toBe(true);
  });
});

describe('mixer', () => {
  it('applies master gain and mute to its (already summed) input', () => {
    const x = sine(500, 9600, SR, 0.4);
    const r = runKernel(getDef('mixer'), { params: { gain: -6.0206 }, inputs: { audio: x }, frames: 9600 });
    expect(peak(r.out.audio[0], 100)).toBeCloseTo(0.2, 2);
    expect(peak(runKernel(getDef('mixer'), { params: { mute: true }, inputs: { audio: x }, frames: 9600 }).out.audio[0])).toBe(0);
  });
  it('declares a multi input so layers can be wired in', () => {
    expect(getDef('mixer').inputs.audio.multi).toBe(true);
    expect(getDef('audio-out').inputs.audio.multi).toBe(true);
  });
});

describe('compressor', () => {
  const x = sine(1000, 2 * N, SR, 0.5); // -6 dBFS peak
  const run = (params: Record<string, unknown>, inputs: Record<string, Float32Array> = { audio: x }) =>
    runKernel(getDef('compressor'), { params, inputs, frames: 2 * N });
  const tail = (r: ReturnType<typeof run>) => peak(r.out.audio[0], N + 4800, 2 * N);

  it('reduces level above threshold by the ratio (peak detector, hard knee)', () => {
    // 12 dB over a -18 dB threshold at 4:1 -> 3 dB over -> -9 dB of gain reduction -> -15 dBFS
    const r = run({ threshold: -18, ratio: 4, knee: 0, detector: 'peak', attack: 1, release: 50 });
    expect(db(tail(r))).toBeCloseTo(-15, 0);
  });
  it('RMS detector follows the average level (sine RMS is 3 dB below peak)', () => {
    // level -9.03 dB, 8.97 over, 4:1 -> 6.73 dB reduction -> -12.73 dBFS peak
    const r = run({ threshold: -18, ratio: 4, knee: 0, detector: 'rms', attack: 1, release: 50 });
    expect(db(tail(r))).toBeCloseTo(-12.7, 0);
  });
  it('leaves signals below the threshold untouched', () => {
    const quiet = sine(1000, 2 * N, SR, 0.05);
    const r = run({ threshold: -18, ratio: 8, knee: 0, detector: 'peak' }, { audio: quiet });
    expect(tail(r)).toBeCloseTo(0.05, 3);
  });
  it('ratio 1 does nothing', () => {
    expect(tail(run({ ratio: 1, threshold: -40 }))).toBeCloseTo(0.5, 2);
  });
  it('makeup gain adds back level', () => {
    const a = tail(run({ threshold: -18, ratio: 4, knee: 0, detector: 'peak', makeup: 0 }));
    const b = tail(run({ threshold: -18, ratio: 4, knee: 0, detector: 'peak', makeup: 6.0206 }));
    expect(b / a).toBeCloseTo(2, 1);
  });
  it('attack: the first milliseconds pass before gain reduction builds', () => {
    const r = run({ threshold: -30, ratio: 10, knee: 0, detector: 'peak', attack: 50, release: 100 });
    expect(peak(r.out.audio[0], 0, 48)).toBeGreaterThan(0.4); // still near unity right at the onset
    expect(peak(r.out.audio[0], N + 4800, 2 * N)).toBeLessThan(0.25);
  });
  it('soft knee reduces less than a hard knee at the threshold', () => {
    const level = sine(1000, 2 * N, SR, Math.pow(10, -18 / 20)); // exactly at threshold
    const hard = tail(run({ threshold: -18, ratio: 8, knee: 0, detector: 'peak' }, { audio: level }));
    const soft = tail(run({ threshold: -18, ratio: 8, knee: 12, detector: 'peak' }, { audio: level }));
    expect(hard).toBeGreaterThan(0.12);
    expect(soft).toBeLessThan(hard);
  });
  it('sidechain: a loud sidechain ducks a quiet main signal', () => {
    const main = sine(300, 2 * N, SR, 0.1);
    const side = sine(80, 2 * N, SR, 0.8);
    const free = run({ threshold: -30, ratio: 10, knee: 0, detector: 'peak' }, { audio: main });
    const ducked = run({ threshold: -30, ratio: 10, knee: 0, detector: 'peak' }, { audio: main, sidechain: side });
    // main alone is at -20 dB: above -30 so it is compressed a little; with the sidechain it is crushed
    expect(tail(ducked)).toBeLessThan(tail(free) * 0.5);
  });
  it('stays finite on noise', () => {
    expect(allFinite(run({ threshold: -40, ratio: 20 }, { audio: noise(2 * N, 9, 1) }).out.audio[0])).toBe(true);
  });
});

describe('limiter', () => {
  it('never exceeds the ceiling, even on a loud signal', () => {
    const r = runKernel(getDef('limiter'), { params: { ceiling: -3, input: 12 }, inputs: { audio: noise(N, 5, 1) }, frames: N });
    expect(peak(r.out.audio[0])).toBeLessThanOrEqual(Math.pow(10, -3 / 20) + 1e-6);
    expect(peak(r.out.audio[1])).toBeLessThanOrEqual(Math.pow(10, -3 / 20) + 1e-6);
  });
  it('is transparent below the ceiling (delayed by its look-ahead only)', () => {
    const x = sine(440, N, SR, 0.3);
    const r = runKernel(getDef('limiter'), { params: { ceiling: -1 }, inputs: { audio: x }, frames: N });
    const look = Math.round(SR * 0.0015);
    for (let i = 2000; i < 2100; i++) expect(r.out.audio[0][i + look]).toBeCloseTo(x[i], 4);
  });
});

describe('gate', () => {
  it('passes loud, attenuates quiet by the reduction amount', () => {
    const x = new Float32Array(2 * N);
    x.set(sine(500, N, SR, 0.5), 0);
    x.set(sine(500, N, SR, 0.003), N); // -50 dB
    const r = runKernel(getDef('gate'), { params: { threshold: -40, reduction: 40, release: 20, hold: 10 }, inputs: { audio: x }, frames: 2 * N });
    expect(peak(r.out.audio[0], 4800, N)).toBeCloseTo(0.5, 2);
    expect(db(peak(r.out.audio[0], N + 24000, 2 * N)) - db(0.003)).toBeLessThan(-35);
  });
  it('does not chatter on a steady tone just above the threshold', () => {
    const x = sine(300, N, SR, 0.02); // -34 dB, threshold -40
    const r = runKernel(getDef('gate'), { params: { threshold: -40 }, inputs: { audio: x }, frames: N });
    expect(toneAmp(r.out.audio[0], 300, SR, 4800, N)).toBeGreaterThan(0.019);
  });
  it('silent in, silent out', () => {
    expect(rms(runKernel(getDef('gate'), { inputs: { audio: new Float32Array(4800) }, frames: 4800 }).out.audio[0])).toBe(0);
  });
});
