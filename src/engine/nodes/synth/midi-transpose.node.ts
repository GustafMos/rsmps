import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { KEY_OPTIONS, SCALE_OPTIONS, snapToScale } from '../../audio/scales';

export default defineNode({
  id: 'midi-transpose',
  title: 'Transpose',
  category: 'synth',
  description: 'Shifts notes up or down, and can snap them to a musical scale.',
  keywords: ['shift', 'octave', 'semitone', 'scale', 'key', 'quantize', 'pitch'],
  inputs: { midi: { type: 'midi', required: true, label: 'MIDI' } },
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    semitones: { type: 'number', default: 0, min: -24, max: 24, step: 1, integer: true, unit: 'st', label: 'Semitones' },
    octave: { type: 'number', default: 0, min: -4, max: 4, step: 1, integer: true, label: 'Octaves' },
    scale: { type: 'enum', default: 'off', options: SCALE_OPTIONS, label: 'Snap to scale' },
    key: { type: 'enum', default: '0', options: KEY_OPTIONS, label: 'Key', visibleIf: (p) => p.scale !== 'off' },
  },
  summary: (p) => `${p.semitones + p.octave * 12 >= 0 ? '+' : ''}${p.semitones + p.octave * 12} st${p.scale !== 'off' ? ' · ' + p.scale : ''}`,
  audio: defineAudio({
    create: () => ({ map: new Int16Array(128 * 16).fill(-1) }),
    process(st, io) {
      const out = io.midiOut.midi;
      const shift = io.params.semitones + io.params.octave * 12;
      const scale = io.params.scale as string;
      const key = Number(io.params.key);
      for (const ev of io.midiIn.midi) {
        if (ev.type !== 'on' && ev.type !== 'off') {
          out.push(ev);
          continue;
        }
        const slot = ev.channel * 128 + ev.note;
        if (ev.type === 'on') {
          let note = ev.note + shift;
          if (scale !== 'off') note = snapToScale(note, scale, key);
          if (note < 0 || note > 127) {
            st.map[slot] = -1;
            continue;
          }
          st.map[slot] = note;
          out.push({ ...ev, note });
        } else {
          const note = st.map[slot];
          st.map[slot] = -1;
          if (note >= 0) out.push({ ...ev, note });
        }
      }
    },
  }),
});
