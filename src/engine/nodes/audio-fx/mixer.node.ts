import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';

/**
 * Layering: wire any number of sources into the one input (the host sums the wires), set a master level.
 * Put a Volume & Pan node on each source first to balance the layers.
 */
export default defineNode({
  id: 'mixer',
  title: 'Mixer',
  category: 'audio-fx',
  description: 'Layers several sounds on top of each other. Connect as many sources as you like.',
  keywords: ['layer', 'sum', 'combine', 'bus', 'blend', 'stack'],
  inputs: { audio: { type: 'audio', multi: true, label: 'Layers' } },
  outputs: { audio: { type: 'audio', label: 'Mix' } },
  params: {
    gain: { type: 'number', default: 0, min: -60, max: 24, step: 0.1, unit: 'db', label: 'Master volume' },
    mute: { type: 'bool', default: false, label: 'Mute' },
  },
  summary: (p) => (p.mute ? 'muted' : `${p.gain >= 0 ? '+' : ''}${p.gain.toFixed(1)} dB`),
  audio: defineAudio({
    create: () => ({ g: -1 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const n = io.frames;
      const target = io.params.mute ? 0 : dbToLin(io.params.gain);
      if (st.g < 0) st.g = target;
      const g0 = st.g;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        const g = g0 + ((target - g0) * (i + 1)) / n;
        ol[i] = src[0][i] * g;
        or[i] = src[1][i] * g;
      }
      st.g = target;
    },
  }),
});
