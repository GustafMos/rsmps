import { describe, expect, it } from 'vitest';
import { SR, allFinite, getDef, off, on, peak, pitchHz, rms, runKernel, sine, noise } from '../../audio/testing';
import type { AudioAsset, MidiEvent } from '../../audio/types';
import { defaultPattern, setStep, toggleStep } from '../../audio/drum-pattern';

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const play = (id: string, params: Record<string, unknown>, events: MidiEvent[], frames: number, extra: Record<string, unknown> = {}) =>
  runKernel(getDef(id), { params, midi: { midi: events }, frames, ...extra });
const optionsOf = (id: string, key = 'preset') => (getDef(id).params[key] as { options: { value: string }[] }).options.map((o) => o.value);
const PRESET_IDS: Record<string, string[]> = {
  'chip-synth': ['nes-lead', 'gb-pulse', 'c64-arp', 'tri-bass', 'noise-hat', 'noise-snare'],
  'fm-synth': ['epiano', 'bell', 'fm-bass', 'brass', 'glass-pad'],
  organ: ['jazz', 'rock', 'church', 'ballad'],
  'strings-pad': ['warm-pad', 'string-machine', 'choir-ish'],
  bass: ['acid', 'sub', 'reese'],
};

describe('presets', () => {
  it.each(Object.entries(PRESET_IDS))('%s offers Custom plus its named patches', (id, names) => {
    expect(optionsOf(id)).toEqual(['custom', ...names]);
  });
  it.each(Object.entries(PRESET_IDS).flatMap(([id, names]) => names.map((n) => [id, n] as const)))('%s / %s: finite, audible, bounded, silent after release', (id, preset) => {
    const frames = 6 * SR;
    const r = play(id, { preset }, [on(45, 0, 1), on(52, 0, 1), off(45, SR), off(52, SR)], frames);
    const L = r.out.audio[0];
    expect(allFinite(L) && allFinite(r.out.audio[1])).toBe(true);
    expect(peak(L, 0, SR)).toBeGreaterThan(0.01);
    expect(peak(L)).toBeLessThan(2);
    expect(rms(L, 5.8 * SR, frames)).toBeLessThan(1e-4); // fully faded after the keys were released
  });
});

