import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { TAU } from '../../audio/dsp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lfo(st: any, shape: string, ph: number, c: number): number {
  const t = ph - Math.floor(ph);
  if (shape === 'sine') return 0.5 + 0.5 * Math.sin(TAU * t);
  if (shape === 'triangle') return 1 - Math.abs(2 * t - 1);
  // square, with a short smoothing so it does not click
  st.sq[c] += ((t < 0.5 ? 1 : 0) - st.sq[c]) * 0.02;
  return st.sq[c];
}

export default defineNode({
  id: 'tremolo',
  title: 'Tremolo',
  category: 'audio-fx',
  description: 'Makes the volume pulse. With Stereo spread it swings the sound left and right (auto-pan).',
  keywords: ['wobble', 'pulse', 'autopan', 'vibrato', 'amplitude', 'lfo'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    rate: { type: 'number', default: 5, min: 0.05, max: 30, step: 0.01, unit: 'hz', label: 'Speed' },
    depth: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Depth' },
    shape: {
      type: 'enum',
      default: 'sine',
      label: 'Shape',
      options: [
        { value: 'sine', label: 'Smooth' },
        { value: 'triangle', label: 'Triangle' },
        { value: 'square', label: 'Choppy' },
      ],
    },
    spread: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Stereo spread (auto-pan)' },
  },
  summary: (p) => `${p.rate.toFixed(1)} Hz · ${Math.round(p.depth * 100)}%`,
  audio: defineAudio({
    create: () => ({ phase: 0, sq: [0, 0] }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const n = io.frames;
      const inc = p.rate / io.sampleRate;
      const shape = p.shape as string;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        const gl = 1 - p.depth * (1 - lfo(st, shape, st.phase, 0));
        const gr = 1 - p.depth * (1 - lfo(st, shape, st.phase + 0.5 * p.spread, 1));
        ol[i] = src[0][i] * gl;
        or[i] = src[1][i] * gr;
        st.phase += inc;
        if (st.phase >= 1) st.phase -= 1;
      }
    },
  }),
});
