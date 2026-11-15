import { describe, expect, it } from 'vitest';
import { SR, getDef, noise, off, on, runKernel, sine, voice } from '../../audio/testing';
import type { MidiEvent } from '../../audio/types';

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const level = (p: Record<string, unknown>, x: Float32Array, frames = x.length) => runKernel(getDef('audio-level'), { params: p, inputs: { audio: x }, frames });
const cat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('audio-level (kernel)', () => {
  const amp = Math.pow(10, -12 / 20); // a -12 dBFS (peak) sine

  it('maps loudness from the dB range to From..To (-12 dBFS sine = -15.05 dB RMS)', () => {
    const r = level({ floor: -60, ceiling: 0 }, sine(440, SR, SR, amp));
    expect(Math.abs(r.signals.level - (60 - 15.05) / 60)).toBeLessThan(0.01);
    expect(r.signals.peak).toBeCloseTo((60 - 12) / 60, 2);
    const mapped = level({ floor: -60, ceiling: 0, from: 10, to: 20 }, sine(440, SR, SR, amp));
    expect(mapped.signals.level).toBeCloseTo(10 + 10 * ((60 - 15.05) / 60), 1);
  });
  it('clamps below the floor and above the ceiling; input boost shifts the level', () => {
    expect(level({ floor: -40, ceiling: -10 }, sine(440, SR, SR, 0.0005)).signals.level).toBe(0);
    expect(level({ floor: -40, ceiling: -10 }, sine(440, SR, SR, 0.9)).signals.level).toBe(1);
    const quiet = level({ floor: -60, ceiling: 0 }, sine(440, SR, SR, 0.01)).signals.level;
    const boosted = level({ floor: -60, ceiling: 0, gain: 20 }, sine(440, SR, SR, 0.01)).signals.level;
    expect(boosted - quiet).toBeCloseTo(20 / 60, 2);
  });
  it('silence and no input give the From value', () => {
    expect(level({ from: 3, to: 9 }, new Float32Array(SR / 2)).signals.level).toBe(3);
    const none = runKernel(getDef('audio-level'), { params: { from: 3, to: 9 }, frames: 1000 });
    expect(none.signals.level).toBe(3);
    expect(none.signals.pitch).toBe(3);
  });
  it('attack and release times shape the response', () => {
    const burst = cat(new Float32Array(SR / 10), sine(440, SR / 2, SR, 0.5), new Float32Array(SR));
    const at = (r: ReturnType<typeof level>, sec: number) => r.signalHistory.level[Math.floor((sec * SR) / 128)];
    const fastAtk = level({ attack: 5, release: 100 }, burst);
    const slowAtk = level({ attack: 200, release: 100 }, burst);
    expect(at(fastAtk, 0.1 + 0.03)).toBeGreaterThan(at(slowAtk, 0.1 + 0.03) + 0.1);
    const fastRel = level({ attack: 5, release: 30 }, burst);
    const slowRel = level({ attack: 5, release: 1000 }, burst);
    expect(at(slowRel, 0.6 + 0.2)).toBeGreaterThan(at(fastRel, 0.6 + 0.2) + 0.2);
    expect(at(fastRel, 1.5)).toBeLessThan(0.02);
  });
  it('splits bass, mids and treble', () => {
    const run = (f: number) => level({ floor: -80, ceiling: 0 }, sine(f, SR / 2, SR, 0.5)).signals;
    const lo = run(80);
    expect(lo.low).toBeGreaterThan(lo.mid + 0.1);
    expect(lo.low).toBeGreaterThan(lo.high + 0.2);
    const mid = run(900);
    expect(mid.mid).toBeGreaterThan(mid.low + 0.1);
    expect(mid.mid).toBeGreaterThan(mid.high + 0.1);
    const hi = run(9000);
    expect(hi.high).toBeGreaterThan(hi.mid + 0.1);
    expect(hi.high).toBeGreaterThan(hi.low + 0.2);
  });
  it.each([
    [48, 0.25],
    [60, 0.5],
    [72, 0.75],
  ])('pitch of MIDI note %i is the position %f between lowest 36 and highest 84', (note, pos) => {
    const r = level({ minNote: 36, maxNote: 84 }, sine(hz(note), SR, SR, 0.5));
    expect(r.signals.pitch).toBeCloseTo(pos, 1);
    const voiced = level({ minNote: 36, maxNote: 84 }, voice(hz(note), SR, SR, 0.4));
    expect(voiced.signals.pitch).toBeCloseTo(pos, 1);
  });
  it('pitch maps to From..To and holds the last pitch across silence (unless turned off)', () => {
    const x = cat(sine(hz(60), SR / 2, SR, 0.5), new Float32Array(SR));
    const held = level({ from: 0, to: 10 }, x);
    expect(held.signals.pitch).toBeCloseTo(5, 0);
    expect(held.signals.level).toBeLessThan(0.5); // loudness fell away while pitch stayed
    const dropped = level({ from: 0, to: 10, holdPitch: false }, x);
    expect(dropped.signals.pitch).toBeLessThan(0.5);
  });
  it('pitch follows a change of note smoothly', () => {
    const x = cat(sine(hz(48), SR / 2, SR, 0.5), sine(hz(72), SR / 2, SR, 0.5));
    const r = level({}, x);
    const h = r.signalHistory.pitch;
    expect(h[Math.floor((0.45 * SR) / 128)]).toBeCloseTo(0.25, 1);
    expect(h[h.length - 1]).toBeCloseTo(0.75, 1);
  });
  it('noise does not move the pitch output', () => {
    expect(level({ from: 0, to: 1 }, noise(SR, 4, 0.3)).signals.pitch).toBe(0);
  });
});

