import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

const CHORDS: Record<string, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '6': [0, 4, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  power: [0, 7, 12],
  octaves: [0, 12, 24],
};

export default defineNode({
  id: 'chord',
  title: 'Chord',
  category: 'synth',
  description: 'Turns every note into a chord: one key, several notes.',
  keywords: ['harmony', 'triad', 'major', 'minor', 'seventh', 'stack'],
  inputs: { midi: { type: 'midi', required: true, label: 'MIDI' } },
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    chord: {
      type: 'enum',
      default: 'major',
      label: 'Chord',
      options: [
        { value: 'major', label: 'Major' },
        { value: 'minor', label: 'Minor' },
        { value: 'dim', label: 'Diminished' },
        { value: 'aug', label: 'Augmented' },
        { value: 'sus2', label: 'Suspended 2nd' },
        { value: 'sus4', label: 'Suspended 4th' },
        { value: '6', label: 'Sixth' },
        { value: '7', label: 'Dominant 7th' },
        { value: 'maj7', label: 'Major 7th' },
        { value: 'min7', label: 'Minor 7th' },
        { value: 'power', label: 'Power chord' },
        { value: 'octaves', label: 'Octaves' },
      ],
    },
    inversion: { type: 'number', default: 0, min: 0, max: 3, step: 1, integer: true, label: 'Inversion' },
    bass: { type: 'bool', default: false, label: 'Add bass', hint: 'Adds a bass note one octave down.' },
  },
  summary: (p) => `${p.chord}${p.inversion ? ` inv ${p.inversion}` : ''}`,
  audio: defineAudio({
    // For each incoming note: the notes we started, so the matching release stops exactly those.
    create: () => ({ count: new Uint8Array(128 * 16), notes: new Int16Array(128 * 16 * 8) }),
    process(st, io) {
      const out = io.midiOut.midi;
      const base = CHORDS[io.params.chord] ?? CHORDS.major;
      const inv = Math.min(io.params.inversion, base.length - 1);
      for (const ev of io.midiIn.midi) {
        if (ev.type !== 'on' && ev.type !== 'off') {
          out.push(ev);
          continue;
        }
        const slot = ev.channel * 128 + ev.note;
        if (ev.type === 'on') {
          let c = 0;
          for (let k = 0; k <= base.length; k++) {
            const note = k < base.length ? ev.note + base[k] + (k < inv ? 12 : 0) : io.params.bass ? ev.note - 12 : -1;
            if (note < 0 || note > 127 || c >= 8) continue;
            st.notes[slot * 8 + c++] = note;
            out.push({ ...ev, note });
          }
          st.count[slot] = c;
        } else {
          const c = st.count[slot];
          for (let k = 0; k < c; k++) out.push({ ...ev, note: st.notes[slot * 8 + k] });
          st.count[slot] = 0;
        }
      }
    },
  }),
});
