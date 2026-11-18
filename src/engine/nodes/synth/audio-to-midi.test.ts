import { describe, expect, it } from 'vitest';
import { SR, getDef, noise, runKernel, saw, sine, voice } from '../../audio/testing';
import type { MidiEvent } from '../../audio/types';

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const silence = (seconds: number, sr = SR) => new Float32Array(Math.round(seconds * sr));
const secs = (s: number, sr = SR) => Math.round(s * sr);

function detect(x: Float32Array, params: Record<string, unknown> = {}, sr = SR): MidiEvent[] {
  return runKernel(getDef('audio-to-midi'), { params, inputs: { audio: x }, frames: x.length, sampleRate: sr }).midiOut.midi;
}
const ons = (ev: MidiEvent[]) => ev.filter((e) => e.type === 'on');
const offs = (ev: MidiEvent[]) => ev.filter((e) => e.type === 'off');
/** Notes as [note, startSec, endSec] from an event list. */
function notes(ev: MidiEvent[], sr = SR): [number, number, number][] {
  const out: [number, number, number][] = [];
  const open = new Map<number, number>();
  for (const e of ev) {
    if (e.type === 'on') open.set(e.note, e.offset / sr);
    else if (e.type === 'off' && open.has(e.note)) {
      out.push([e.note, open.get(e.note)!, e.offset / sr]);
      open.delete(e.note);
    }
  }
  return out;
}