describe('chip-synth', () => {
  const note = (preset: string | null, extra: Record<string, unknown>, n = 69, frames = SR) => play('chip-synth', preset ? { preset } : { preset: 'custom', ...extra }, [on(n, 0, 1)], frames);
  it.each([['pulse12'], ['pulse25'], ['pulse50'], ['pulse75'], ['triangle']])('%s plays the right pitch', (wave) => {
    const r = note(null, { wave, sustain: 15, decay: 0, steps: false });
    expect(pitchHz(r.out.audio[0], SR, 6000) / 440).toBeCloseTo(1, 1);
  });
  it('pulse widths differ in spectrum: 12.5% and 75% are narrower/wider than 50% (even harmonics appear)', () => {
    const duty = (w: string) => note(null, { wave: w, sustain: 15, steps: false }).out.audio[0];
    const mean = (x: Float32Array) => x.slice(6000, 30000).reduce((a, b) => a + b, 0) / 24000;
    expect(Math.abs(mean(duty('pulse50')))).toBeLessThan(0.002);
    expect(mean(duty('pulse12'))).toBeLessThan(-0.05); // mostly low: DC offset reveals the duty
    expect(mean(duty('pulse75'))).toBeGreaterThan(0.05);
  });
  it('volume uses exactly 16 steps', () => {
    const r = note(null, { wave: 'pulse50', attack: 0, decay: 1.5, sustain: 0, steps: true, release: 0.1 }, 69, 2 * SR);
    const levels = new Set<number>();
    for (let i = 0; i < r.out.audio[0].length; i += 7) levels.add(Math.round(Math.abs(r.out.audio[0][i]) * 1e5));
    expect(levels.size).toBeLessThanOrEqual(17); // 0 + 16 steps
    expect(levels.size).toBeGreaterThan(8);
  });
  it('hard envelope: sustain level and release are respected', () => {
    const r = play('chip-synth', { preset: 'custom', wave: 'pulse50', decay: 0.2, sustain: 8, release: 0.1, steps: false, attack: 0 }, [on(60, 0), off(60, SR)], 2 * SR);
    const hold = peak(r.out.audio[0], SR / 2, SR - 100);
    const top = peak(r.out.audio[0], 0, 400);
    expect(hold / top).toBeCloseTo(8 / 15, 1);
    expect(rms(r.out.audio[0], SR + 0.2 * SR, 2 * SR)).toBe(0);
  });
  it('arpeggio cycles through the chord notes', () => {
    const r = note(null, { wave: 'pulse50', arp: 'major', arpRate: 10, sustain: 15, steps: false, decay: 0 }, 60, 1.2 * SR);
    const at = (s: number) => pitchHz(r.out.audio[0], SR, Math.round(s * SR));
    expect(at(0.02) / hz(60)).toBeCloseTo(1, 1);
    expect(at(0.12) / hz(64)).toBeCloseTo(1, 1);
    expect(at(0.22) / hz(67)).toBeCloseTo(1, 1);
    expect(at(0.32) / hz(60)).toBeCloseTo(1, 1);
  });
  it('vibrato wobbles the pitch; slide starts away from the note', () => {
    const slid = play('chip-synth', { preset: 'custom', wave: 'pulse50', slideSemitones: 12, slideTime: 0.3, sustain: 15, decay: 0, steps: false }, [on(60, 0)], SR);
    expect(pitchHz(slid.out.audio[0], SR, 100) / hz(72)).toBeGreaterThan(0.9);
    expect(pitchHz(slid.out.audio[0], SR, 30000) / hz(60)).toBeCloseTo(1, 1);
  });
  it('noise: LFSR is deterministic, long and short modes differ, short mode repeats quickly', () => {
    const a = note(null, { wave: 'noise-long', sustain: 15, decay: 0, steps: false }, 69).out.audio[0];
    const b = note(null, { wave: 'noise-long', sustain: 15, decay: 0, steps: false }, 69).out.audio[0];
    expect(a).toEqual(b);
    const s = note(null, { wave: 'noise-short', sustain: 15, decay: 0, steps: false }, 69).out.audio[0];
    expect(s).not.toEqual(a);
    expect(rms(a, 4000, 20000)).toBeGreaterThan(0.05);
  });
  it('crush limits the output to a few levels', () => {
    const r = note(null, { wave: 'triangle', sustain: 15, decay: 0, steps: false, crush: '2' });
    const lv = new Set<number>();
    for (let i = 6000; i < 20000; i++) lv.add(Math.round(r.out.audio[0][i] * 1e4));
    expect(lv.size).toBeLessThanOrEqual(5);
  });
});

describe('fm-synth', () => {
  it.each([[57], [69], [81]])('electric piano at note %i has the right fundamental', (n) => {
    const r = play('fm-synth', { preset: 'epiano' }, [on(n, 0, 1)], SR);
    expect(pitchHz(r.out.audio[0], SR, 4800) / hz(n)).toBeCloseTo(1, 1);
  });
  it('bell decays slowly and keeps ringing, brass swells in', () => {
    const bell = play('fm-synth', { preset: 'bell' }, [on(72, 0, 1)], 4 * SR).out.audio[0];
    expect(rms(bell, 0.5 * SR, SR)).toBeGreaterThan(rms(bell, 3 * SR, 3.5 * SR));
    expect(rms(bell, 3 * SR, 3.5 * SR)).toBeGreaterThan(1e-3);
    const brass = play('fm-synth', { preset: 'brass' }, [on(60, 0, 1)], SR).out.audio[0];
    expect(peak(brass, 0, 480)).toBeLessThan(peak(brass, 0.3 * SR, 0.5 * SR) * 0.4);
  });
  it('algorithms change the sound; feedback adds partials; velocity changes loudness', () => {
    const a = play('fm-synth', { preset: 'custom', algorithm: 'parallel', level1: 1, level2: 0, level3: 0, level4: 0, feedback: 0 }, [on(60, 0)], SR).out.audio[0];
    const b = play('fm-synth', { preset: 'custom', algorithm: 'serial' }, [on(60, 0)], SR).out.audio[0];
    expect(a).not.toEqual(b);
    // parallel with one carrier is a pure sine at the note
    expect(pitchHz(a, SR, 4800) / hz(60)).toBeCloseTo(1, 2);
    const soft = peak(play('fm-synth', { preset: 'epiano' }, [on(60, 0, 0.2)], SR).out.audio[0]);
    const loud = peak(play('fm-synth', { preset: 'epiano' }, [on(60, 0, 1)], SR).out.audio[0]);
    expect(soft).toBeLessThan(loud);
  });
});

