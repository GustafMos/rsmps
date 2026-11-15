import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

/**
 * Notes played from the computer keyboard or the on-screen piano. While the node is selected the UI maps keys to notes
 * with `keyToNote` (src/engine/audio/keyboard-map.ts) and calls `AudioEngine.sendNote(nodeId, note, velocity, on)`.
 * The UI sends ABSOLUTE notes (already using this node's `baseOctave`); this kernel only applies key strength,
 * transpose, sustain and latch, and remembers what it started so every release matches.
 */
export default defineNode({
  id: 'midi-keyboard',
  title: 'Keyboard',
  category: 'synth',
  description: 'Play notes from your computer keyboard (A W S E D F T G Y H U J K...) or the on-screen piano while this node is selected. Digits 1-9 pick the octave.',
  keywords: ['piano', 'keys', 'play', 'midi', 'notes', 'on-screen', 'computer keyboard', 'octave'],
  playable: true,
  inputs: {},
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    baseOctave: { type: 'number', default: 5, min: 1, max: 9, step: 1, integer: true, label: 'Octave (keys 1-9)', hint: '5 is the normal middle range: the A key plays middle C. Z / X move the octave down / up.' },
    velocity: { type: 'number', default: 0.8, min: 0.05, max: 1, step: 0.01, label: 'Key strength', hint: 'Keys C / V make it softer / harder.' },
    transpose: { type: 'number', default: 0, min: -24, max: 24, step: 1, integer: true, unit: 'st', label: 'Transpose' },
    sustain: { type: 'bool', default: false, label: 'Sustain pedal', hint: 'Released keys keep sounding until this is turned off.' },
    latch: { type: 'bool', default: false, label: 'Latch (press to start, press again to stop)' },
  },
  summary: (p) => `octave ${p.baseOctave}${p.latch ? ' · latch' : ''}${p.sustain ? ' · sustain' : ''}`,
  audio: defineAudio({
    create: () => ({
      sounding: new Int16Array(128).fill(-1), // pressed note -> note actually started
      held: new Uint8Array(128), // key physically down
      pending: new Uint8Array(128), // released while sustained
      lastSustain: false,
      lastLatch: false,
    }),
    process(st, io) {
      const out = io.midiOut.midi;
      const p = io.params;
      const sustain = p.sustain as boolean;
      const latch = p.latch as boolean;
      // sustain pedal lifted: release everything that was waiting
      if (st.lastSustain && !sustain) {
        for (let k = 0; k < 128; k++) {
          if (st.pending[k] && st.sounding[k] >= 0) {
            out.push({ type: 'off', note: st.sounding[k], velocity: 0, value: 0, offset: 0, channel: 0 });
            st.sounding[k] = -1;
          }
          st.pending[k] = 0;
        }
      }
      // latch switched off: release latched notes that are not physically held
      if (st.lastLatch && !latch) {
        for (let k = 0; k < 128; k++) {
          if (st.sounding[k] >= 0 && !st.held[k]) {
            out.push({ type: 'off', note: st.sounding[k], velocity: 0, value: 0, offset: 0, channel: 0 });
            st.sounding[k] = -1;
          }
        }
      }
      st.lastSustain = sustain;
      st.lastLatch = latch;
      for (const ev of io.live.uiMidi) {
        if (ev.type === 'on') {
          st.held[ev.note] = 1;
          st.pending[ev.note] = 0;
          if (latch && st.sounding[ev.note] >= 0) {
            // second press of a latched key stops it
            out.push({ ...ev, type: 'off', note: st.sounding[ev.note], velocity: 0 });
            st.sounding[ev.note] = -1;
            continue;
          }
          if (st.sounding[ev.note] >= 0) out.push({ ...ev, type: 'off', note: st.sounding[ev.note], velocity: 0 });
          const note = Math.max(0, Math.min(127, ev.note + p.transpose));
          st.sounding[ev.note] = note;
          out.push({ ...ev, note, velocity: Math.min(1, ev.velocity * p.velocity) });
        } else if (ev.type === 'off') {
          st.held[ev.note] = 0;
          if (latch || st.sounding[ev.note] < 0) continue;
          if (sustain) {
            st.pending[ev.note] = 1;
            continue;
          }
          out.push({ ...ev, note: st.sounding[ev.note] });
          st.sounding[ev.note] = -1;
        } else out.push(ev);
      }
    },
    reset(st) {
      st.sounding.fill(-1);
      st.held.fill(0);
      st.pending.fill(0);
    },
  }),
});
