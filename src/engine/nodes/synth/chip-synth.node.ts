import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { dbToLin, fz, midiToHz } from '../../audio/dsp';
import { allIdle, fastSin, handleController, makeVoices, newPresetCache, pickVoice, presetOptions, presetView, releaseNote } from '../../audio/instrument';

const MAXV = 8;
const CTRL = 32; // pitch (vibrato, slide, arpeggio) is updated every 32 samples

const ARPS: Record<string, number[]> = {
  off: [0],
  octave: [0, 12],
  major: [0, 4, 7],
  minor: [0, 3, 7],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  power: [0, 7, 12],
  'major-up': [0, 4, 7, 12, 7, 4],
};

const PRESETS: Record<string, Record<string, unknown>> = {
  'nes-lead': { wave: 'pulse25', dutySweep: 0, arp: 'off', vibratoDepth: 22, vibratoRate: 5.5, vibratoDelay: 0.15, slideSemitones: 0, attack: 0, decay: 0.6, sustain: 11, release: 0.08, steps: true, crush: 'off', transpose: 0 },
  'gb-pulse': { wave: 'pulse50', dutySweep: 0, arp: 'off', vibratoDepth: 0, vibratoRate: 5, vibratoDelay: 0, slideSemitones: 0, attack: 0, decay: 0.25, sustain: 9, release: 0.06, steps: true, crush: 'off', transpose: 0 },
  'c64-arp': { wave: 'pulse50', dutySweep: 1.5, arp: 'major-up', arpRate: 50, vibratoDepth: 0, vibratoRate: 5, vibratoDelay: 0, slideSemitones: 0, attack: 0, decay: 0.2, sustain: 12, release: 0.1, steps: true, crush: 'off', transpose: 0 },
  'tri-bass': { wave: 'triangle', dutySweep: 0, arp: 'off', vibratoDepth: 0, vibratoRate: 5, vibratoDelay: 0, slideSemitones: 0, attack: 0, decay: 0, sustain: 15, release: 0.04, steps: true, crush: 'off', transpose: -12 },
  'noise-hat': { wave: 'noise-short', dutySweep: 0, arp: 'off', vibratoDepth: 0, vibratoRate: 5, vibratoDelay: 0, slideSemitones: 0, attack: 0, decay: 0.07, sustain: 0, release: 0.02, steps: true, crush: 'off', transpose: 24 },
  'noise-snare': { wave: 'noise-long', dutySweep: 0, arp: 'off', vibratoDepth: 0, vibratoRate: 5, vibratoDelay: 0, slideSemitones: 7, slideTime: 0.12, attack: 0, decay: 0.2, sustain: 0, release: 0.03, steps: true, crush: 'off', transpose: 12 },
};

