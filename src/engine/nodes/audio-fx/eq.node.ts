import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { biquadBlock, makeBiquad, setBiquad, type Biquad } from '../../audio/dsp';

/** Four-band equaliser: low shelf, two peaking bands, high shelf (RBJ biquads). */
export default defineNode({
  id: 'eq',
  title: 'Equalizer',
  category: 'audio-fx',
  description: 'Boost or cut bass, two middle bands, and treble.',
  keywords: ['tone', 'bass', 'treble', 'mid', 'frequency', 'shelf', 'parametric'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    lowFreq: { type: 'number', default: 120, min: 20, max: 1000, step: 1, unit: 'hz', label: 'Bass at', group: 'Bass' },
    lowGain: { type: 'number', default: 0, min: -18, max: 18, step: 0.1, unit: 'db', label: 'Bass', group: 'Bass' },
    m1Freq: { type: 'number', default: 500, min: 50, max: 8000, step: 1, unit: 'hz', label: 'Low-mid at', group: 'Low-mid' },
    m1Gain: { type: 'number', default: 0, min: -18, max: 18, step: 0.1, unit: 'db', label: 'Low-mid', group: 'Low-mid' },
    m1Q: { type: 'number', default: 1, min: 0.1, max: 10, step: 0.01, label: 'Low-mid width (Q)', group: 'Low-mid' },
    m2Freq: { type: 'number', default: 3000, min: 200, max: 16000, step: 1, unit: 'hz', label: 'High-mid at', group: 'High-mid' },
    m2Gain: { type: 'number', default: 0, min: -18, max: 18, step: 0.1, unit: 'db', label: 'High-mid', group: 'High-mid' },
    m2Q: { type: 'number', default: 1, min: 0.1, max: 10, step: 0.01, label: 'High-mid width (Q)', group: 'High-mid' },
    highFreq: { type: 'number', default: 8000, min: 1000, max: 18000, step: 1, unit: 'hz', label: 'Treble at', group: 'Treble' },
    highGain: { type: 'number', default: 0, min: -18, max: 18, step: 0.1, unit: 'db', label: 'Treble', group: 'Treble' },
  },
  summary: (p) => `bass ${p.lowGain} · mid ${p.m1Gain}/${p.m2Gain} · treble ${p.highGain} dB`,
  audio: defineAudio({
    create: () => ({
      key: '',
      active: new Int32Array(4),
      bands: [0, 1, 2, 3].map(() => [makeBiquad(), makeBiquad()] as [Biquad, Biquad]),
    }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const key = `${p.lowFreq}|${p.lowGain}|${p.m1Freq}|${p.m1Gain}|${p.m1Q}|${p.m2Freq}|${p.m2Gain}|${p.m2Q}|${p.highFreq}|${p.highGain}`;
      if (key !== st.key) {
        st.key = key;
        for (let c = 0; c < 2; c++) {
          setBiquad(st.bands[0][c], 'lowshelf', io.sampleRate, p.lowFreq, 0.707, p.lowGain);
          setBiquad(st.bands[1][c], 'peaking', io.sampleRate, p.m1Freq, p.m1Q, p.m1Gain);
          setBiquad(st.bands[2][c], 'peaking', io.sampleRate, p.m2Freq, p.m2Q, p.m2Gain);
          setBiquad(st.bands[3][c], 'highshelf', io.sampleRate, p.highFreq, 0.707, p.highGain);
        }
      }
      const n = io.frames;
      const active = st.active as Int32Array;
      let na = 0;
      if (p.lowGain !== 0) active[na++] = 0;
      if (p.m1Gain !== 0) active[na++] = 1;
      if (p.m2Gain !== 0) active[na++] = 2;
      if (p.highGain !== 0) active[na++] = 3;
      for (let c = 0; c < 2; c++) {
        const o = io.out.audio[c];
        let from = src[c];
        for (let k = 0; k < na; k++) {
          biquadBlock(st.bands[active[k]][c], from, o, n);
          from = o;
        }
        if (na === 0) for (let i = 0; i < n; i++) o[i] = src[c][i];
      }
    },
  }),
});
