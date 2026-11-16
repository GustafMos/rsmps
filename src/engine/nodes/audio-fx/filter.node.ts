import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { TAU, biquadBlock, makeBiquad, setBiquad } from '../../audio/dsp';

const SUB = 32;

/**
 * Resonant filter with an optional sweep. The sweep repeats a WHOLE number of times per project
 * loop (phase = transport position / project duration), so exports loop seamlessly.
 */
export default defineNode({
  id: 'filter',
  title: 'Audio Filter',
  category: 'audio-fx',
  description: 'Removes highs (low-pass), lows (high-pass), everything but a band, or one band (notch). Can sweep automatically.',
  keywords: ['lowpass', 'highpass', 'bandpass', 'notch', 'wah', 'sweep', 'cutoff', 'resonance', 'lfo', 'filter', 'low pass', 'high pass'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    type: {
      type: 'enum',
      default: 'lowpass',
      label: 'Type',
      options: [
        { value: 'lowpass', label: 'Low-pass' },
        { value: 'highpass', label: 'High-pass' },
        { value: 'bandpass', label: 'Band-pass' },
        { value: 'notch', label: 'Notch' },
      ],
    },
    cutoff: { type: 'number', default: 1000, min: 20, max: 20000, step: 1, unit: 'hz', label: 'Cutoff' },
    resonance: { type: 'number', default: 0.707, min: 0.1, max: 20, step: 0.01, label: 'Resonance', hint: 'The filter Q.' },
    sweepDepth: { type: 'number', default: 0, min: 0, max: 4, step: 0.01, label: 'Sweep octaves', group: 'Sweep' },
    sweepCycles: { type: 'number', default: 1, min: 0, max: 64, step: 1, integer: true, unit: 'cycles', label: 'Sweeps per loop', group: 'Sweep' },
    mix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${p.type} ${Math.round(p.cutoff)} Hz`,
  audio: defineAudio({
    create: () => ({ bq: [makeBiquad(), makeBiquad()], tmpL: new Float32Array(SUB), tmpR: new Float32Array(SUB), lastCut: -1, lastQ: -1, lastType: '', free: 0 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const dur = io.time.duration;
      const mix = p.mix as number;
      const [ol, or] = io.out.audio;
      for (let s0 = 0; s0 < n; s0 += SUB) {
        const m = Math.min(SUB, n - s0);
        let cut = p.cutoff as number;
        if (p.sweepDepth > 0 && p.sweepCycles > 0) {
          let phase: number;
          if (dur > 0 && io.time.playing) phase = (((io.time.sample + s0) / sr) / dur) * p.sweepCycles;
          else {
            st.free += m / sr / 4; // paused: free-run one sweep per 4 s so the effect stays audible
            phase = st.free * p.sweepCycles;
          }
          cut *= Math.pow(2, p.sweepDepth * Math.sin(TAU * phase));
        }
        if (cut !== st.lastCut || p.resonance !== st.lastQ || p.type !== st.lastType) {
          for (const b of st.bq) setBiquad(b, p.type, sr, cut, p.resonance);
          st.lastCut = cut;
          st.lastQ = p.resonance;
          st.lastType = p.type;
        }
        biquadBlock(st.bq[0], src[0], st.tmpL, m, s0, 0);
        biquadBlock(st.bq[1], src[1], st.tmpR, m, s0, 0);
        for (let i = 0; i < m; i++) {
          ol[s0 + i] = src[0][s0 + i] * (1 - mix) + st.tmpL[i] * mix;
          or[s0 + i] = src[1][s0 + i] * (1 - mix) + st.tmpR[i] * mix;
        }
      }
    },
  }),
});