/** Chiptune voice: NES/Game Boy style pulse (12.5/25/50/75 %), stepped triangle, LFSR noise, 16-step volume, arpeggio. */
export default defineNode({
  id: 'chip-synth',
  title: 'Chiptune',
  category: 'synth',
  description: 'Retro game-console sounds: square waves with different widths, a stepped triangle, noise, fast arpeggios and 16-step volume. The sound of pixel art.',
  keywords: ['8-bit', 'nes', 'game boy', 'c64', 'retro', 'square', 'pulse', 'noise', 'arcade', 'pixel', 'chip', 'lfsr'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    preset: { type: 'enum', default: 'nes-lead', label: 'Sound', options: presetOptions({ 'nes-lead': 'NES lead', 'gb-pulse': 'Game Boy pulse', 'c64-arp': 'C64-ish arpeggio', 'tri-bass': 'Triangle bass', 'noise-hat': 'Noise hi-hat', 'noise-snare': 'Noise snare' }) },
    wave: {
      type: 'enum',
      default: 'pulse25',
      label: 'Wave',
      group: 'Sound',
      options: [
        { value: 'pulse12', label: 'Pulse 12.5%' },
        { value: 'pulse25', label: 'Pulse 25%' },
        { value: 'pulse50', label: 'Pulse 50% (square)' },
        { value: 'pulse75', label: 'Pulse 75%' },
        { value: 'triangle', label: 'Triangle (4-bit steps)' },
        { value: 'noise-long', label: 'Noise (long)' },
        { value: 'noise-short', label: 'Noise (short, metallic)' },
      ],
    },
    dutySweep: { type: 'number', default: 0, min: 0, max: 10, step: 0.1, unit: 'hz', label: 'Pulse width sweep', group: 'Sound', hint: 'Sweeps the pulse width between 12.5% and 50%. 0 = fixed.' },
    arp: { type: 'enum', default: 'off', label: 'Arpeggio', group: 'Movement', options: Object.keys(ARPS).map((k) => ({ value: k, label: k === 'off' ? 'Off' : k })) },
    arpRate: { type: 'number', default: 30, min: 4, max: 100, step: 1, unit: 'hz', label: 'Arpeggio speed', group: 'Movement', visibleIf: (p) => p.arp !== 'off' },
    vibratoDepth: { type: 'number', default: 0, min: 0, max: 100, step: 1, label: 'Vibrato (cents)', group: 'Movement' },
    vibratoRate: { type: 'number', default: 5.5, min: 0.5, max: 12, step: 0.1, unit: 'hz', label: 'Vibrato speed', group: 'Movement' },
    vibratoDelay: { type: 'number', default: 0, min: 0, max: 2, step: 0.01, unit: 's', label: 'Vibrato delay', group: 'Movement' },
    slideSemitones: { type: 'number', default: 0, min: -24, max: 24, step: 1, unit: 'st', label: 'Pitch slide at the start', group: 'Movement', hint: 'Each note starts this many semitones away and slides to its pitch.' },
    slideTime: { type: 'number', default: 0.1, min: 0.005, max: 1, step: 0.005, unit: 's', label: 'Slide time', group: 'Movement' },
    attack: { type: 'number', default: 0, min: 0, max: 500, step: 1, label: 'Fade in (ms)', group: 'Volume' },
    decay: { type: 'number', default: 0.3, min: 0, max: 3, step: 0.01, unit: 's', label: 'Fade down (s, 0 = none)', group: 'Volume' },
    sustain: { type: 'number', default: 12, min: 0, max: 15, step: 1, integer: true, label: 'Hold level (0-15)', group: 'Volume' },
    release: { type: 'number', default: 0.06, min: 0.001, max: 3, step: 0.001, unit: 's', label: 'Fade out', group: 'Volume' },
    steps: { type: 'bool', default: true, label: '16-step volume', group: 'Volume' },
    crush: {
      type: 'enum',
      default: 'off',
      label: 'Grit (DPCM-style crush)',
      group: 'Sound',
      options: [
        { value: 'off', label: 'Off' },
        { value: '4', label: '4-bit' },
        { value: '3', label: '3-bit' },
        { value: '2', label: '2-bit' },
      ],
    },
    transpose: { type: 'number', default: 0, min: -36, max: 36, step: 1, integer: true, unit: 'st', label: 'Transpose', group: 'Sound' },
    voices: { type: 'number', default: 4, min: 1, max: MAXV, softMax: 6, step: 1, integer: true, label: 'Notes at once', group: 'Sound' },
    gain: { type: 'number', default: -9, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Sound' },
  },
  summary: (p) => (p.preset !== 'custom' ? String(p.preset) : `${p.wave}${p.arp !== 'off' ? ' · arp ' + p.arp : ''}`),
  audio: defineAudio({
    create: () => ({
      v: makeVoices(MAXV),
      phase: new Float64Array(MAXV),
      age: new Float64Array(MAXV),
      lfsr: new Uint16Array(MAXV).fill(1),
      nAcc: new Float64Array(MAXV),
      nOut: new Float64Array(MAXV).fill(1),
      ratio: new Float64Array(MAXV).fill(1),
      duties: new Float64Array(MAXV).fill(0.5),
      ctrl: new Int32Array(MAXV),
      presets: newPresetCache(),
    }),
    process(st, io) {
      const p0 = io.params;
      const p = presetView(st.presets, p0, PRESETS);
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
            v.vel[i] = Math.max(0.1, ev.velocity);
            st.age[i] = 0;
            st.phase[i] = 0;
            st.lfsr[i] = 1;
            st.nAcc[i] = 0;
            st.ctrl[i] = 0;
            st.duties[i] = DUTY[p.wave] ?? 0.5;
            if (v.fresh) v.env[i] = 0;
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

const DUTY = { pulse12: 0.125, pulse25: 0.25, pulse50: 0.5, pulse75: 0.75 } as Record<string, number>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  const v = st.v;
  const gain = dbToLin(p.gain) * 0.6;
  const sustain = p.sustain / 15;
  const atkInc = p.attack <= 0 ? 1 : 1 / Math.max(1, (p.attack / 1000) * sr);
  const decInc = p.decay <= 0 ? 0 : (1 - sustain) / Math.max(1, p.decay * sr);
  const relInc = 1 / Math.max(1, p.release * sr);
  const arp: number[] = ARPS[p.arp] ?? ARPS.off;
  const wave = p.wave as string;
  const isNoise = wave.startsWith('noise');
  const shortMode = wave === 'noise-short';
  const baseDuty = DUTY[wave] ?? 0.5;
  const crush = p.crush === 'off' ? 0 : Math.pow(2, Number(p.crush)) - 1;
  const stepped = p.steps as boolean;
  for (let i = 0; i < v.n; i++) {
    if (v.stage[i] === 0) continue;
    let env = v.env[i];
    let stage = v.stage[i];
    let phase = st.phase[i];
    let age = st.age[i];
    let ctrl = st.ctrl[i];
    let ratio = st.ratio[i];
    let duty = st.duties[i];
    const vel = v.vel[i];
    for (let k = s0; k < s1; k++) {
      // volume envelope: linear like the hardware
      if (stage === 1) {
        env += atkInc;
        if (env >= 1) {
          env = 1;
          stage = 2;
        }
      } else if (stage === 2) {
        if (env > sustain) env = Math.max(sustain, env - decInc);
        else env = sustain;
      } else if (stage === 3) {
        env -= relInc;
        if (env <= 0) {
          env = 0;
          stage = 0;
          break;
        }
      }
      if (ctrl === 0) {
        ctrl = CTRL;
        let semis = v.note[i] + p.transpose;
        if (arp.length > 1) semis += arp[Math.floor(age * p.arpRate) % arp.length];
        const slideLeft = p.slideSemitones !== 0 ? Math.max(0, 1 - age / p.slideTime) : 0;
        semis += p.slideSemitones * slideLeft;
        let cents = 0;
        if (p.vibratoDepth > 0 && age > p.vibratoDelay) cents = p.vibratoDepth * fastSin((age - p.vibratoDelay) * p.vibratoRate);
        ratio = midiToHz(semis + cents / 100);
        st.ratio[i] = ratio;
        duty = baseDuty;
        if (p.dutySweep > 0 && !isNoise && wave !== 'triangle') duty = 0.125 + 0.375 * (0.5 + 0.5 * fastSin(age * p.dutySweep));
        st.duties[i] = duty;
      } else duty = st.duties[i];
      ctrl--;
      const dt = ratio / sr;
      let x: number;
      if (isNoise) {
        st.nAcc[i] += Math.min(0.5, (ratio * 8) / sr);
        while (st.nAcc[i] >= 1) {
          st.nAcc[i] -= 1;
          const l = st.lfsr[i];
          const bit = (l ^ (l >> (shortMode ? 6 : 1))) & 1;
          st.lfsr[i] = (l >> 1) | (bit << 14);
          st.nOut[i] = st.lfsr[i] & 1 ? -1 : 1;
        }
        x = st.nOut[i];
      } else if (wave === 'triangle') {
        const q = Math.floor(phase * 32) / 32;
        const tri = 1 - 4 * Math.abs(q - 0.5) * 1; // -1..1
        x = Math.round((tri * 0.5 + 0.5) * 15) / 15 * 2 - 1;
      } else x = phase < duty ? 1 : -1;
      phase += dt;
      if (phase >= 1) phase -= 1;
      if (crush > 0) x = Math.round((x * 0.5 + 0.5) * crush) / crush * 2 - 1;
      const level = stepped ? Math.round(env * 15) / 15 : env;
      const o = x * level * vel * gain;
      ol[k] += o;
      or[k] += o;
      age += 1 / sr;
    }
    v.env[i] = env;
    v.stage[i] = stage;
    st.phase[i] = fz(phase);
    st.age[i] = age;
    st.ctrl[i] = ctrl;
    if (stage === 0) v.note[i] = -1;
  }
}