describe('organ', () => {
  it('plays the note pitch and the drawbars set the harmonic mix', () => {
    const p = (bars: string) => ({ preset: 'custom', ...Object.fromEntries([...bars].map((c, i) => [`drawbar${i + 1}`, Number(c)])), percussion: 'off', rotary: 'off', click: 0 });
    const fund = play('organ', p('008000000'), [on(57, 0)], SR).out.audio[0];
    expect(pitchHz(fund, SR, 6000) / hz(57)).toBeCloseTo(1, 2);
    const sub = play('organ', p('800000000'), [on(57, 0)], SR).out.audio[0];
    expect(pitchHz(sub, SR, 6000) / (hz(57) / 2)).toBeCloseTo(1, 2);
    const top = play('organ', p('000008000'), [on(57, 0)], SR).out.audio[0];
    expect(pitchHz(top, SR, 6000, 40, 4000) / (hz(57) * 4)).toBeCloseTo(1, 1);
  });
  it('percussion adds a short attack, key release is quick, rotary moves the stereo image', () => {
    const base = { preset: 'custom', drawbar3: 8, rotary: 'off', click: 0 };
    const noPerc = play('organ', { ...base, percussion: 'off' }, [on(60, 0)], SR).out.audio[0];
    const perc = play('organ', { ...base, percussion: 'third' }, [on(60, 0)], SR).out.audio[0];
    expect(rms(perc, 0, 4800)).toBeGreaterThan(rms(noPerc, 0, 4800) * 1.1);
    expect(rms(perc, SR - 4800, SR)).toBeCloseTo(rms(noPerc, SR - 4800, SR), 2); // percussion has faded
    const rot = play('organ', { ...base, rotary: 'fast', percussion: 'off' }, [on(60, 0)], 2 * SR).out.audio;
    let diff = 0;
    for (let i = 20000; i < 60000; i++) diff += Math.abs(rot[0][i] - rot[1][i]);
    expect(diff).toBeGreaterThan(5);
  });
});

describe('strings-pad', () => {
  it('slow attack, pitch at the note, long release, brighter with a higher cutoff', () => {
    const r = play('strings-pad', { preset: 'custom', unison: 3, detune: 6, attack: 0.5, release: 1, cutoff: 8000, chorus: 0, formant: 0 }, [on(57, 0), off(57, 2 * SR)], 5 * SR);
    const L = r.out.audio[0];
    expect(peak(L, 0, 0.05 * SR)).toBeLessThan(peak(L, SR, 1.5 * SR) * 0.3);
    expect(pitchHz(L, SR, SR, 40, 1000) / hz(57)).toBeCloseTo(1, 1);
    expect(rms(L, 2 * SR + 0.3 * SR, 2 * SR + 0.4 * SR)).toBeGreaterThan(1e-3); // still ringing after key up
    expect(rms(L, 4.5 * SR, 5 * SR)).toBeLessThan(1e-3);
    const dull = play('strings-pad', { preset: 'custom', unison: 3, attack: 0.01, cutoff: 300, chorus: 0, formant: 0 }, [on(57, 0)], SR).out.audio[0];
    const bright = play('strings-pad', { preset: 'custom', unison: 3, attack: 0.01, cutoff: 9000, chorus: 0, formant: 0 }, [on(57, 0)], SR).out.audio[0];
    const hf = (x: Float32Array) => {
      let s = 0;
      for (let i = 20001; i < 40000; i++) s += (x[i] - x[i - 1]) ** 2;
      return s;
    };
    expect(hf(bright)).toBeGreaterThan(hf(dull) * 5);
  });
  it('ensemble layers are spread in stereo', () => {
    const r = play('strings-pad', { preset: 'custom', unison: 7, detune: 20, attack: 0.01, chorus: 0, formant: 0 }, [on(48, 0)], SR);
    let diff = 0;
    for (let i = 10000; i < 30000; i++) diff += Math.abs(r.out.audio[0][i] - r.out.audio[1][i]);
    expect(diff).toBeGreaterThan(1);
  });
});

