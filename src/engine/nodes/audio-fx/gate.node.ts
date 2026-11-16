import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';

/** Noise gate: closes (turns down by "reduction") when the signal falls below the threshold. */
export default defineNode({
  id: 'gate',
  title: 'Noise Gate',
  category: 'audio-fx',
  description: 'Silences quiet parts, like hiss between words or notes.',
  keywords: ['expander', 'hiss', 'noise', 'silence', 'cleanup'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    threshold: { type: 'number', default: -45, min: -90, max: 0, step: 0.5, unit: 'db', label: 'Opens above' },
    reduction: { type: 'number', default: 60, min: 0, max: 90, step: 1, unit: 'db', label: 'Closed gain', hint: 'How far the signal is reduced while the gate is closed.' },
    attack: { type: 'number', default: 2, min: 0.1, max: 100, step: 0.1, label: 'Attack ms' },
    hold: { type: 'number', default: 40, min: 0, max: 500, step: 1, label: 'Hold ms' },
    release: { type: 'number', default: 120, min: 5, max: 2000, step: 1, label: 'Release ms' },
  },
  summary: (p) => `opens above ${p.threshold} dB`,
  audio: defineAudio({
    create: () => ({ env: 0, g: 0, hold: 0, open: false }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const openT = dbToLin(p.threshold);
      const closeT = openT * 0.7; // hysteresis (-3 dB) so it does not chatter
      const floor = dbToLin(-p.reduction);
      const atk = 1 - Math.exp(-1 / Math.max((p.attack / 1000) * sr, 1));
      const rel = 1 - Math.exp(-1 / Math.max((p.release / 1000) * sr, 1));
      const holdN = (p.hold / 1000) * sr;
      const envRel = Math.exp(-1 / (0.005 * sr));
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        const a = Math.max(Math.abs(src[0][i]), Math.abs(src[1][i]));
        st.env = a > st.env ? a : st.env * envRel;
        if (st.env > openT) {
          st.open = true;
          st.hold = holdN;
        } else if (st.env < closeT) {
          if (st.hold > 0) st.hold--;
          else st.open = false;
        }
        const target = st.open ? 1 : floor;
        st.g += (target - st.g) * (target > st.g ? atk : rel);
        ol[i] = src[0][i] * st.g;
        or[i] = src[1][i] * st.g;
      }
    },
  }),
});
