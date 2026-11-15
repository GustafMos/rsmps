import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

/** Hardware MIDI input (Web MIDI: keyboards, pads, controllers). Live only; silent in exports. */
export default defineNode({
  id: 'midi-device',
  title: 'MIDI Device',
  category: 'synth',
  description: 'Notes from a connected MIDI keyboard or controller.',
  keywords: ['hardware', 'controller', 'usb', 'keyboard', 'web midi', 'pad'],
  inputs: {},
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    device: { type: 'string', default: '', label: 'Device', hint: 'Leave empty to listen to every connected device, or type part of the device name.' },
    channel: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, label: 'Channel (0 = all)' },
    transpose: { type: 'number', default: 0, min: -48, max: 48, step: 1, integer: true, unit: 'st', label: 'Transpose' },
  },
  summary: (p) => `${p.device || 'any device'} · ${p.channel ? 'ch ' + p.channel : 'all channels'}`,
  audio: defineAudio({
    create: () => ({ sounding: new Int16Array(128 * 16).fill(-1) }),
    process(st, io) {
      const out = io.midiOut.midi;
      const want = (io.params.device as string).trim().toLowerCase();
      const ch = io.params.channel as number;
      const tr = io.params.transpose as number;
      for (const ev of io.live.deviceMidi) {
        if (want && !(ev.device ?? '').toLowerCase().includes(want)) continue;
        if (ch && ev.channel !== ch - 1) continue;
        if (ev.type === 'on' || ev.type === 'off') {
          const key = ev.channel * 128 + ev.note;
          if (ev.type === 'on') {
            const note = Math.max(0, Math.min(127, ev.note + tr));
            st.sounding[key] = note;
            out.push(note === ev.note ? ev : { ...ev, note });
          } else {
            const note = st.sounding[key] >= 0 ? st.sounding[key] : ev.note;
            st.sounding[key] = -1;
            out.push(note === ev.note ? ev : { ...ev, note });
          }
        } else out.push(ev);
      }
    },
  }),
});
