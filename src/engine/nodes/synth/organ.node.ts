import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { TAU, dbToLin, midiToHz } from '../../audio/dsp';
import { allIdle, expCoef, fastSin, handleController, makeVoices, newPresetCache, pickVoice, presetOptions, presetView, releaseNote } from '../../audio/instrument';

const MAXV = 12;
/** Drawbar footages 16', 5 1/3', 8', 4', 2 2/3', 2', 1 3/5', 1 1/3', 1' as frequency ratios. */
const RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
const LABELS = ["16'", "5 1/3'", "8'", "4'", "2 2/3'", "2'", "1 3/5'", "1 1/3'", "1'"];

const bars = (s: string): Record<string, unknown> => Object.fromEntries([...s].map((c, i) => [`drawbar${i + 1}`, Number(c)]));
const PRESETS: Record<string, Record<string, unknown>> = {
  jazz: { ...bars('888000000'), percussion: 'third', percussionDecay: 'fast', rotary: 'slow', click: 0.3 },
  rock: { ...bars('888888000'), percussion: 'off', percussionDecay: 'fast', rotary: 'fast', click: 0.4 },
  church: { ...bars('808800808'), percussion: 'off', percussionDecay: 'fast', rotary: 'vibrato', click: 0.1 },
  ballad: { ...bars('808000000'), percussion: 'second', percussionDecay: 'slow', rotary: 'slow', click: 0.15 },
};

const drawbarParams: Record<string, import('../../types').ParamDef> = {};
RATIOS.forEach((_, i) => {
  drawbarParams[`drawbar${i + 1}`] = { type: 'number', default: PRESETS.jazz[`drawbar${i + 1}`] as number, min: 0, max: 8, step: 1, integer: true, label: LABELS[i], group: 'Drawbars' };
});

