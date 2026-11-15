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
