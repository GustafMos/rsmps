import { describe, expect, it } from 'vitest';
import { validateDef } from '../../define';
import type { ParamDef } from '../../types';
import { biquadBlock, biquadTick, DelayLine, hzToMidi, makeBiquad, midiToHz, polyBlep, setBiquad } from '../dsp';
import { nsdf, pickPeriod } from '../pitch';
import { resolveParams } from '../params';
import { resampleChannel } from '../pcm';
import { snapToScale, stepInScale } from '../scales';
import { SR, audioRegistry, rms, sine, toneAmp } from '../testing';

const EXPECTED = {
  input: ['media-in', 'phone-camera'],
  'audio-source': ['audio-file', 'audio-timeline', 'microphone', 'oscillator'],
  output: ['audio-out'],
  'audio-fx': ['chorus', 'compressor', 'delay', 'distortion', 'eq', 'filter', 'flanger', 'gain', 'gate', 'limiter', 'mixer', 'pitch-shift', 'reverb', 'stereo-width', 'tremolo'],
  math: ['audio-level', 'midi-trigger', 'midi-value'],
  synth: ['arpeggiator', 'audio-to-midi', 'bass', 'chip-synth', 'chord', 'drum', 'drum-machine', 'fm-synth', 'midi-device', 'midi-keyboard', 'midi-transpose', 'organ', 'pluck', 'sampler', 'strings-pad', 'synth'],
} as const;

describe('node definitions', () => {
  const reg = audioRegistry();
  const defs = reg.list();

  it('registers exactly the documented nodes', () => {
    const byCat: Record<string, string[]> = {};
    for (const d of defs) (byCat[d.category] ??= []).push(d.id);
    for (const k of Object.keys(byCat)) byCat[k].sort();
    // every documented node exists (new instruments may be added to a category without touching this list)
    for (const [cat, ids] of Object.entries(EXPECTED)) for (const id of ids) expect(byCat[cat], `${cat}/${id}`).toContain(id);
    expect(Object.keys(byCat).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(defs.map((d) => [d.id, d] as const))('%s is a valid, well-formed audio node', (_id, def) => {
    expect(validateDef(def)).toEqual([]);
    // bridge nodes (category math) also have a frame-domain render that reads Host.signal; everything else is stream-only
    if (def.category === 'math' || def.category === 'input') expect(typeof def.render).toBe('function');
    else expect(def.render).toBeUndefined();
    expect(typeof def.audio!.create).toBe('function');
    expect(typeof def.audio!.process).toBe('function');
    expect(def.description.length).toBeGreaterThan(15);
    for (const i of Object.values(def.inputs as Record<string, { type: string }>)) expect(['audio', 'midi']).toContain(i.type);
    for (const o of Object.values(def.outputs as Record<string, { type: string }>)) expect(def.category === 'math' ? ['number'] : def.category === 'input' ? ['image', 'audio'] : ['audio', 'midi']).toContain(o.type);
    // every param has a plain-English label and sane numeric bounds
    for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
      expect(p.label, `${def.id}.${key} needs a label`).toBeTruthy();
      if (p.type === 'number') {
        if (p.min !== undefined) expect(p.default).toBeGreaterThanOrEqual(p.min);
        if (p.max !== undefined) expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
    // the node body summary works with default params
    const params = resolveParams(def, {});
    const text = def.summary ? def.summary(params) : '';
    expect(typeof text).toBe('string');
    expect(text.includes('NaN') || text.includes('undefined')).toBe(false);
  });

  it('layering inputs accept several wires', () => {
    expect(reg.get('mixer')!.inputs.audio.multi).toBe(true);
    expect(reg.get('audio-out')!.inputs.audio.multi).toBe(true);
  });

  it('audio-file accepts audio assets; microphone has a silent tap', () => {
    expect(reg.get('audio-file')!.params.assets).toMatchObject({ type: 'assets', accept: 'audio' });
    expect(Object.keys(reg.get('microphone')!.outputs)).toEqual(['audio', 'tap']);
  });

  it('resolveParams clamps, defaults and validates enums', () => {
    const def = reg.get('compressor')!;
    const p = resolveParams(def, { threshold: -999, ratio: 'x', detector: 'nonsense', attack: 5 });
    expect(p.threshold).toBe(-60);
    expect(p.ratio).toBe(4);
    expect(p.detector).toBe('rms');
    expect(p.attack).toBe(5);
  });
});

describe('dsp helpers', () => {
  it('midi <-> hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
    expect(hzToMidi(880)).toBeCloseTo(81, 9);
  });
  it('DelayLine reads the right past sample, including fractional delays and wrap-around', () => {
    const d = new DelayLine(10);
    for (let i = 0; i < 100; i++) d.write(i);
    expect(d.read(0)).toBe(99);
    expect(d.read(5)).toBe(94);
    expect(d.read(2.5)).toBeCloseTo(96.5, 6);
    expect(d.readInt(3)).toBe(96);
  });
  it('biquadBlock equals per-sample biquadTick', () => {
    const a = makeBiquad();
    const b = makeBiquad();
    setBiquad(a, 'lowpass', SR, 1200, 0.9);
    setBiquad(b, 'lowpass', SR, 1200, 0.9);
    const x = sine(300, 500, SR, 0.5);
    const y = new Float32Array(500);
    biquadBlock(a, x, y, 500);
    for (let i = 0; i < 500; i++) expect(y[i]).toBeCloseTo(biquadTick(b, x[i]), 5);
  });
  it('polyBlep is zero away from the edge', () => {
    expect(polyBlep(0.5, 0.01)).toBe(0);
    expect(polyBlep(0.001, 0.01)).not.toBe(0);
  });
  it('resampling 44.1k -> 48k keeps frequency and level', () => {
    const y = resampleChannel(sine(1000, 44100, 44100, 0.5), 44100, 48000);
    expect(y.length).toBe(48000);
    expect(toneAmp(y, 1000, 48000, 1000, 40000)).toBeCloseTo(0.5, 2);
    expect(rms(resampleChannel(sine(10000, 96000, 96000, 0.5), 96000, 48000), 1000, 40000)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });
  it('scales: snap and step', () => {
    expect(snapToScale(62.2, 'major', 0)).toBe(62);
    expect(snapToScale(61.4, 'major', 0)).toBe(62);
    expect(snapToScale(61, 'pentatonic-major', 0)).toBe(60);
    expect(snapToScale(60.3, 'off', 0)).toBe(60);
    expect(stepInScale(60, 1, 'major', 0)).toBe(62);
    expect(stepInScale(60, -1, 'major', 0)).toBe(59);
    expect(stepInScale(72, 3, 'minor', 9)).toBe(77);
  });
  it('MPM pitch picker finds the period of a clean tone at fractional lags', () => {
    const fs = 16000;
    for (const f of [110, 220, 440, 880]) {
      const x = sine(f, 1024, fs, 0.5);
      const n = new Float32Array(400);
      nsdf(x, 1024, 300, n);
      const r = pickPeriod(n, 5, 300, 0.93, { lag: 0, clarity: 0 });
      expect(fs / r.lag / f).toBeCloseTo(1, 2);
      expect(r.clarity).toBeGreaterThan(0.95);
    }
  });
});