const seq = (events: MidiEvent[], params: Record<string, unknown> = {}, frames = SR) => runKernel(getDef('midi-value'), { params, midi: { midi: events }, frames });

describe('midi-value (kernel)', () => {
  it('follows a scripted note sequence: note, strength, keys held', () => {
    const script = [on(60, 0, 0.5), on(72, 12000, 1), off(72, 24000), off(60, 36000)];
    const frames = 48000 * 2;
    const r = seq(script, {}, frames);
    const at = (name: string, sec: number) => r.signalHistory[name][Math.floor((sec * SR) / 128)];
    expect(at('note', 0.1)).toBeCloseTo((60 - 36) / 48, 3);
    expect(at('velocity', 0.1)).toBeCloseTo(0.5, 5);
    expect(at('count', 0.1)).toBe(1);
    expect(at('note', 0.3)).toBeCloseTo((72 - 36) / 48, 3); // most recent
    expect(at('count', 0.3)).toBe(2);
    expect(at('count', 0.6)).toBe(1);
    expect(at('note', 0.6)).toBeCloseTo((60 - 36) / 48, 3); // back to the remaining key
    expect(at('gate', 0.6)).toBeGreaterThan(0.99);
    expect(at('count', 1.5)).toBe(0);
    expect(at('gate', 1.9)).toBeLessThan(0.01);
    expect(at('note', 1.9)).toBeCloseTo((60 - 36) / 48, 3); // the picture keeps the last note
  });
  it('highest / lowest note modes and From..To mapping', () => {
    const held = [on(48, 0), on(72, 0), on(60, 0)];
    expect(seq(held, { which: 'highest', from: 0, to: 100 }, 1024).signals.note).toBeCloseTo((100 * 36) / 48, 3);
    expect(seq(held, { which: 'lowest', from: 0, to: 100 }, 1024).signals.note).toBeCloseTo(25, 3);
    expect(seq([on(10, 0)], {}, 1024).signals.note).toBe(0); // below range clamps to From
    expect(seq([on(120, 0)], { from: 2, to: 4 }, 1024).signals.note).toBe(4);
  });
  it('gate rises and falls with attack/release smoothing', () => {
    const r = seq([on(60, 0), off(60, 24000)], { attack: 100, release: 400 }, SR * 2);
    const g = r.signalHistory.gate;
    const at = (sec: number) => g[Math.floor((sec * SR) / 128)];
    expect(at(0.02)).toBeLessThan(0.4);
    expect(at(0.5)).toBeGreaterThan(0.95);
    expect(at(0.5 + 0.2)).toBeGreaterThan(0.4); // slow release: still up 200 ms after key up
    expect(at(1.9)).toBeLessThan(0.05);
  });
  it('note glide slides between notes', () => {
    const r = seq([on(36, 0), on(84, 4800)], { glide: 200 }, SR);
    const h = r.signalHistory.note;
    const at = (sec: number) => h[Math.floor((sec * SR) / 128)];
    expect(at(0.05)).toBeCloseTo(0, 2);
    expect(at(0.2)).toBeGreaterThan(0.2);
    expect(at(0.2)).toBeLessThan(0.9);
    expect(at(0.9)).toBeGreaterThan(0.98);
  });
  it('reports the chosen controller', () => {
    const cc = (n: number, v: number, offset: number): MidiEvent => ({ type: 'cc', note: n, velocity: 0, value: v, offset, channel: 0 });
    expect(seq([cc(1, 0.25, 0), cc(7, 0.9, 10)], { controller: 1 }, 1024).signals.cc).toBeCloseTo(0.25, 5);
    expect(seq([cc(1, 0.25, 0), cc(7, 0.9, 10)], { controller: 7 }, 1024).signals.cc).toBeCloseTo(0.9, 5);
  });
  it('no events: everything is quiet', () => {
    const r = seq([], {}, 1024);
    expect(r.signals).toMatchObject({ note: 0, velocity: 0, gate: 0, count: 0, cc: 0 });
  });
});