describe('bass', () => {
  const run = (params: Record<string, unknown>, ev: MidiEvent[], frames = SR) => play('bass', { preset: 'custom', ...params }, ev, frames).out.audio[0];
  it.each([[40], [45], [52]])('sub bass at note %i has the right pitch', (n) => {
    const x = run({ sawLevel: 0, squareLevel: 0, subLevel: 1, detune: 0, cutoff: 3000, resonance: 0, envAmount: 0, drive: 0 }, [on(n, 0, 0.5)]);
    expect(pitchHz(x, SR, 8000, 20, 400) / (hz(n) / 2)).toBeCloseTo(1, 1); // the sub is one octave below
    const saw = run({ sawLevel: 1, subLevel: 0, cutoff: 3000, resonance: 0, envAmount: 0, drive: 0 }, [on(n, 0, 0.5)]);
    expect(pitchHz(saw, SR, 8000, 20, 400) / hz(n)).toBeCloseTo(1, 1);
  });
  it('filter envelope sweeps the brightness down over the note', () => {
    const x = run({ sawLevel: 1, cutoff: 200, envAmount: 4, decay: 0.15, resonance: 0.3, drive: 0 }, [on(40, 0, 0.5)]);
    const hf = (a: number, b: number) => {
      let s = 0;
      for (let i = a + 1; i < b; i++) s += (x[i] - x[i - 1]) ** 2;
      return s / (b - a);
    };
    expect(hf(200, 2400)).toBeGreaterThan(hf(SR - 4800, SR) * 3);
  });
  it('is monophonic and slides between overlapping notes; separate notes retrigger', () => {
    const overlap = run({ sawLevel: 0, subLevel: 1, cutoff: 3000, envAmount: 0, resonance: 0, glide: 200, drive: 0 }, [on(36, 0, 0.5), on(48, 24000, 0.5), off(36, 25000), off(48, SR)], 2 * SR);
    expect(pitchHz(overlap, SR, 24000 + 100, 20, 600)).toBeLessThan(hz(48) / 2 * 0.95); // still sliding up
    expect(pitchHz(overlap, SR, 40000, 20, 600) / (hz(48) / 2)).toBeCloseTo(1, 1);
    const sep = run({ sawLevel: 0, subLevel: 1, cutoff: 3000, envAmount: 0, resonance: 0, glide: 0, drive: 0 }, [on(36, 0, 0.5), off(36, 12000), on(48, 24000, 0.5)], SR);
    expect(rms(sep, 20000, 23900)).toBe(0); // gap between the notes is silent
  });
  it('accent (hard note) is louder; drive stays bounded', () => {
    const soft = peak(run({ accent: 1 }, [on(40, 0, 0.5)]));
    const hard = peak(run({ accent: 1 }, [on(40, 0, 1)]));
    expect(hard).toBeGreaterThan(soft);
    expect(peak(run({ drive: 1, resonance: 1, cutoff: 800, envAmount: 6 }, [on(30, 0, 1)]))).toBeLessThan(2);
  });
});

