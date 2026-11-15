import { describe, expect, it } from 'vitest';
import { nsdf, pickPeriod } from '../../audio/pitch';
import { SR, allFinite, getDef, off, on, peak, rms, runKernel, saw, toneAmp, zeroCrossFreq } from '../../audio/testing';

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const synth = (params: Record<string, unknown>, events: ReturnType<typeof on>[], frames: number) =>
  runKernel(getDef('synth'), { params, midi: { midi: events }, frames });

/** A plain, fully open sine patch so measurements are about the engine, not the patch. */
const PURE = { wave1: 'sine', mix: 0, cutoff: 20000, resonance: 0, envAmount: 0, attack: 0.001, sustain: 1, release: 0.05, gain: 0, unison: 1 };

describe('synth', () => {
  it.each([36, 48, 57, 60, 69, 81, 96])('plays MIDI note %i at the right fundamental', (note) => {
    const r = synth(PURE, [on(note, 0)], SR);
    expect(zeroCrossFreq(r.out.audio[0], SR, 6000, SR - 100) / hz(note)).toBeCloseTo(1, 2);
    expect(r.out.audio[1][SR / 2]).toBeCloseTo(r.out.audio[0][SR / 2], 6); // centred
  });

  it('a saw patch has its energy at the fundamental and harmonics', () => {
    const r = synth({ ...PURE, wave1: 'saw' }, [on(57, 0)], SR);
    const L = r.out.audio[0];
    const f = hz(57);
    expect(toneAmp(L, f, SR, 6000, SR - 100)).toBeGreaterThan(0.3);
    expect(toneAmp(L, 2 * f, SR, 6000, SR - 100)).toBeGreaterThan(0.1);
    expect(toneAmp(L, 1.5 * f, SR, 6000, SR - 100)).toBeLessThan(0.02);
  });

  it('is silent after release, and goes fully idle', () => {
    const r = synth({ ...PURE, release: 0.1 }, [on(60, 0), off(60, 12000)], 2 * SR);
    const L = r.out.audio[0];
    expect(rms(L, 6000, 11000)).toBeGreaterThan(0.2);
    expect(rms(L, 12000 + 0.6 * SR, 2 * SR)).toBeLessThan(1e-5);
    expect(peak(L, 12000 + SR, 2 * SR)).toBe(0);
    expect(L[12000 + 100]).not.toBe(0); // release tail exists
  });

  it('envelope: attack ramps up, decay falls to the sustain level', () => {
    const r = synth({ ...PURE, attack: 0.2, decay: 0.2, sustain: 0.4 }, [on(69, 0)], SR);
    const L = r.out.audio[0];
    const a = peak(L, 0, 480);
    const b = peak(L, 4800, 5280);
    const top = peak(L, 9000, 10500);
    const sus = peak(L, SR - 4800, SR);
    expect(a).toBeLessThan(0.1);
    expect(b).toBeGreaterThan(a * 3);
    expect(top).toBeGreaterThan(0.85);
    expect(sus).toBeGreaterThan(0.38);
    expect(sus).toBeLessThan(0.45);
  });

  it('velocity scales loudness', () => {
    const loud = peak(synth(PURE, [on(69, 0, 1)], 9600).out.audio[0], 2400);
    const soft = peak(synth(PURE, [on(69, 0, 0.25)], 9600).out.audio[0], 2400);
    expect(soft / loud).toBeCloseTo(0.25, 1);
  });

  it('is polyphonic: a chord contains all its notes', () => {
    const r = synth(PURE, [on(60, 0), on(64, 0), on(67, 0)], SR);
    for (const n of [60, 64, 67]) expect(toneAmp(r.out.audio[0], hz(n), SR, 6000, SR - 100)).toBeGreaterThan(0.25);
  });

  it('voice stealing: more notes than voices stays finite and bounded', () => {
    const ev = Array.from({ length: 24 }, (_, i) => on(40 + i, i * 100));
    const r = synth({ ...PURE, voices: 4 }, ev, 2 * SR);
    expect(allFinite(r.out.audio[0])).toBe(true);
    expect(peak(r.out.audio[0])).toBeLessThan(6);
  });

  it('note-ons are sample accurate inside the block', () => {
    const r = synth({ ...PURE, wave1: 'saw' }, [on(60, 300)], 1024);
    expect(peak(r.out.audio[0], 0, 300)).toBe(0);
    expect(peak(r.out.audio[0], 300, 400)).toBeGreaterThan(0.01);
  });

  it('low-pass filter removes harmonics; resonance emphasises the cutoff', () => {
    const f = hz(48);
    const open = synth({ ...PURE, wave1: 'saw', cutoff: 20000 }, [on(48, 0)], SR).out.audio[0];
    const closed = synth({ ...PURE, wave1: 'saw', cutoff: 400 }, [on(48, 0)], SR).out.audio[0];
    const h = Math.round(3000 / f) * f;
    expect(toneAmp(closed, h, SR, 8000, SR - 100)).toBeLessThan(toneAmp(open, h, SR, 8000, SR - 100) * 0.05);
    expect(toneAmp(closed, f, SR, 8000, SR - 100)).toBeGreaterThan(0.3);
    const res = synth({ ...PURE, wave1: 'saw', cutoff: 1000, resonance: 0.9 }, [on(48, 0)], SR).out.audio[0];
    expect(allFinite(res)).toBe(true);
    expect(peak(res)).toBeLessThan(8);
  });

  it('filter envelope opens the filter at the start of the note', () => {
    const base = { ...PURE, wave1: 'saw', cutoff: 300, envAmount: 4, filterDecay: 0.1, filterSustain: 0, attack: 0.001 };
    const L = synth(base, [on(48, 0)], SR).out.audio[0];
    const bright = (a: number, b: number) => {
      let s = 0;
      for (let i = a + 1; i < b; i++) s += (L[i] - L[i - 1]) ** 2;
      return s / (b - a);
    };
    expect(bright(200, 1500)).toBeGreaterThan(bright(SR - 4000, SR) * 3);
  });

  it('band-limited oscillators alias far less than a naive saw (high note)', () => {
    const note = 100; // 2637 Hz: harmonic 10 folds back to ~21.6 kHz
    const f = hz(note);
    const L = synth({ ...PURE, wave1: 'saw' }, [on(note, 0)], SR).out.audio[0];
    const naive = saw(f, SR, SR, 1);
    const alias = 2 * SR / 2 - 10 * f; // 24000*2 - 26370 = 21630 Hz
    const rel = (x: Float32Array) => toneAmp(x, Math.abs(SR - 10 * f), SR, 8000, SR - 100) / toneAmp(x, f, SR, 8000, SR - 100);
    expect(alias).toBeGreaterThan(20000);
    expect(rel(L)).toBeLessThan(rel(naive) * 0.5);
  });

  it('two oscillators: detune makes beating, mix 1 plays only oscillator 2 an octave up', () => {
    const r = synth({ ...PURE, mix: 1, wave2: 'sine', semi2: 12 }, [on(57, 0)], SR);
    expect(zeroCrossFreq(r.out.audio[0], SR, 6000, SR - 100) / hz(69)).toBeCloseTo(1, 2);
  });

  it('unison + spread: wider stereo image, level stays sane', () => {
    const r = synth({ ...PURE, wave1: 'saw', unison: 5, unisonDetune: 20, stereo: 1 }, [on(48, 0)], SR);
    let diff = 0;
    for (let i = 8000; i < 16000; i++) diff += Math.abs(r.out.audio[0][i] - r.out.audio[1][i]);
    expect(diff).toBeGreaterThan(5);
    const mono = synth({ ...PURE, wave1: 'saw', unison: 1 }, [on(48, 0)], SR);
    expect(rms(r.out.audio[0], 8000, SR) / rms(mono.out.audio[0], 8000, SR)).toBeGreaterThan(0.5);
    expect(rms(r.out.audio[0], 8000, SR) / rms(mono.out.audio[0], 8000, SR)).toBeLessThan(2);
  });

  it('glide slides from the previous note', () => {
    const r = synth({ ...PURE, glide: 0.4, voices: 1 }, [on(57, 0), off(57, 12000), on(69, 14000)], SR);
    const early = zeroCrossFreq(r.out.audio[0], SR, 14000 + 200, 14000 + 3000);
    const late = zeroCrossFreq(r.out.audio[0], SR, SR - 6000, SR - 100);
    expect(early).toBeLessThan(hz(69) * 0.85);
    expect(early).toBeGreaterThan(hz(57) * 0.95);
    expect(late / hz(69)).toBeCloseTo(1, 1);
  });

  it('pitch bend moves the pitch by the bend range', () => {
    const bend = { type: 'bend' as const, note: 0, velocity: 0, value: 1, offset: 100, channel: 0 };
    const r = runKernel(getDef('synth'), { params: { ...PURE, bendRange: 2 }, midi: { midi: [on(69, 0), bend] }, frames: SR });
    expect(zeroCrossFreq(r.out.audio[0], SR, 6000, SR - 100) / (440 * Math.pow(2, 2 / 12))).toBeCloseTo(1, 2);
  });

  it('sustain pedal holds released notes until it is lifted', () => {
    const cc = (v: number, offset: number) => ({ type: 'cc' as const, note: 64, velocity: 0, value: v, offset, channel: 0 });
    const r = runKernel(getDef('synth'), {
      params: { ...PURE, release: 0.05 },
      midi: { midi: [cc(1, 0), on(60, 100), off(60, 4800), cc(0, 24000)] },
      frames: SR,
    });
    expect(rms(r.out.audio[0], 10000, 23000)).toBeGreaterThan(0.2);
    expect(rms(r.out.audio[0], 24000 + 6000, SR)).toBeLessThan(1e-4);
  });

  it('10 s of random playing: finite, bounded, no growth', () => {
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const ev: ReturnType<typeof on>[] = [];
    for (let t = 0; t < 10 * SR; t += 2400 + Math.floor(rnd() * 9000)) {
      const n = 36 + Math.floor(rnd() * 48);
      ev.push(on(n, t, 0.3 + rnd() * 0.7), off(n, t + 3000 + Math.floor(rnd() * 20000)));
    }
    ev.sort((a, b) => a.offset - b.offset);
    const r = synth({ wave1: 'saw', wave2: 'square', mix: 0.5, unison: 3, resonance: 0.8, envAmount: 3, cutoff: 800, voices: 8, release: 1 }, ev, 10 * SR);
    expect(allFinite(r.out.audio[0]) && allFinite(r.out.audio[1])).toBe(true);
    expect(peak(r.out.audio[0])).toBeLessThan(4);
    expect(rms(r.out.audio[0], 9 * SR, 10 * SR)).toBeLessThan(1);
  });

  it('no MIDI connected: silence', () => {
    expect(peak(runKernel(getDef('synth'), { frames: 4800 }).out.audio[0])).toBe(0);
  });
});