describe('audio-to-midi', () => {
  it.each([36, 40, 45, 52, 57, 60, 64, 69, 76, 84, 91, 96])('a sine at MIDI %i gives exactly that one note', (note) => {
    const x = concat(sine(hz(note), secs(0.6), SR, 0.5), silence(0.3));
    const ev = detect(x);
    expect(ons(ev).map((e) => e.note)).toEqual([note]);
    expect(offs(ev).map((e) => e.note)).toEqual([note]);
    // note-on arrives promptly (window fill + confirmation), note-off shortly after the sound stops
    expect(ons(ev)[0].offset / SR).toBeLessThan(0.2);
    expect(offs(ev)[0].offset / SR).toBeGreaterThan(0.6);
    expect(offs(ev)[0].offset / SR).toBeLessThan(0.85);
  });

  it.each([
    ['saw', 55, (f: number) => saw(f, secs(0.6), SR, 0.4)],
    ['saw', 69, (f: number) => saw(f, secs(0.6), SR, 0.4)],
    ['voice-like', 52, (f: number) => voice(f, secs(0.6), SR, 0.4)],
    ['voice-like', 45, (f: number) => voice(f, secs(0.6), SR, 0.4)],
    ['voice-like', 64, (f: number) => voice(f, secs(0.6), SR, 0.4)],
    ['voice-like', 71, (f: number) => voice(f, secs(0.6), SR, 0.4)],
  ])('%s tone at MIDI %i gives that note (no octave errors)', (_name, note, make) => {
    const ev = detect(concat((make as (f: number) => Float32Array)(hz(note)), silence(0.3)));
    expect(ons(ev).map((e) => e.note)).toEqual([note]);
  });

  it('follows a melody: A3, C4, E4, G4 held back-to-back, each note once, in order', () => {
    const melody = [57, 60, 64, 67];
    const x = concat(...melody.map((n) => sine(hz(n), secs(0.4), SR, 0.5)), silence(0.3));
    const ev = detect(x);
    expect(ons(ev).map((e) => e.note)).toEqual(melody);
    const ns = notes(ev);
    expect(ns.map((n) => n[0])).toEqual(melody);
    // every note starts within 150 ms of when it was sung, and notes do not overlap
    ns.forEach(([, start], i) => {
      expect(start - i * 0.4).toBeGreaterThan(0);
      expect(start - i * 0.4).toBeLessThan(0.15);
    });
    for (let i = 1; i < ns.length; i++) expect(ns[i][1]).toBeGreaterThanOrEqual(ns[i - 1][2]);
  });

  it('does not flutter on vibrato (+-40 cents at 5.5 Hz) or an out-of-tune note (35 cents sharp)', () => {
    const n = secs(1);
    const vib = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const cents = 40 * Math.sin((2 * Math.PI * 5.5 * i) / SR);
      phase += (2 * Math.PI * hz(62) * Math.pow(2, cents / 1200)) / SR;
      vib[i] = 0.5 * Math.sin(phase);
    }
    const ev = detect(concat(vib, silence(0.3)));
    expect(ons(ev).map((e) => e.note)).toEqual([62]);
    const sharp = detect(concat(sine(hz(62) * Math.pow(2, 35 / 1200), secs(0.6), SR, 0.5), silence(0.3)));
    expect(ons(sharp).map((e) => e.note)).toEqual([62]);
  });

  it('ignores noise, silence and sounds below the gate', () => {
    expect(detect(noise(secs(1), 3, 0.5))).toEqual([]);
    expect(detect(silence(1))).toEqual([]);
    expect(detect(sine(440, secs(1), SR, 0.001), { gate: -45 })).toEqual([]);
    expect(ons(detect(sine(440, secs(1), SR, 0.001), { gate: -70 })).length).toBe(1);
  });

  it('finds a tone buried in moderate noise', () => {
    const x = sine(hz(60), secs(0.8), SR, 0.4).map((v, i) => v + 0.04 * (Math.sin(i * 12.9898) * 43758.5453 % 1));
    expect(ons(detect(concat(x, silence(0.3)))).map((e) => e.note)).toEqual([60]);
  });

  it('respects the lowest / highest note limits', () => {
    expect(detect(sine(hz(100), secs(0.6), SR, 0.5), { maxNote: 90 })).toEqual([]);
    expect(detect(sine(hz(40), secs(0.6), SR, 0.5), { minNote: 50 })).toEqual([]);
  });

  it('snaps to a scale: C major turns C#4 (heard 61.4) into D4', () => {
    const f = hz(61.4);
    expect(ons(detect(concat(sine(f, secs(0.6), SR, 0.5), silence(0.3)), { scale: 'off' })).map((e) => e.note)).toEqual([61]);
    expect(ons(detect(concat(sine(f, secs(0.6), SR, 0.5), silence(0.3)), { scale: 'major', key: '0' })).map((e) => e.note)).toEqual([62]);
    // A minor pentatonic, key A: 63.2 (D#) lands on E (64)
    expect(ons(detect(concat(sine(hz(63.2), secs(0.6), SR, 0.5), silence(0.3)), { scale: 'pentatonic-minor', key: '9' })).map((e) => e.note)).toEqual([64]);
  });

  it('louder singing gives higher velocity', () => {
    const quiet = ons(detect(concat(sine(hz(60), secs(0.6), SR, 0.02), silence(0.3))))[0];
    const loud = ons(detect(concat(sine(hz(60), secs(0.6), SR, 0.6), silence(0.3))))[0];
    expect(loud.velocity).toBeGreaterThan(quiet.velocity);
    expect(loud.velocity).toBeLessThanOrEqual(1);
    expect(quiet.velocity).toBeGreaterThan(0);
  });

  it('works at 44.1 kHz and 22.05 kHz', () => {
    for (const sr of [44100, 22050]) {
      const x = concat(sine(hz(57), secs(0.6, sr), sr, 0.5), silence(0.3, sr));
      expect(ons(detect(x, {}, sr)).map((e) => e.note)).toEqual([57]);
    }
  });

  it('a click (8 ms) does not create a note; a pause between two same notes gives two', () => {
    expect(ons(detect(concat(silence(0.2), sine(hz(60), secs(0.008), SR, 0.5), silence(0.5))))).toEqual([]);
    const two = detect(concat(sine(hz(60), secs(0.4), SR, 0.5), silence(0.25), sine(hz(60), secs(0.4), SR, 0.5), silence(0.3)));
    expect(ons(two).map((e) => e.note)).toEqual([60, 60]);
  });

  it('optional pitch bend follows a slide inside a note', () => {
    const n = secs(0.8);
    const x = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += (2 * Math.PI * hz(60) * Math.pow(2, (0.4 * (i / n)) / 12)) / SR;
      x[i] = 0.5 * Math.sin(phase);
    }
    const ev = detect(concat(x, silence(0.3)), { bend: true });
    const bends = ev.filter((e) => e.type === 'bend');
    expect(ons(ev).map((e) => e.note)).toEqual([60]);
    expect(bends.length).toBeGreaterThan(2);
    expect(bends[bends.length - 1].value).toBeGreaterThan(bends[0].value);
  });

  it('emits events only with valid offsets and 0..1 velocities', () => {
    const ev = detect(concat(sine(hz(60), secs(0.5), SR, 0.5), silence(0.3)));
    for (const e of ev) {
      expect(e.offset).toBeGreaterThanOrEqual(0);
      expect(e.velocity).toBeGreaterThanOrEqual(0);
      expect(e.velocity).toBeLessThanOrEqual(1);
    }
  });
});