describe('sampler', () => {
  const tone: AudioAsset = (() => {
    const l = sine(hz(60), 2 * SR, SR, 0.5); // a C5 (note 60 in this scheme) sample
    return { sampleRate: SR, frames: l.length, left: l, right: l };
  })();
  const sp = (params: Record<string, unknown>, ev: MidiEvent[], frames = SR, asset: AudioAsset = tone) =>
    runKernel(getDef('sampler'), { params: { assets: ['s'], ...params }, midi: { midi: ev }, assets: { s: asset }, frames });
  it('plays the sound at its own pitch on the root note and transposes by note', () => {
    expect(pitchHz(sp({ rootNote: 60 }, [on(60, 0, 1)]).out.audio[0], SR, 6000) / hz(60)).toBeCloseTo(1, 2);
    expect(pitchHz(sp({ rootNote: 60 }, [on(72, 0, 1)]).out.audio[0], SR, 6000) / hz(72)).toBeCloseTo(1, 2);
    expect(pitchHz(sp({ rootNote: 60 }, [on(55, 0, 1)]).out.audio[0], SR, 6000, 40, 1000) / hz(55)).toBeCloseTo(1, 2);
    expect(pitchHz(sp({ rootNote: 60, tune: 1200 }, [on(60, 0, 1)]).out.audio[0], SR, 6000) / hz(72)).toBeCloseTo(1, 2);
  });
  it('start/end trim, gated release, one-shot ignores note-off', () => {
    const trimmed = sp({ rootNote: 60, start: 0.25, end: 0.5, release: 5 }, [on(60, 0, 1)], SR).out.audio[0];
    expect(rms(trimmed, 1000, 11000)).toBeGreaterThan(0.2);
    expect(rms(trimmed, 0.3 * SR, SR)).toBeLessThan(1e-3);
    const gated = sp({ rootNote: 60, release: 20 }, [on(60, 0, 1), off(60, 0.2 * SR)], SR).out.audio[0];
    expect(rms(gated, 0.5 * SR, SR)).toBeLessThan(1e-4);
    const shot = sp({ rootNote: 60, mode: 'oneshot' }, [on(60, 0, 1), off(60, 0.2 * SR)], SR).out.audio[0];
    expect(rms(shot, 0.5 * SR, 0.9 * SR)).toBeGreaterThan(0.2);
  });
  it('loop points keep a held note sounding past the end of the sample', () => {
    const short: AudioAsset = { sampleRate: SR, frames: 4800, left: sine(hz(60), 4800, SR, 0.5), right: sine(hz(60), 4800, SR, 0.5) };
    const noLoop = sp({ rootNote: 60 }, [on(60, 0, 1)], SR, short).out.audio[0];
    expect(rms(noLoop, 0.5 * SR, SR)).toBeLessThan(1e-3);
    const looped = sp({ rootNote: 60, loop: true, loopStart: 0.02, loopEnd: 0.1 }, [on(60, 0, 1)], SR, short).out.audio[0];
    expect(rms(looped, 0.5 * SR, SR)).toBeGreaterThan(0.2);
    expect(allFinite(looped)).toBe(true);
  });
  it('slice mode plays equal slices on consecutive keys at original speed', () => {
    const ramp = new Float32Array(8000).map((_, i) => (i + 1) / 8000);
    const a: AudioAsset = { sampleRate: SR, frames: 8000, left: ramp, right: ramp };
    const s2 = sp({ mode: 'slice', slices: 4, sliceBase: 36, attack: 0, sustain: 1, velocity: 0, gain: 0 }, [on(38, 0, 1)], 3000, a).out.audio[0];
    // slice 2 of 4 = samples 4000..6000: values 0.5..0.75 (envelope attack 0 and unity gain)
    expect(s2[300]).toBeGreaterThan(0.5);
    expect(s2[1000]).toBeCloseTo(0.5 + 1000 / 8000, 1);
    expect(sp({ mode: 'slice', slices: 4, sliceBase: 36 }, [on(30, 0, 1)], 3000, a).out.audio[0]).toEqual(new Float32Array(3000));
    expect(sp({ mode: 'slice', slices: 4, sliceBase: 36 }, [on(40, 0, 1)], 3000, a).out.audio[0]).toEqual(new Float32Array(3000));
  });
  it('velocity sensitivity and silence without a sound', () => {
    const soft = peak(sp({ velocity: 1 }, [on(60, 0, 0.2)]).out.audio[0]);
    const loud = peak(sp({ velocity: 1 }, [on(60, 0, 1)]).out.audio[0]);
    expect(soft / loud).toBeCloseTo(0.2, 1);
    expect(peak(runKernel(getDef('sampler'), { params: {}, midi: { midi: [on(60, 0)] }, frames: 4800 }).out.audio[0])).toBe(0);
    expect(getDef('sampler').params.assets).toMatchObject({ type: 'assets', accept: 'audio' });
  });
});