describe('pluck', () => {
  it('rings at the note pitch and decays', () => {
    const r = runKernel(getDef('pluck'), { params: { decay: 1, brightness: 0.5 }, midi: { midi: [on(57, 0)] }, frames: 3 * SR });
    const L = r.out.audio[0];
    const n = new Float32Array(2048);
    nsdf(L.subarray(4000, 6048), 2048, 1200, n);
    const found = pickPeriod(n, 20, 1200, 0.93, { lag: 0, clarity: 0 });
    expect(SR / found.lag / hz(57)).toBeCloseTo(1, 1);
    expect(rms(L, 2000, 6000)).toBeGreaterThan(0.02);
    expect(rms(L, 2 * SR, 3 * SR)).toBeLessThan(rms(L, 2000, 6000) * 0.1);
    expect(allFinite(L)).toBe(true);
  });
  it('is deterministic and releases (mutes) with the key', () => {
    const run = (events: ReturnType<typeof on>[]) => runKernel(getDef('pluck'), { params: { decay: 6, damp: true }, midi: { midi: events }, frames: SR });
    const a = run([on(60, 0)]).out.audio[0];
    const b = run([on(60, 0)]).out.audio[0];
    expect(a).toEqual(b);
    const held = rms(a, SR - 6000, SR);
    const muted = rms(run([on(60, 0), off(60, 6000)]).out.audio[0], SR - 6000, SR);
    expect(muted).toBeLessThan(held * 0.2);
  });
});

