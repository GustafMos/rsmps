import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { dbToLin, fz, midiToHz } from '../../audio/dsp';
import { allIdle, expCoef, fastSin, handleController, makeVoices, newPresetCache, pickVoice, presetOptions, presetView, releaseNote } from '../../audio/instrument';

const MAXV = 12;

/** Modulation routing: [target, source] pairs (source index > target index), and which operators reach the output. */
const ALGS: Record<string, { mods: [number, number][]; carriers: number[]; label: string }> = {
  serial: { mods: [[0, 1], [1, 2], [2, 3]], carriers: [0], label: '4 > 3 > 2 > 1' },
  twin: { mods: [[0, 1], [2, 3]], carriers: [0, 2], label: '2>1 + 4>3' },
  fork: { mods: [[0, 1], [0, 2], [0, 3]], carriers: [0], label: '2, 3, 4 > 1' },
  'chain-plus': { mods: [[0, 1], [1, 2]], carriers: [0, 3], label: '3>2>1 + 4' },
  parallel: { mods: [], carriers: [0, 1, 2, 3], label: 'Side by side' },
  y: { mods: [[0, 1], [1, 2], [1, 3]], carriers: [0], label: '3+4 > 2 > 1' },
};
const ALG_KEYS = Object.keys(ALGS);

type Op = [ratio: number, level: number, attackMs: number, decay: number, sustain: number, release: number];
const bundle = (alg: string, fb: number, ops: [Op, Op, Op, Op]): Record<string, unknown> => {
  const o: Record<string, unknown> = { algorithm: alg, feedback: fb };
  ops.forEach((op, i) => {
    const n = i + 1;
    [o[`ratio${n}`], o[`level${n}`], o[`attack${n}`], o[`decay${n}`], o[`sustain${n}`], o[`release${n}`]] = op;
  });
  return o;
};

const PRESETS: Record<string, Record<string, unknown>> = {
  epiano: bundle('twin', 0, [[1, 0.85, 1, 1.8, 0.15, 0.35], [14, 0.22, 1, 0.12, 0, 0.1], [1, 0.55, 1, 2.5, 0.1, 0.4], [1, 0.32, 1, 0.9, 0.05, 0.3]]),
  bell: bundle('twin', 0, [[1, 0.8, 1, 4, 0, 2.5], [3.5, 0.5, 1, 2.5, 0, 1.5], [2.41, 0.4, 1, 3, 0, 2], [5.4, 0.28, 1, 1, 0, 1]]),
  'fm-bass': bundle('serial', 0.35, [[1, 1, 1, 0.5, 0.75, 0.1], [1, 0.55, 1, 0.18, 0.15, 0.08], [2, 0.25, 1, 0.1, 0, 0.05], [1, 0.2, 1, 0.1, 0.3, 0.05]]),
  brass: bundle('serial', 0.25, [[1, 0.95, 35, 0.3, 0.85, 0.15], [1, 0.5, 70, 0.4, 0.55, 0.15], [1, 0.12, 20, 0.2, 0.3, 0.1], [1, 0.1, 20, 0.2, 0.3, 0.1]]),
  'glass-pad': bundle('twin', 0, [[1, 0.7, 700, 1, 0.85, 1.4], [3, 0.14, 900, 1, 0.5, 1.2], [2, 0.4, 800, 1, 0.8, 1.4], [5, 0.09, 1000, 1, 0.4, 1.2]]),
};

const opParams: Record<string, import('../../types').ParamDef> = {};
for (let n = 1; n <= 4; n++) {
  const g = `Operator ${n}`;
  const d = PRESETS.epiano;
  opParams[`ratio${n}`] = { type: 'number', default: d[`ratio${n}`] as number, min: 0.25, max: 16, step: 0.01, label: 'Pitch ratio', group: g };
  opParams[`level${n}`] = { type: 'number', default: d[`level${n}`] as number, min: 0, max: 1, step: 0.01, label: 'Level', hint: n <= 1 ? 'Output level.' : 'Strength of modulation.', group: g };
  opParams[`attack${n}`] = { type: 'number', default: d[`attack${n}`] as number, min: 0, max: 3000, step: 1, label: 'Attack ms', group: g };
  opParams[`decay${n}`] = { type: 'number', default: d[`decay${n}`] as number, min: 0.01, max: 10, step: 0.01, unit: 's', label: 'Decay', group: g };
  opParams[`sustain${n}`] = { type: 'number', default: d[`sustain${n}`] as number, min: 0, max: 1, step: 0.01, label: 'Sustain', group: g };
  opParams[`release${n}`] = { type: 'number', default: d[`release${n}`] as number, min: 0.01, max: 10, step: 0.01, unit: 's', label: 'Release', group: g };
}