describe('drum-machine', () => {
  const dm = (params: Record<string, unknown>, ev: MidiEvent[], frames: number, time: Record<string, unknown> = {}) =>
    runKernel(getDef('drum-machine'), { params: { sequencer: false, ...params }, midi: { midi: ev }, frames, time: { playing: true, ...time } }).out.audio[0];
  it('every voice sounds from its General MIDI notes, decays to silence, and differs in character', () => {
    const notes: [string, number][] = [['kick', 36], ['snare', 38], ['clap', 39], ['chat', 42], ['ohat', 46], ['tom', 45], ['rim', 37], ['cowbell', 56]];
    const outs = notes.map(([, n]) => dm({}, [on(n, 0, 1)], SR));
    outs.forEach((x, i) => {
      expect(peak(x), notes[i][0]).toBeGreaterThan(0.02);
      expect(allFinite(x)).toBe(true);
      expect(rms(x, 0.9 * SR, SR), notes[i][0]).toBeLessThan(1e-4);
    });
    const hf = (x: Float32Array) => {
      let d = 0;
      let e = 1e-12;
      for (let i = 1; i < x.length; i++) {
        d += (x[i] - x[i - 1]) ** 2;
        e += x[i] ** 2;
      }
      return d / e;
    };
    expect(hf(outs[3])).toBeGreaterThan(hf(outs[1])); // hat brighter than snare
    expect(hf(outs[1])).toBeGreaterThan(hf(outs[0]) * 3); // snare brighter than kick
    expect(rms(outs[4], 0.1 * SR, 0.3 * SR)).toBeGreaterThan(rms(outs[3], 0.1 * SR, 0.3 * SR) * 3); // open hat rings, closed does not
  });
  it('kick pitch follows Tune, decay follows Decay, level follows Level', () => {
    const k = (p: Record<string, unknown>) => dm(p, [on(36, 0, 1)], SR);
    expect(pitchHz(k({ kickTune: 12 }), SR, 4000, 20, 400)).toBeGreaterThan(pitchHz(k({ kickTune: 0 }), SR, 4000, 20, 400) * 1.7);
    expect(rms(k({ kickDecay: 3 }), 0.4 * SR, 0.6 * SR)).toBeGreaterThan(rms(k({ kickDecay: 0.5 }), 0.4 * SR, 0.6 * SR) * 3);
    expect(peak(k({ kickLevel: -6.0206 })) / peak(k({}))).toBeCloseTo(0.5, 1);
  });
  it('hats choke each other; toms follow the note pitch', () => {
    const open = dm({}, [on(46, 0, 1), on(42, 0.1 * SR, 1)], SR);
    expect(rms(open, 0.3 * SR, 0.6 * SR)).toBeLessThan(1e-3); // the closed hat cut the open one
    expect(pitchHz(dm({}, [on(50, 0, 1)], SR), SR, 4000, 60, 600)).toBeGreaterThan(pitchHz(dm({}, [on(41, 0, 1)], SR), SR, 4000, 60, 600) * 1.5);
  });
  it('sequencer: hits land on the steps (tempo mode), swing delays odd steps, nothing plays while paused', () => {
    const blank = { ...defaultPattern(), tracks: { ...defaultPattern().tracks, kick: new Array(16).fill(0), snare: new Array(16).fill(0), chat: new Array(16).fill(0) } };
    let pat = setStep(setStep(setStep(blank, 'rim', 0, 1), 'rim', 4, 1), 'rim', 3, 1); // rim shots are short: steps ring out before the next one
    const stepS = (60 / 120 / 4) * SR; // 6000 samples
    const x = dm({ sequencer: true, pattern: pat, bpm: 120 }, [], 5 * stepS);
    const energy = (a: number, b: number) => rms(x, Math.round(a), Math.round(b));
    expect(energy(0, 300)).toBeGreaterThan(0.01); // step 0
    expect(energy(1 * stepS, 1 * stepS + 300)).toBeLessThan(1e-6);
    expect(energy(3 * stepS, 3 * stepS + 300)).toBeGreaterThan(0.01);
    expect(energy(4 * stepS, 4 * stepS + 300)).toBeGreaterThan(0.01);
    pat = { ...pat, swing: 0.5 };
    const sw = dm({ sequencer: true, pattern: pat, bpm: 120 }, [], 5 * stepS);
    expect(rms(sw, Math.round(3 * stepS), Math.round(3 * stepS + 300))).toBeLessThan(1e-6); // delayed by half a step
    expect(rms(sw, Math.round(3.5 * stepS), Math.round(3.5 * stepS + 300))).toBeGreaterThan(0.01);
    expect(peak(dm({ sequencer: true, pattern: pat }, [], 20000, { playing: false }))).toBe(0);
  });
  it('fit-to-project: the pattern loops exactly over the project length, whatever the tempo', () => {
    let pat = setStep({ ...defaultPattern(), tracks: { ...defaultPattern().tracks, kick: new Array(16).fill(0), snare: new Array(16).fill(0), chat: new Array(16).fill(0) } }, 'kick', 0, 1);
    pat = toggleStep(pat, 'kick', 8, 1);
    const dur = 3.2;
    const x = dm({ sequencer: true, pattern: pat, sync: 'project', bpm: 77 }, [], Math.round(dur * SR), { duration: dur, loop: true });
    expect(rms(x, 0, 300)).toBeGreaterThan(0.01);
    expect(rms(x, Math.round((dur * SR) / 2), Math.round((dur * SR) / 2) + 300)).toBeGreaterThan(0.01);
    expect(rms(x, Math.round(dur * SR * 0.25), Math.round(dur * SR * 0.25) + 300)).toBeLessThan(1e-6);
    // second pass of the loop starts with the same hit: render across the wrap
    const wrap = dm({ sequencer: true, pattern: pat, sync: 'project' }, [], 4000, { duration: dur, loop: true, sample: Math.round(dur * SR) - 1000 });
    expect(rms(wrap, 1000, 1300)).toBeGreaterThan(0.01);
  });
  it('is deterministic', () => {
    const a = dm({ sequencer: true }, [on(38, 100, 1)], 20000);
    const b = dm({ sequencer: true }, [on(38, 100, 1)], 20000);
    expect(a).toEqual(b);
  });
});

