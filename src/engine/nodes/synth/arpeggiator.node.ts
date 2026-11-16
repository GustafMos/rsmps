import { defineNode } from '../../define';
import { defineAudio, midiEvent } from '../../audio/types';
import { makeRng, rand01 } from '../../audio/dsp';

const BEATS: Record<string, number> = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125, '1/8t': 1 / 3, '1/16t': 1 / 6 };
const MAXN = 16;

/**
 * Turns held notes into a repeating pattern. Steps are locked to the project transport while it plays
 * (so they loop with the picture) and free-run on their own clock when it is paused.
 */
export default defineNode({
  id: 'arpeggiator',
  title: 'Arpeggiator',
  category: 'synth',
  description: 'Plays the notes you hold one after another as a pattern, in time with the tempo.',
  keywords: ['arp', 'sequence', 'pattern', 'rhythm', 'tempo', 'bpm'],
  inputs: { midi: { type: 'midi', required: true, label: 'MIDI' } },
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    bpm: { type: 'number', default: 120, min: 30, max: 300, step: 0.1, label: 'Tempo BPM' },
    rate: {
      type: 'enum',
      default: '1/8',
      label: 'Speed',
      options: [
        { value: '1/4', label: 'Quarter notes' },
        { value: '1/8', label: 'Eighth notes' },
        { value: '1/8t', label: 'Eighth triplets' },
        { value: '1/16', label: 'Sixteenth notes' },
        { value: '1/16t', label: 'Sixteenth triplets' },
        { value: '1/32', label: 'Thirty-second notes' },
      ],
    },
    pattern: {
      type: 'enum',
      default: 'up',
      label: 'Pattern',
      options: [
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
        { value: 'updown', label: 'Up and down' },
        { value: 'random', label: 'Random' },
        { value: 'played', label: 'As played' },
      ],
    },
    octaves: { type: 'number', default: 1, min: 1, max: 4, step: 1, integer: true, label: 'Octave range' },
    gate: { type: 'number', default: 0.6, min: 0.05, max: 1, step: 0.01, label: 'Note length' },
  },
  summary: (p) => `${p.pattern} · ${p.rate} @ ${Math.round(p.bpm)} bpm`,
  audio: defineAudio({
    create: (ctx) => ({
      held: new Int16Array(MAXN).fill(-1), // in press order
      lastVel: 0.8,
      nHeld: 0,
      seq: new Int16Array(MAXN * 4 * 2),
      seqLen: 0,
      step: 0,
      dir: 1,
      next: -1, // absolute clock sample of the next step
      clock: 0,
      lastTime: -1,
      sounding: -1,
      offAt: -1,
      rng: makeRng(ctx.nodeId),
      scratch: new Int16Array(MAXN),
    }),
    process(st, io) {
      const out = io.midiOut.midi;
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const stepLen = (60 / p.bpm) * BEATS[p.rate] * sr;

      // Clock: follow the transport while it plays, otherwise run freely.
      if (io.time.playing) {
        if (st.lastTime < 0 || Math.abs(io.time.sample - st.lastTime) > 1) {
          // seek or loop wrap: restart the pattern on the grid
          st.next = Math.ceil(io.time.sample / stepLen - 1e-9) * stepLen;
          st.step = 0;
          st.dir = 1;
        }
        st.clock = io.time.sample;
        st.lastTime = io.time.sample + n;
      } else {
        if (st.lastTime >= 0) st.next = -1;
        st.lastTime = -1;
        if (st.next < 0) st.next = Math.ceil(st.clock / stepLen - 1e-9) * stepLen;
      }
      if (st.next < 0) st.next = Math.ceil(st.clock / stepLen - 1e-9) * stepLen;

      // Input events: track held notes; pass controllers through.
      for (const ev of io.midiIn.midi) {
        if (ev.type === 'on') {
          let at = -1;
          for (let i = 0; i < st.nHeld; i++) if (st.held[i] === ev.note) at = i;
          if (at < 0 && st.nHeld < MAXN) st.held[st.nHeld++] = ev.note;
          st.lastVel = ev.velocity;
        } else if (ev.type === 'off') {
          for (let i = 0; i < st.nHeld; i++) {
            if (st.held[i] === ev.note) {
              for (let j = i; j < st.nHeld - 1; j++) st.held[j] = st.held[j + 1];
              st.nHeld--;
              break;
            }
          }
        } else out.push(ev);
      }
      if (st.nHeld === 0 && st.sounding >= 0) {
        out.push(midiEvent('off', st.sounding, 0, 0));
        st.sounding = -1;
      }

      // Walk the block: gate-offs and steps in time order.
      const blockEnd = st.clock + n;
      for (let guard = 0; guard < 64; guard++) {
        const offDue = st.sounding >= 0 && st.offAt >= 0 && st.offAt < blockEnd ? st.offAt : Infinity;
        const stepDue = st.next < blockEnd ? st.next : Infinity;
        if (offDue === Infinity && stepDue === Infinity) break;
        if (offDue <= stepDue) {
          out.push(midiEvent('off', st.sounding, 0, Math.max(0, Math.floor(offDue - st.clock))));
          st.sounding = -1;
          st.offAt = -1;
        } else {
          const offset = Math.max(0, Math.floor(stepDue - st.clock));
          if (st.sounding >= 0) {
            out.push(midiEvent('off', st.sounding, 0, offset));
            st.sounding = -1;
          }
          if (st.nHeld > 0) {
            buildSequence(st, p);
            if (st.seqLen > 0) {
              const note = nextNote(st, p);
              out.push(midiEvent('on', note, st.lastVel, offset));
              st.sounding = note;
              st.offAt = stepDue + stepLen * p.gate;
            }
          }
          st.next += stepLen;
        }
      }
      if (!io.time.playing) st.clock += n;
    },
    reset(st) {
      st.nHeld = 0;
      st.sounding = -1;
      st.next = -1;
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSequence(st: any, p: Record<string, any>): void {
  const base = st.scratch as Int16Array;
  const n = st.nHeld as number;
  for (let i = 0; i < n; i++) base[i] = st.held[i];
  if (p.pattern !== 'played') {
    // insertion sort ascending
    for (let i = 1; i < n; i++) {
      const x = base[i];
      let j = i - 1;
      while (j >= 0 && base[j] > x) {
        base[j + 1] = base[j];
        j--;
      }
      base[j + 1] = x;
    }
  }
  let len = 0;
  const seq = st.seq as Int16Array;
  for (let o = 0; o < p.octaves; o++) {
    for (let i = 0; i < n; i++) {
      const note = base[i] + 12 * o;
      if (note <= 127 && len < seq.length) seq[len++] = note;
    }
  }
  st.seqLen = len;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nextNote(st: any, p: Record<string, any>): number {
  const len = st.seqLen as number;
  const seq = st.seq as Int16Array;
  let idx: number;
  switch (p.pattern) {
    case 'down':
      idx = len - 1 - (st.step % len);
      st.step++;
      break;
    case 'updown': {
      if (len === 1) {
        idx = 0;
        break;
      }
      const cycle = 2 * len - 2;
      const k = st.step % cycle;
      idx = k < len ? k : cycle - k;
      st.step++;
      break;
    }
    case 'random':
      idx = Math.min(len - 1, Math.floor(rand01(st.rng) * len));
      break;
    default:
      idx = st.step % len;
      st.step++;
  }
  return seq[idx];
}
