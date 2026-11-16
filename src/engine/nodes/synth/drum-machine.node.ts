import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { TAU, dbToLin, midiToHz } from '../../audio/dsp';
import { DRUM_LABELS, DRUM_VOICES, defaultPattern, normalizePattern, type DrumPattern, type DrumVoice } from '../../audio/drum-pattern';

const SLOTS = 24;
/** General-MIDI style note map. */
const NOTE_MAP: Record<number, DrumVoice> = { 35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap', 42: 'chat', 44: 'chat', 46: 'ohat', 56: 'cowbell' };
for (const n of [41, 43, 45, 47, 48, 50]) NOTE_MAP[n] = 'tom';
const VOICE_INDEX: Record<DrumVoice, number> = { kick: 0, snare: 1, clap: 2, chat: 3, ohat: 4, tom: 5, rim: 6, cowbell: 7 };
/** Decay (seconds) of each voice at decay 1x. */
const BASE_DECAY = [0.4, 0.22, 0.2, 0.05, 0.32, 0.3, 0.04, 0.3];
/** Metallic hat partials. */
const METAL = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];

const voiceParams: Record<string, import('../../types').ParamDef> = {};
for (const v of DRUM_VOICES) {
  voiceParams[`${v}Tune`] = { type: 'number', default: 0, min: -12, max: 12, step: 0.1, unit: 'st', label: 'Tune', group: DRUM_LABELS[v] };
  voiceParams[`${v}Decay`] = { type: 'number', default: 1, min: 0.2, max: 4, step: 0.01, label: 'Decay', group: DRUM_LABELS[v] };
  voiceParams[`${v}Level`] = { type: 'number', default: 0, min: -30, max: 6, step: 0.1, unit: 'db', label: 'Level', group: DRUM_LABELS[v] };
}

/**
 * Drum machine: eight synthesised drums (kick, snare, clap, closed/open hat, tom, rim shot, cowbell), played from MIDI notes
 * (General MIDI numbers) and/or by a built-in 16/32-step sequencer. Pattern editing helpers: src/engine/audio/drum-pattern.ts.
 * Sequencer timing follows the transport: "fit to project" stretches the pattern over the project length so it loops exactly.
 */