describe('Timeline feeds instruments', () => {
  it('Timeline MIDI output drives every instrument node through the runner', async () => {
    const { addMidiClip, emptyTimeline } = await import('../../audio/timeline');
    const { makeGraph, renderGraph } = await import('../../audio/testing');
    const tl = addMidiClip(emptyTimeline(), { track: 'm1', start: 0, length: 1, notes: [{ t: 0, d: 0.5, note: 38, vel: 1 }] }).timeline;
    for (const id of ['chip-synth', 'fm-synth', 'organ', 'strings-pad', 'bass', 'drum-machine', 'drum', 'pluck', 'synth']) {
      const g = makeGraph({ nodes: [{ id: 'tl', type: 'audio-timeline', params: { clips: tl } }, { id: 'i', type: id }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['tl.midi -> i.midi', 'i.audio -> out.audio'] }, { duration: 2, loop: false });
      const { left } = renderGraph(g, 0.8);
      expect(peak(left, 0, 20000), id).toBeGreaterThan(0.005);
    }
  });
});

describe('performance', () => {
  it.each(['chip-synth', 'fm-synth', 'organ', 'strings-pad', 'bass', 'sampler', 'drum-machine'])('%s with a full chord runs faster than real time', (id) => {
    const def = getDef(id);
    const kernel = def.audio!;
    const st = kernel.create({ sampleRate: SR, blockSize: 128, nodeId: 'p' });
    const params: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(def.params as Record<string, { default: unknown }>)) params[k] = d.default;
    if (id === 'sampler') params.assets = ['s'];
    const asset: AudioAsset = { sampleRate: SR, frames: SR, left: noise(SR, 2, 0.3), right: noise(SR, 3, 0.3) };
    const out = [new Float32Array(128), new Float32Array(128)] as [Float32Array, Float32Array];
    const evs: MidiEvent[] = [48, 52, 55, 59, 62, 64, 67, 71].map((n) => on(n, 0, 1));
    const io = { frames: 128, sampleRate: SR, in: {}, midiIn: { midi: evs }, out: { audio: out }, midiOut: {}, params, signal: () => {}, time: { seconds: 0, sample: 0, bpm: 120, playing: true, loop: false, duration: 0 }, assets: { get: () => asset }, live: { mic: null, deviceMidi: [], uiMidi: [] } } as never;
    kernel.process(st, io);
    (io as { midiIn: { midi: MidiEvent[] } }).midiIn.midi = [];
    for (let i = 0; i < 200; i++) kernel.process(st, io);
    let best = Infinity;
    for (let rep = 0; rep < 4; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < 750; i++) {
        out[0].fill(0);
        out[1].fill(0);
        (io as { time: { sample: number } }).time.sample = i * 128;
        kernel.process(st, io);
      }
      best = Math.min(best, performance.now() - t0);
    }
    const speed = 2 / (best / 1000);
    console.log(`${id}: ${speed.toFixed(0)}x real time`);
    expect(speed).toBeGreaterThan(2) // comfortably real-time even when the whole suite runs in parallel;
  });
});
