import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin, panGains } from '../../audio/dsp';

export default defineNode({
  id: 'gain',
  title: 'Volume & Pan',
  category: 'audio-fx',
  description: 'Makes a sound louder or quieter and places it left or right. Mute silences it.',
  keywords: ['volume', 'level', 'pan', 'balance', 'fader', 'mute', 'db'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    gain: { type: 'number', default: 0, min: -60, max: 24, step: 0.1, unit: 'db', label: 'Volume' },
    pan: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Pan (left ... right)' },
    mute: { type: 'bool', default: false, label: 'Mute' },
  },
  summary: (p) => (p.mute ? 'muted' : `${p.gain >= 0 ? '+' : ''}${p.gain.toFixed(1)} dB${p.pan ? ` · pan ${p.pan.toFixed(2)}` : ''}`),
  audio: defineAudio({
    create: () => ({ l: 1, r: 1, init: false }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const n = io.frames;
      const [pl, pr] = panGains(io.params.pan);
      const g = io.params.mute ? 0 : dbToLin(io.params.gain);
      // equal-power pan, unity at centre
      const tl = g * pl * Math.SQRT2;
      const tr = g * pr * Math.SQRT2;
      if (!st.init) {
        st.l = tl;
        st.r = tr;
        st.init = true;
      }
      const l0 = st.l;
      const r0 = st.r;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        ol[i] = src[0][i] * (l0 + ((tl - l0) * (i + 1)) / n);
        or[i] = src[1][i] * (r0 + ((tr - r0) * (i + 1)) / n);
      }
      st.l = tl;
      st.r = tr;
    },
  }),
});