/** A sung line: pitch(t) as a fractional MIDI note, amp(t); a harmonic voice with a weak fundamental and a little breath noise. */
function sing(seconds: number, pitch: (t: number) => number, amp: (t: number) => number = (t) => (t > seconds - 0.3 ? 0 : 0.4), breath = 0.01): Float32Array {
  const n = secs(seconds);
  const o = new Float32Array(n);
  const g = [0.5, 1, 0.8, 0.5, 0.3, 0.2];
  let ph = 0;
  let s = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * hz(pitch(t))) / SR;
    let v = 0;
    for (let h = 0; h < g.length; h++) v += g[h] * Math.sin(ph * (h + 1));
    s = (s * 1664525 + 1013904223) >>> 0;
    o[i] = amp(t) * (v / 2.6) + breath * ((s / 2 ** 32) * 2 - 1);
  }
  return o;
}
const vib = (cents: number, rate = 6) => (t: number) => (cents / 100) * Math.sin(2 * Math.PI * rate * t);
const ease = (x: number) => x * x * (3 - 2 * x);
const ramp = (t: number, from: number, len: number) => ease(Math.min(1, Math.max(0, (t - from) / len)));
const sung = (x: Float32Array) => ons(detect(x)).map((e) => e.note);

describe('audio-to-midi on real singing: one note per sung note', () => {
  it.each([50, 80, 100, 150])('wide vibrato (+-%i cents at 6 Hz) stays one note, no trill between neighbours', (cents) => {
    expect(sung(sing(2.3, (t) => 62 + vib(cents)(t) * Math.min(1, t / 0.4)))).toEqual([62]);
  });
  it.each([0.08, 0.15, 0.3, 0.5])('a slide from C4 to G4 over %f s plays the two notes, not the ones passed through', (d) => {
    expect(sung(sing(2.3, (t) => 60 + 7 * ramp(t, 0.8, d)))).toEqual([60, 67]);
  });
  it('a legato line with short slides plays each note once', () => {
    const seq = [60, 64, 67, 72];
    const line = (t: number) => {
      const k = Math.min(3, Math.floor(t / 0.7));
      return k === 0 ? 60 : seq[k - 1] + (seq[k] - seq[k - 1]) * ramp(t, k * 0.7, 0.12);
    };
    expect(sung(sing(3.3, line))).toEqual(seq);
  });
  it('a scoop into the note is waited out, also with vibrato after it', () => {
    expect(sung(sing(1.5, (t) => 64 - 2 * (1 - ramp(t, 0, 0.12))))).toEqual([64]);
    expect(sung(sing(2, (t) => 64 - 3 * (1 - ramp(t, 0, 0.2)) + vib(60)(t) * ramp(t, 0.4, 0.3)))).toEqual([64]);
  });
  it('the pitch dropping as a note dies away is not a new note', () => {
    const amp = (t: number) => (t > 1.3 ? 0 : t > 1.1 ? 0.4 * (1 - (t - 1.1) / 0.2) : 0.4);
    expect(sung(sing(1.6, (t) => 64 - 4 * ramp(t, 1.1, 0.15), amp))).toEqual([64]);
  });
  it('drift, consonants, tremolo, a quiet breathy voice and a decaying note stay one note', () => {
    expect(sung(sing(2.3, (t) => 62 + 0.45 * Math.sin(2 * Math.PI * 0.7 * t)))).toEqual([62]);
    expect(sung(sing(2.3, () => 62, (t) => (t > 2 ? 0 : t % 0.4 < 0.03 ? 0.01 : 0.4), 0.03))).toEqual([62]);
    expect(sung(sing(2.3, () => 62, (t) => (t > 2 ? 0 : 0.25 + 0.15 * Math.sin(2 * Math.PI * 5 * t))))).toEqual([62]);
    expect(sung(sing(2.3, () => 62, (t) => (t > 2 ? 0 : 0.03), 0.02))).toEqual([62]);
    expect(sung(sing(2.3, () => 62, (t) => 0.4 * Math.exp(-t * 3)))).toEqual([62]);
  });
  it('vibrato from the very first moment settles on the right note within two notes (never a trill)', () => {
    for (const [note, cents, rate] of [[43, 80, 5.5], [79, 100, 6.5]]) {
      const got = sung(sing(2.3, (t) => note + vib(cents, rate)(t)));
      expect(got.length, String(got)).toBeLessThanOrEqual(2);
      expect(got[got.length - 1]).toBe(note);
    }
  });
  it('still answers quickly: a plain note within 120 ms, a step to another note within 150 ms', () => {
    const ev = detect(concat(sine(hz(60), secs(0.5), SR, 0.5), sine(hz(64), secs(0.5), SR, 0.5), silence(0.3)));
    expect(ons(ev).map((e) => e.note)).toEqual([60, 64]);
    expect(ons(ev)[0].offset / SR).toBeLessThan(0.12);
    expect(ons(ev)[1].offset / SR - 0.5).toBeLessThan(0.15);
  });
});
