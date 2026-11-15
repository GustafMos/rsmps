import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { TAU, dbToLin, makeRng, randBi } from '../../audio/dsp';

const SLOTS = 12;
// General-MIDI-style note ranges.
const KICK = [35, 36];
const SNARE = [37, 38, 39, 40];
const HAT_CLOSED = [42, 44];
const HAT_OPEN = [46];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trigger(st: any, kind: number, vel: number): void {
  if (kind === 2 || kind === 3) for (let s = 0; s < SLOTS; s++) if (st.kind[s] === 2 || st.kind[s] === 3) st.kind[s] = -1; // hats choke each other
  const s = st.next;
  st.next = (st.next + 1) % SLOTS;
  st.kind[s] = kind;
  st.t[s] = 0;
  st.vel[s] = vel;
  st.ph[s] = 0;
  st.hp[s * 2] = st.hp[s * 2 + 1] = 0;
}

/** Three synthesised drums triggered by note ranges: kick (notes 35-36), snare (37-40), hats (42, 44 closed; 46 open). */
export default defineNode({
  id: 'drum',
  title: 'Drum Kit',
  category: 'synth',
  description: 'A tiny drum machine: kick, snare and hi-hats, played by MIDI notes (kick 35-36, snare 37-40, hats 42, 44, 46).',
  keywords: ['percussion', 'beat', 'kick', 'snare', 'hihat', 'hat', '808', 'drums'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    kickPitch: { type: 'number', default: 52, min: 30, max: 120, step: 1, unit: 'hz', label: 'Pitch', group: 'Kick' },
    kickDecay: { type: 'number', default: 0.4, min: 0.1, max: 1.2, step: 0.01, unit: 's', label: 'Length', group: 'Kick' },
    snareTone: { type: 'number', default: 190, min: 100, max: 400, step: 1, unit: 'hz', label: 'Tone', group: 'Snare' },
    snareDecay: { type: 'number', default: 0.2, min: 0.05, max: 0.8, step: 0.01, unit: 's', label: 'Length', group: 'Snare' },
    hatDecay: { type: 'number', default: 0.05, min: 0.01, max: 0.3, step: 0.005, unit: 's', label: 'Closed length', group: 'Hi-hat' },
    openDecay: { type: 'number', default: 0.35, min: 0.1, max: 1.2, step: 0.01, unit: 's', label: 'Open length', group: 'Hi-hat' },
    gain: { type: 'number', default: -6, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume' },
  },
  summary: () => 'kick · snare · hats',
  audio: defineAudio({
    create: (ctx) => ({
      kind: new Int8Array(SLOTS).fill(-1), // 0 kick, 1 snare, 2 closed hat, 3 open hat
      t: new Float64Array(SLOTS),
      vel: new Float64Array(SLOTS),
      ph: new Float64Array(SLOTS),
      hp: new Float64Array(SLOTS * 2),
      next: 0,
      rng: makeRng(ctx.nodeId),
    }),
    process(st, io) {
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const [ol, or] = io.out.audio;
      const gain = dbToLin(p.gain);
      const events = io.midiIn.midi;
      let ei = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) {
          const ev = events[ei++];
          if (ev.type !== 'on') continue;
          if (KICK.includes(ev.note)) trigger(st, 0, ev.velocity);
          else if (SNARE.includes(ev.note)) trigger(st, 1, ev.velocity);
          else if (HAT_CLOSED.includes(ev.note)) trigger(st, 2, ev.velocity);
          else if (HAT_OPEN.includes(ev.note)) trigger(st, 3, ev.velocity);
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        for (let s = 0; s < SLOTS; s++) {
          const kind = st.kind[s];
          if (kind < 0) continue;
          let t = st.t[s];
          let ph = st.ph[s];
          for (let i = cursor; i < end; i++) {
            const sec = t / sr;
            let y = 0;
            let life = 0;
            if (kind === 0) {
              const f = p.kickPitch * (1 + 3.5 * Math.exp(-sec * 45));
              ph += (TAU * f) / sr;
              const env = Math.exp((-sec * 5) / p.kickDecay);
              y = Math.sin(ph) * env + (sec < 0.002 ? randBi(st.rng) * 0.3 : 0);
              life = sec / (p.kickDecay * 1.6);
            } else if (kind === 1) {
              const f = p.snareTone * (1 + 0.8 * Math.exp(-sec * 60));
              ph += (TAU * f) / sr;
              const env = Math.exp((-sec * 6) / p.snareDecay);
              const nz = randBi(st.rng);
              // noise through a crude high-pass
              const hp = nz - st.hp[s * 2];
              st.hp[s * 2] += hp * 0.2;
              y = Math.sin(ph) * env * 0.5 + hp * Math.exp((-sec * 7) / p.snareDecay) * 0.7;
              life = sec / (p.snareDecay * 1.2);
            } else {
              const dec = kind === 2 ? p.hatDecay : p.openDecay;
              const nz = randBi(st.rng);
              const hp = nz - st.hp[s * 2];
              st.hp[s * 2] += hp * 0.55; // strong high-pass
              y = hp * Math.exp((-sec * 6) / dec) * 0.6;
              life = sec / (dec * 1.3);
            }
            const o = y * st.vel[s] * gain;
            ol[i] += o;
            or[i] += o;
            t++;
            if (life > 1) {
              st.kind[s] = -1;
              break;
            }
          }
          st.t[s] = t;
          st.ph[s] = ph;
        }
        cursor = end;
      }
    },
    reset(st) {
      st.kind.fill(-1);
    },
  }),
});