describe('midi-trigger (kernel)', () => {
  const trig = (events: MidiEvent[], params: Record<string, unknown> = {}, frames = SR) => runKernel(getDef('midi-trigger'), { params, midi: { midi: events }, frames });
  const at = (r: ReturnType<typeof trig>, sec: number) => r.signalHistory.envelope[Math.floor((sec * SR) / 128)];

  it('pulses on each note-on: fast rise to the top, then falls', () => {
    const r = trig([on(60, 0)], { attack: 5, decay: 100, sustain: 0 });
    expect(at(r, 0.001)).toBeLessThan(0.7);
    expect(Math.max(...r.signalHistory.envelope)).toBeGreaterThan(0.97);
    expect(at(r, 0.02)).toBeGreaterThan(0.4);
    expect(at(r, 0.1)).toBeLessThan(0.35);
    expect(at(r, 0.5)).toBeLessThan(0.01);
    // monotonic fall after the peak
    const h = r.signalHistory.envelope;
    const peakIdx = h.indexOf(Math.max(...h));
    for (let i = peakIdx + 1; i < h.length; i++) expect(h[i]).toBeLessThanOrEqual(h[i - 1] + 1e-9);
  });
  it('every note retriggers the pulse', () => {
    const r = trig([on(60, 0), off(60, 4800), on(62, 24000), off(62, 28800)], { attack: 2, decay: 60 });
    expect(at(r, 0.2)).toBeLessThan(0.05);
    expect(at(r, 0.5 + 0.006)).toBeGreaterThan(0.5);
  });
  it('sustain holds a level while the key is down and fades after release', () => {
    const r = trig([on(60, 0), off(60, 24000)], { attack: 2, decay: 30, sustain: 0.5, release: 100 });
    expect(at(r, 0.4)).toBeCloseTo(0.5, 2);
    expect(at(r, 0.5 + 0.05)).toBeLessThan(0.4);
    expect(at(r, 0.95)).toBeLessThan(0.01);
  });
  it('velocity scales the pulse (or not), and From..To maps the output', () => {
    expect(Math.max(...trig([on(60, 0, 0.4)], {}).signalHistory.envelope)).toBeCloseTo(0.4, 1);
    expect(Math.max(...trig([on(60, 0, 0.4)], { velocity: false }).signalHistory.envelope)).toBeGreaterThan(0.97);
    expect(Math.max(...trig([on(60, 0)], { from: 10, to: 30 }).signalHistory.envelope)).toBeGreaterThan(29.4);
    expect(trig([], { from: 10, to: 30 }, 1024).signals.envelope).toBe(10);
  });
});
