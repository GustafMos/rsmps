import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

/**
 * Sound-to-picture bridge for MIDI: held notes, velocity, gate and a controller become numbers.
 * Outputs `note` and `cc` are mapped into From..To; `velocity`, `gate` are 0..1; `count` is the number of held notes.
 */
export default defineNode({
  id: 'midi-value',
  title: 'MIDI to Numbers',
  category: 'math',
  description: 'Turns the notes you play (or sing, through Audio to MIDI) into numbers: which note, how hard, whether a key is down, how many keys, and a knob.',
  keywords: ['midi', 'note', 'velocity', 'gate', 'key', 'cc', 'controller', 'knob', 'drive', 'audio reactive'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: {
    note: { type: 'number', label: 'Note' },
    velocity: { type: 'number', label: 'Strength' },
    gate: { type: 'number', label: 'Key down' },
    count: { type: 'number', label: 'Keys held' },
    cc: { type: 'number', label: 'Knob' },
  },
  params: {
    which: {
      type: 'enum',
      default: 'last',
      label: 'Which note',
      options: [
        { value: 'last', label: 'Most recent' },
        { value: 'highest', label: 'Highest held' },
        { value: 'lowest', label: 'Lowest held' },
      ],
    },
    minNote: { type: 'number', default: 36, min: 0, max: 126, step: 1, integer: true, label: 'Lowest note (gives From)' },
    maxNote: { type: 'number', default: 84, min: 1, max: 127, step: 1, integer: true, label: 'Highest note (gives To)' },
    from: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'From' },
    to: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'To' },
    glide: { type: 'number', default: 0, min: 0, max: 2000, step: 1, label: 'Note glide (ms)' },
    attack: { type: 'number', default: 5, min: 0, max: 2000, step: 1, label: 'Key down rise (ms)' },
    release: { type: 'number', default: 80, min: 0, max: 5000, step: 1, label: 'Key up fall (ms)' },
    controller: { type: 'number', default: 1, min: 0, max: 127, step: 1, integer: true, label: 'Knob number (CC)', hint: '1 = mod wheel, 7 = volume, 64 = sustain pedal' },
  },
  summary: (p) => `${p.which} note ${p.minNote}..${p.maxNote} to ${p.from}..${p.to}`,
  audio: defineAudio({
    create: () => ({
      held: new Uint8Array(128),
      vel: new Float64Array(128),
      order: new Int16Array(128), // press order, oldest first
      nOrder: 0,
      gate: 0,
      noteNorm: -1,
      velocity: 0,
      cc: 0,
    }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      for (const ev of io.midiIn.midi) {
        if (ev.type === 'on') {
          if (!st.held[ev.note]) {
            st.held[ev.note] = 1;
            st.order[st.nOrder++] = ev.note;
          }
          st.vel[ev.note] = ev.velocity;
        } else if (ev.type === 'off') {
          if (st.held[ev.note]) {
            st.held[ev.note] = 0;
            let j = 0;
            for (let i = 0; i < st.nOrder; i++) if (st.order[i] !== ev.note) st.order[j++] = st.order[i];
            st.nOrder = j;
          }
        } else if (ev.type === 'cc' && ev.note === p.controller) st.cc = ev.value;
      }
      const count = st.nOrder as number;
      // target note (kept after release: the picture holds the last note)
      let target = -1;
      if (count > 0) {
        if (p.which === 'last') target = st.order[count - 1];
        else {
          target = st.order[0];
          for (let i = 1; i < count; i++) {
            const k = st.order[i];
            if (p.which === 'highest' ? k > target : k < target) target = k;
          }
        }
        st.velocity = st.vel[target];
      }
      if (target >= 0) {
        const pos = Math.min(1, Math.max(0, (target - p.minNote) / Math.max(1, p.maxNote - p.minNote)));
        if (st.noteNorm < 0 || p.glide <= 0) st.noteNorm = pos;
        else st.noteNorm += (pos - st.noteNorm) * (1 - Math.exp(-n / Math.max(1, (p.glide / 1000) * sr)));
      } else if (st.noteNorm >= 0 && p.glide > 0) {
        // keep gliding towards where we were heading: nothing to do, the last position is held
      }
      const want = count > 0 ? 1 : 0;
      const ms = want > st.gate ? p.attack : p.release;
      st.gate += (want - st.gate) * (ms <= 0 ? 1 : 1 - Math.exp(-n / Math.max(1, (ms / 1000) * sr)));
      const norm = st.noteNorm < 0 ? 0 : st.noteNorm;
      io.signal('note', p.from + (p.to - p.from) * norm);
      io.signal('velocity', st.velocity);
      io.signal('gate', st.gate);
      io.signal('count', count);
      io.signal('cc', st.cc);
    },
  }),
  render(ctx) {
    const t = ctx.time.seconds; // reading the clock makes this node re-render every frame
    const read = (name: string): number => ctx.host.signal?.(ctx.nodeId, name, t) ?? 0;
    return { note: read('note'), velocity: read('velocity'), gate: read('gate'), count: read('count'), cc: read('cc') };
  },
});
