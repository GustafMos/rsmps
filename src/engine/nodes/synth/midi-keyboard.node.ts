import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

/**
 * Notes played from the computer keyboard or the on-screen keyboard. The UI calls
 * `AudioEngine.sendNote(nodeId, note, velocity, on)`; this node turns them into a MIDI stream.
 * The octave is applied when a key goes down and remembered, so releasing after changing octave
 * still releases the right note.
 */
export default defineNode({
  id: 'midi-keyboard',
  title: 'Keyboard',
  category: 'synth',
  description: 'Play notes from your computer keyboard or the on-screen keys. Connect it to a synth.',
  keywords: ['piano', 'keys', 'play', 'midi', 'notes', 'on-screen'],
  inputs: {},
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    octave: { type: 'number', default: 0, min: -4, max: 4, step: 1, integer: true, label: 'Octave shift' },
    velocity: { type: 'number', default: 0.8, min: 0.05, max: 1, step: 0.01, label: 'Key strength' },
  },
  summary: (p) => (p.octave ? `octave ${p.octave > 0 ? '+' : ''}${p.octave}` : 'octave 0'),
  audio: defineAudio({
    create: () => ({ sounding: new Int16Array(128).fill(-1) }),
    process(st, io) {
      const out = io.midiOut.midi;
      const shift = io.params.octave * 12;
      for (const ev of io.live.uiMidi) {
        if (ev.type === 'on') {
          const note = Math.max(0, Math.min(127, ev.note + shift));
          if (st.sounding[ev.note] >= 0) out.push({ ...ev, type: 'off', note: st.sounding[ev.note], velocity: 0 });
          st.sounding[ev.note] = note;
          out.push({ ...ev, note, velocity: Math.min(1, ev.velocity * io.params.velocity) });
        } else if (ev.type === 'off') {
          const note = st.sounding[ev.note];
          if (note >= 0) {
            st.sounding[ev.note] = -1;
            out.push({ ...ev, note });
          }
        } else out.push(ev);
      }
    },
  }),
});