export default defineNode({
  id: 'drum-machine',
  title: 'Drum Machine',
  category: 'synth',
  description: 'A full little drum kit with a step sequencer. Play it from MIDI notes, or draw a beat in the pattern and press play.',
  keywords: ['beat', 'drums', 'sequencer', 'step', 'kick', 'snare', 'clap', 'hihat', 'tom', 'rimshot', 'cowbell', '808', 'groove', 'pattern'],
  inputs: { midi: { type: 'midi', label: 'MIDI (optional)' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    sequencer: { type: 'bool', default: true, label: 'Play the pattern', group: 'Sequencer' },
    pattern: { type: 'json', default: defaultPattern(), label: 'Pattern', group: 'Sequencer' },
    sync: {
      type: 'enum',
      default: 'tempo',
      label: 'Timing',
      group: 'Sequencer',
      options: [
        { value: 'tempo', label: 'Tempo BPM' },
        { value: 'project', label: 'Fit to project' },
      ],
    },
    bpm: { type: 'number', default: 120, min: 30, max: 300, step: 0.1, label: 'Tempo BPM', group: 'Sequencer', visibleIf: (p) => p.sync === 'tempo' },
    ...voiceParams,
    gain: { type: 'number', default: -6, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Kit' },
  },
  summary: (p) => (p.sequencer ? `pattern · ${p.sync === 'project' ? 'fit to project' : Math.round(p.bpm as number) + ' bpm'}` : 'MIDI only'),
  audio: defineAudio({
    create: () => ({
      kind: new Int8Array(SLOTS).fill(-1),
      t: new Float64Array(SLOTS), // samples since the hit
      vel: new Float64Array(SLOTS),
      tune: new Float64Array(SLOTS),
      dec: new Float64Array(SLOTS),
      lvl: new Float64Array(SLOTS),
      freq: new Float64Array(SLOTS),
      ph: new Float64Array(SLOTS * 8),
      s1: new Float64Array(SLOTS * 2),
      noise: new Int32Array(SLOTS).fill(1),
      next: 0,
      patRef: null as unknown,
      pat: defaultPattern() as DrumPattern,
      trig: [] as number[],
    }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const [ol, or] = io.out.audio;
      // gather triggers for this block: [offset, voice, velocity, note]
      const trig: number[] = st.trig;
      trig.length = 0;
      for (const ev of io.midiIn.midi) {
        if (ev.type !== 'on') continue;
        const v = NOTE_MAP[ev.note];
        if (v) trig.push(ev.offset, VOICE_INDEX[v], ev.velocity, ev.note);
      }
      if (p.sequencer && io.time.playing) {
        if (st.patRef !== p.pattern) {
          st.patRef = p.pattern;
          st.pat = normalizePattern(p.pattern);
        }
        const pat: DrumPattern = st.pat;
        const stepS = p.sync === 'project' && io.time.duration > 0 ? (io.time.duration * sr) / pat.steps : ((60 / p.bpm) * sr) / 4;
        const period = stepS * pat.steps;
        const sample = io.time.sample;
        const cycle0 = Math.floor(sample / period) * period;
        for (let c = 0; c < 2; c++) {
          for (let k = 0; k < pat.steps; k++) {
            const pos = cycle0 + c * period + (k + (k % 2 === 1 ? pat.swing : 0)) * stepS;
            const at = Math.ceil(pos - 1e-6) - sample;
            if (at < 0 || at >= n) continue;
            for (const voice of DRUM_VOICES) {
              const vel = pat.tracks[voice][k];
              if (vel > 0) trig.push(at, VOICE_INDEX[voice], vel, 45);
            }
          }
        }
      }
      // sort by offset (insertion sort over 4-tuples)
      const count = trig.length / 4;
      for (let i = 1; i < count; i++) {
        const a = trig[i * 4], b = trig[i * 4 + 1], c = trig[i * 4 + 2], d = trig[i * 4 + 3];
        let j = i - 1;
        while (j >= 0 && trig[j * 4] > a) {
          trig[(j + 1) * 4] = trig[j * 4];
          trig[(j + 1) * 4 + 1] = trig[j * 4 + 1];
          trig[(j + 1) * 4 + 2] = trig[j * 4 + 2];
          trig[(j + 1) * 4 + 3] = trig[j * 4 + 3];
          j--;
        }
        trig[(j + 1) * 4] = a;
        trig[(j + 1) * 4 + 1] = b;
        trig[(j + 1) * 4 + 2] = c;
        trig[(j + 1) * 4 + 3] = d;
      }
      let ti = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ti < count && trig[ti * 4] <= cursor) {
          hit(st, p, trig[ti * 4 + 1], trig[ti * 4 + 2], trig[ti * 4 + 3]);
          ti++;
        }
        const end = ti < count ? Math.min(n, Math.max(cursor + 1, trig[ti * 4])) : n;
        render(st, sr, dbToLin(p.gain), ol, or, cursor, end);
        cursor = end;
      }
    },
    reset(st) {
      st.kind.fill(-1);
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hit(st: any, p: any, kind: number, vel: number, note: number): void {
  if (kind === VOICE_INDEX.chat || kind === VOICE_INDEX.ohat) {
    // the hats choke each other
    for (let s = 0; s < SLOTS; s++) if (st.kind[s] === VOICE_INDEX.chat || st.kind[s] === VOICE_INDEX.ohat) st.kind[s] = -1;
  }
  const name = DRUM_VOICES[kind];
  const s = st.next;
  st.next = (s + 1) % SLOTS;
  st.kind[s] = kind;
  st.t[s] = 0;
  st.vel[s] = Math.max(0.05, vel);
  st.tune[s] = Math.pow(2, p[`${name}Tune`] / 12);
  st.dec[s] = BASE_DECAY[kind] * p[`${name}Decay`];
  st.lvl[s] = dbToLin(p[`${name}Level`]);
  st.freq[s] = kind === VOICE_INDEX.tom ? midiToHz(note + 12) : 0;
  for (let i = 0; i < 8; i++) st.ph[s * 8 + i] = 0;
  st.s1[s * 2] = st.s1[s * 2 + 1] = 0;
  st.noise[s] = 1 + s * 7919;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, sr: number, gain: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  for (let s = 0; s < SLOTS; s++) {
    const kind = st.kind[s];
    if (kind < 0) continue;
    const dec = st.dec[s];
    const tune = st.tune[s];
    const o8 = s * 8;
    for (let i = s0; i < s1; i++) {
      const t = st.t[s] / sr;
      st.t[s]++;
      st.noise[s] = (Math.imul(st.noise[s], 1664525) + 1013904223) | 0;
      const nz = (st.noise[s] >> 8) / 8388608;
      let y = 0;
      let alive = t < dec * 1.6;
      switch (kind) {
        case 0: {
          // kick: sine with a fast downward pitch sweep
          const f = 48 * tune * (1 + 3.2 * Math.exp(-t * 38));
          st.ph[o8] += f / sr;
          y = Math.sin(TAU * st.ph[o8]) * Math.exp((-t * 5) / dec) + (t < 0.003 ? nz * 0.3 : 0);
          break;
        }
        case 1: {
          // snare: pitched body plus high-passed noise
          const f = 185 * tune * (1 + 0.7 * Math.exp(-t * 60));
          st.ph[o8] += f / sr;
          const hp = nz - st.s1[s * 2];
          st.s1[s * 2] += hp * 0.25;
          y = Math.sin(TAU * st.ph[o8]) * Math.exp((-t * 7) / dec) * 0.5 + hp * Math.exp((-t * 6) / dec) * 0.75;
          break;
        }
        case 2: {
          // clap: three quick noise bursts then a tail, band-passed
          const burst = t < 0.03 ? ((t * 1000) % 10 < 5 ? 1 : 0.4) : Math.exp((-(t - 0.03) * 6) / dec);
          const lp = st.s1[s * 2] + (nz - st.s1[s * 2]) * 0.4;
          st.s1[s * 2] = lp;
          const hp = lp - st.s1[s * 2 + 1];
          st.s1[s * 2 + 1] += hp * 0.08;
          y = hp * burst * 1.6;
          alive = t < 0.03 + dec * 1.6;
          break;
        }
        case 3:
        case 4: {
          // hats: six inharmonic square waves plus noise, high-passed
          let m = 0;
          for (let k = 0; k < 6; k++) {
            st.ph[o8 + k] += (330 * tune * METAL[k]) / sr;
            if (st.ph[o8 + k] >= 1) st.ph[o8 + k] -= 1;
            m += st.ph[o8 + k] < 0.5 ? 1 : -1;
          }
          const x = m * 0.12 + nz * 0.6;
          const hp = x - st.s1[s * 2];
          st.s1[s * 2] += hp * 0.5;
          y = hp * Math.exp((-t * 6) / dec) * 0.8;
          break;
        }
        case 5: {
          // tom: sine at the note's pitch with a small drop
          const f = st.freq[s] * tune * (1 + 0.4 * Math.exp(-t * 25));
          st.ph[o8] += f / sr;
          y = Math.sin(TAU * st.ph[o8]) * Math.exp((-t * 6) / dec);
          break;
        }
        case 6: {
          // rim shot: short sine click with noise
          st.ph[o8] += (1700 * tune) / sr;
          y = (Math.sin(TAU * st.ph[o8]) * 0.7 + nz * 0.4) * Math.exp((-t * 9) / dec);
          break;
        }
        default: {
          // cowbell: two square-ish partials
          st.ph[o8] += (562 * tune) / sr;
          st.ph[o8 + 1] += (845 * tune) / sr;
          if (st.ph[o8] >= 1) st.ph[o8] -= 1;
          if (st.ph[o8 + 1] >= 1) st.ph[o8 + 1] -= 1;
          y = ((st.ph[o8] < 0.5 ? 1 : -1) + (st.ph[o8 + 1] < 0.5 ? 1 : -1)) * 0.3 * Math.exp((-t * 7) / dec);
        }
      }
      const o = y * st.vel[s] * st.lvl[s] * gain;
      ol[i] += o;
      or[i] += o;
      if (!alive) {
        st.kind[s] = -1;
        break;
      }
    }
  }
}
