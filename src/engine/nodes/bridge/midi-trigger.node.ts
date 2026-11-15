import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

/** Envelope stages. */
const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const RELEASE = 3;

/**
 * Sound-to-picture bridge: every note-on fires an envelope (rise, fall to a sustain level, fall to zero when
 * the keys are released). Wire it to scale, position or brightness for a pulse on each note.
 */
export default defineNode({
  id: 'midi-trigger',
  title: 'Note Pulse',
  category: 'math',
  description: 'Gives a pulse every time a note starts: rises fast, then falls away. Great for bounces and flashes on each beat or note.',
  keywords: ['envelope', 'adsr', 'pulse', 'bounce', 'beat', 'trigger', 'hit', 'flash', 'kick', 'midi', 'audio reactive'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { envelope: { type: 'number', label: 'Pulse' } },
  params: {
    attack: { type: 'number', default: 5, min: 0, max: 2000, step: 1, label: 'Rise (ms)' },
    decay: { type: 'number', default: 250, min: 1, max: 5000, step: 1, label: 'Fall (ms)' },
    sustain: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Level while key held', hint: '0 = a short pulse even if the key stays down' },
    release: { type: 'number', default: 150, min: 1, max: 5000, step: 1, label: 'Fade out after key up (ms)' },
    velocity: { type: 'bool', default: true, label: 'Harder notes give bigger pulses' },
    from: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'From' },
    to: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'To' },
  },
  summary: (p) => `${p.attack}/${p.decay} ms · ${p.from}..${p.to}`,
  audio: defineAudio({
    create: () => ({ stage: IDLE, env: 0, peak: 1, held: 0, notes: new Uint8Array(128) }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const events = io.midiIn.midi;
      const atkInc = p.attack <= 0 ? 1 : 1 / Math.max(1, (p.attack / 1000) * sr);
      const decC = 1 - Math.exp(-4.6 / Math.max(1, (p.decay / 1000) * sr));
      const relC = 1 - Math.exp(-4.6 / Math.max(1, (p.release / 1000) * sr));
      let ei = 0;
      let env: number = st.env;
      let stage: number = st.stage;
      for (let i = 0; i < n; i++) {
        while (ei < events.length && events[ei].offset <= i) {
          const ev = events[ei++];
          if (ev.type === 'on') {
            if (!st.notes[ev.note]) {
              st.notes[ev.note] = 1;
              st.held++;
            }
            st.peak = p.velocity ? Math.max(0.05, ev.velocity) : 1;
            stage = ATTACK;
          } else if (ev.type === 'off' && st.notes[ev.note]) {
            st.notes[ev.note] = 0;
            st.held--;
            if (st.held <= 0) {
              st.held = 0;
              if (stage !== IDLE) stage = RELEASE;
            }
          }
        }
        const top: number = st.peak;
        if (stage === ATTACK) {
          env += atkInc * top;
          if (env >= top) {
            env = top;
            stage = DECAY;
          }
        } else if (stage === DECAY) {
          env += (p.sustain * top - env) * decC;
        } else if (stage === RELEASE) {
          env -= env * relC;
          if (env < 1e-4) {
            env = 0;
            stage = IDLE;
          }
        }
      }
      st.env = env;
      st.stage = stage;
      io.signal('envelope', p.from + (p.to - p.from) * env);
    },
  }),
  render(ctx) {
    const t = ctx.time.seconds; // reading the clock makes this node re-render every frame
    return { envelope: ctx.host.signal?.(ctx.nodeId, 'envelope', t) ?? 0 };
  },
});