/** Four-operator FM synthesiser with six algorithms and per-operator envelopes. */
export default defineNode({
  id: 'fm-synth',
  title: 'FM Synth',
  category: 'synth',
  description: 'Frequency-modulation synthesiser: bells, electric pianos, bass, brass and glassy pads from four sine operators.',
  keywords: ['dx7', 'fm', 'operator', 'electric piano', 'bell', 'brass', 'glass', 'pad', 'bass', 'yamaha'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    preset: { type: 'enum', default: 'epiano', label: 'Sound', options: presetOptions({ epiano: 'Electric piano', bell: 'Bell', 'fm-bass': 'FM bass', brass: 'Brass', 'glass-pad': 'Glass pad' }) },
    algorithm: { type: 'enum', default: 'twin', label: 'Algorithm', options: ALG_KEYS.map((k) => ({ value: k, label: ALGS[k].label })) },
    feedback: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Op 4 feedback' },
    ...opParams,
    velocity: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Velocity', group: 'Playing' },
    voices: { type: 'number', default: 8, min: 1, max: MAXV, softMax: 8, step: 1, integer: true, label: 'Notes at once', group: 'Playing' },
    gain: { type: 'number', default: -10, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Playing' },
  },
  summary: (p) => (p.preset !== 'custom' ? String(p.preset) : `algorithm ${p.algorithm}`),
  audio: defineAudio({
    create: () => ({
      v: makeVoices(MAXV),
      phase: new Float64Array(MAXV * 4),
      env: new Float64Array(MAXV * 4),
      fbPrev: new Float64Array(MAXV),
      attacking: new Uint8Array(MAXV * 4),
      freq: new Float64Array(MAXV),
      presets: newPresetCache(),
    }),
    process(st, io) {
      const p = presetView(st.presets, io.params, PRESETS);
      const n = io.frames;
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
            v.vel[i] = 1 - p.velocity + p.velocity * ev.velocity;
            st.freq[i] = midiToHz(ev.note);
            for (let o = 0; o < 4; o++) {
              st.phase[i * 4 + o] = 0;
              st.attacking[i * 4 + o] = 1;
              if (v.fresh) st.env[i * 4 + o] = 0;
            }
            st.fbPrev[i] = 0;
          } else if (ev.type === 'off') releaseNote(v, ev.note);
          else handleController(v, ev);
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        render(st, p, io.sampleRate, ol, or, cursor, end);
        cursor = end;
      }
    },
    reset(st) {
      allIdle(st.v);
      st.env.fill(0);
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  const v = st.v;
  const alg = ALGS[p.algorithm] ?? ALGS.twin;
  const ratio = [p.ratio1, p.ratio2, p.ratio3, p.ratio4];
  const level = [p.level1, p.level2, p.level3, p.level4];
  const atk: number[] = [];
  const dec: number[] = [];
  const sus: number[] = [];
  const rel: number[] = [];
  for (let o = 1; o <= 4; o++) {
    atk.push(p[`attack${o}`] <= 0 ? 1 : 1 / Math.max(1, (p[`attack${o}`] / 1000) * sr));
    dec.push(expCoef(p[`decay${o}`], sr));
    sus.push(p[`sustain${o}`]);
    rel.push(expCoef(p[`release${o}`], sr));
  }
  const gain = dbToLin(p.gain) / Math.sqrt(alg.carriers.length);
  const fb = p.feedback * 0.5;
  const out = [0, 0, 0, 0];
  const amp = [0, 0, 0, 0];
  for (let i = 0; i < v.n; i++) {
    if (v.stage[i] === 0) continue;
    const f = st.freq[i];
    const releasing = v.stage[i] === 3;
    const vel = v.vel[i];
    let alive = false;
    for (let k = s0; k < s1; k++) {
      // per-operator envelopes follow the key (attack, decay to sustain) and the release
      for (let o = 0; o < 4; o++) {
        const ix = i * 4 + o;
        let e = st.env[ix];
        if (v.stage[i] === 3) e -= e * rel[o];
        else if (st.attacking[ix]) {
          e += atk[o];
          if (e >= 1) {
            e = 1;
            st.attacking[ix] = 0;
          }
        } else e += (sus[o] - e) * dec[o];
        st.env[ix] = e;
        amp[o] = e * level[o];
      }
      // operators from 4 down to 1
      for (let o = 3; o >= 0; o--) {
        let m = 0;
        for (const [t, s] of alg.mods) if (t === o) m += out[s];
        if (o === 3) m += fb * st.fbPrev[i];
        const ix = i * 4 + o;
        const ph = st.phase[ix];
        out[o] = fastSin(ph + m) * amp[o];
        let np = ph + (f * ratio[o]) / sr;
        if (np >= 1) np -= Math.floor(np);
        st.phase[ix] = np;
      }
      st.fbPrev[i] = out[3];
      let y = 0;
      for (const c of alg.carriers) y += out[c];
      y *= gain * vel;
      ol[k] += y;
      or[k] += y;
    }
    // voice is done when it is releasing and every operator has faded out
    if (releasing || v.stage[i] === 3) {
      for (let o = 0; o < 4; o++) if (st.env[i * 4 + o] > 1e-4) alive = true;
      if (!alive) {
        v.stage[i] = 0;
        v.note[i] = -1;
        for (let o = 0; o < 4; o++) st.env[i * 4 + o] = fz(0);
      }
    }
    v.env[i] = Math.max(st.env[i * 4], st.env[i * 4 + 2]);
  }
}