describe('drum', () => {
  const hit = (note: number, frames = 24000) => runKernel(getDef('drum'), { midi: { midi: [on(note, 0)] }, frames }).out.audio[0];
  it('kick is low and thumpy; hat is bright; snare sits between', () => {
    const k = hit(36);
    const s = hit(38);
    const h = hit(42);
    // brightness = energy of the sample-to-sample difference relative to the energy itself
    const zc = (x: Float32Array) => {
      let d = 0;
      let e = 1e-12;
      for (let i = 1; i < x.length; i++) {
        d += (x[i] - x[i - 1]) ** 2;
        e += x[i] ** 2;
      }
      return d / e;
    };
    expect(peak(k)).toBeGreaterThan(0.1);
    expect(toneAmp(k, 52, SR, 2400, 12000)).toBeGreaterThan(toneAmp(k, 4000, SR, 2400, 12000) * 20);
    expect(zc(h)).toBeGreaterThan(zc(s) * 1.2);
    expect(zc(s)).toBeGreaterThan(zc(k) * 2);
  });
  it('decays to silence; open hat rings longer than closed', () => {
    const k = hit(36, SR);
    expect(rms(k, SR - 4800, SR)).toBeLessThan(1e-4);
    const closed = hit(42, 24000);
    const open = hit(46, 24000);
    expect(rms(open, 4800, 12000)).toBeGreaterThan(rms(closed, 4800, 12000) * 3);
  });
  it('ignores other notes, and velocity scales level', () => {
    expect(peak(hit(70))).toBe(0);
    const soft = runKernel(getDef('drum'), { midi: { midi: [on(36, 0, 0.3)] }, frames: 9600 }).out.audio[0];
    expect(peak(soft) / peak(hit(36, 9600))).toBeCloseTo(0.3, 1);
  });
});