/** Drawbar organ: nine harmonic sliders, key percussion, key click and a rotary-speaker style swirl. */
export default defineNode({
  id: 'organ',
  title: 'Organ',
  category: 'synth',
  description: 'A drawbar organ with percussion and a rotating-speaker effect. Pull the drawbars out for a richer sound.',
  keywords: ['hammond', 'b3', 'drawbar', 'church', 'leslie', 'rotary', 'keys', 'additive', 'gospel'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    preset: { type: 'enum', default: 'jazz', label: 'Sound', options: presetOptions({ jazz: 'Jazz', rock: 'Rock', church: 'Church', ballad: 'Ballad' }) },
    ...drawbarParams,
    percussion: {
      type: 'enum',
      default: 'off',
      label: 'Percussion',
      group: 'Character',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'second', label: '2nd harmonic' },
        { value: 'third', label: '3rd harmonic' },
      ],
    },
    percussionDecay: { type: 'enum', default: 'fast', label: 'Percussion decay', group: 'Character', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }], visibleIf: (p) => p.percussion !== 'off' },
    click: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Key click', group: 'Character' },
    rotary: {
      type: 'enum',
      default: 'slow',
      label: 'Rotary speaker',
      group: 'Character',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'vibrato', label: 'Vibrato' },
        { value: 'slow', label: 'Slow swirl' },
        { value: 'fast', label: 'Fast swirl' },
      ],
    },
    voices: { type: 'number', default: 10, min: 1, max: MAXV, softMax: 10, step: 1, integer: true, label: 'Notes at once', group: 'Character' },
    gain: { type: 'number', default: -10, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Character' },
  },
  summary: (p) => (p.preset !== 'custom' ? String(p.preset) : 'custom drawbars'),
  audio: defineAudio({
    create: () => ({
      v: makeVoices(MAXV),
      phase: new Float64Array(MAXV * 9),
      perc: new Float64Array(MAXV),
      percPhase: new Float64Array(MAXV),
      click: new Float64Array(MAXV),
      noise: 1,
      lfo: 0,
      speed: 0.8,
      presets: newPresetCache(),
      freq: new Float64Array(MAXV),
    }),
    process(st, io) {
      const p = presetView(st.presets, io.params, PRESETS);
      const n = io.frames;
      const sr = io.sampleRate;
      const [ol, or] = io.out.audio;
      const events: MidiEvent[] = io.midiIn.midi;
      const v = st.v;
      let ei = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) {
          const ev = events[ei++];
          if (ev.type === 'on') {
            const i = pickVoice(v, ev.note, p.voices);
            v.vel[i] = 0.7 + 0.3 * ev.velocity; // organs hardly respond to velocity
            st.freq[i] = midiToHz(ev.note);
            st.perc[i] = 1;
            st.click[i] = 1;
            if (v.fresh) for (let k = 0; k < 9; k++) st.phase[i * 9 + k] = 0;
          } else if (ev.type === 'off') releaseNote(v, ev.note);
          else handleController(v, ev);
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        render(st, p, sr, ol, or, cursor, end);
        cursor = end;
      }
    },
    reset(st) {
      allIdle(st.v);
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  const v = st.v;
  const gain = dbToLin(p.gain) * 0.09;
  const atk = 1 / (0.004 * sr);
  const relC = expCoef(0.03, sr);
  const lv: number[] = [];
  let total = 0;
  for (let k = 0; k < 9; k++) {
    const l = p[`drawbar${k + 1}`] / 8;
    lv.push(l * l); // perceptual taper
    total += l * l;
  }
  const norm = total > 0 ? 1 / Math.sqrt(total) : 0;
  const percRatio = p.percussion === 'second' ? 2 : 3;
  const percC = expCoef(p.percussionDecay === 'slow' ? 0.5 : 0.13, sr);
  const rotary = p.rotary as string;
  const targetSpeed = rotary === 'fast' ? 6.7 : rotary === 'slow' ? 0.8 : rotary === 'vibrato' ? 6.1 : 0;
  const speedC = 1 - Math.exp(-1 / (1.2 * sr));
  const pitchDepth = rotary === 'vibrato' ? 0.0035 : rotary === 'off' ? 0 : 0.0012;
  const ampDepth = rotary === 'slow' || rotary === 'fast' ? 0.25 : 0;
  const panDepth = rotary === 'slow' || rotary === 'fast' ? 0.45 : 0;
  const clickAmt = p.click as number;
  // the global rotating-speaker LFO, advanced once per sample below; compute it per sample into a small table
  for (let k = s0; k < s1; k++) {
    st.speed += (targetSpeed - st.speed) * speedC;
    st.lfo += st.speed / sr;
    if (st.lfo >= 1) st.lfo -= 1;
    const l = fastSin(st.lfo);
    const pitch = 1 + pitchDepth * l;
    const am = 1 - ampDepth * (0.5 + 0.5 * fastSin(st.lfo + 0.25));
    const pan = 0.5 + panDepth * 0.5 * l;
    let mix = 0;
    for (let i = 0; i < v.n; i++) {
      if (v.stage[i] === 0) continue;
      // amplitude: quick attack, release
      let e = v.env[i];
      if (v.stage[i] === 1) {
        e += atk;
        if (e >= 1) {
          e = 1;
          v.stage[i] = 2;
        }
      } else if (v.stage[i] === 3) {
        e -= e * relC;
        if (e < 1e-4) {
          e = 0;
          v.stage[i] = 0;
          v.note[i] = -1;
        }
      }
      v.env[i] = e;
      const dt = (st.freq[i] * pitch) / sr;
      let y = 0;
      for (let b = 0; b < 9; b++) {
        const ix = i * 9 + b;
        let ph = st.phase[ix] + dt * RATIOS[b];
        ph -= Math.floor(ph);
        st.phase[ix] = ph;
        if (lv[b] > 0) y += fastSin(ph) * lv[b];
      }
      y *= norm;
      if (p.percussion !== 'off') {
        st.perc[i] -= st.perc[i] * percC;
        let pp = st.percPhase[i] + dt * percRatio;
        pp -= Math.floor(pp);
        st.percPhase[i] = pp;
        y += fastSin(pp) * st.perc[i] * 1.6;
      }
      if (st.click[i] > 0.001) {
        st.noise = (Math.imul(st.noise, 1664525) + 1013904223) | 0; // fixed-sequence noise: deterministic
        y += ((st.noise >> 8) / 8388608) * st.click[i] * clickAmt * 0.6;
        st.click[i] *= 0.985;
      }
      mix += y * e * v.vel[i];
    }
    const o = mix * gain * am;
    ol[k] += o * (1 - pan) * 1.4;
    or[k] += o * pan * 1.4;
  }
  void TAU;
}
