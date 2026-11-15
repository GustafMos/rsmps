import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { WAVE, dbToLin, makeRng, oscSample, randBi } from '../../audio/dsp';

/** Test-tone and noise generator. Always running (does not need the transport). */
export default defineNode({
  id: 'oscillator',
  title: 'Tone Generator',
  category: 'audio-source',
  description: 'A steady tone (sine, triangle, saw, square) or white noise. Handy for testing effects.',
  keywords: ['sine', 'noise', 'test tone', 'beep', 'wave', 'drone'],
  inputs: {},
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    wave: {
      type: 'enum',
      default: 'sine',
      label: 'Wave',
      options: [
        { value: 'sine', label: 'Sine' },
        { value: 'triangle', label: 'Triangle' },
        { value: 'saw', label: 'Saw' },
        { value: 'square', label: 'Square' },
        { value: 'noise', label: 'White noise' },
      ],
    },
    frequency: { type: 'number', default: 440, min: 20, max: 20000, step: 1, unit: 'hz', label: 'Pitch', visibleIf: (p) => p.wave !== 'noise' },
    level: { type: 'number', default: -12, min: -60, max: 0, step: 0.1, unit: 'db', label: 'Level' },
  },
  summary: (p) => (p.wave === 'noise' ? 'noise' : `${p.wave} ${Math.round(p.frequency)} Hz`),
  audio: defineAudio({
    create: (ctx) => ({ phase: 0, g: 0, rng: makeRng(ctx.nodeId), first: true }),
    process(st, io) {
      const n = io.frames;
      const [ol, or] = io.out.audio;
      const wave = io.params.wave as string;
      const target = dbToLin(io.params.level);
      if (st.first) {
        st.g = target;
        st.first = false;
      }
      const g0 = st.g;
      const dt = io.params.frequency / io.sampleRate;
      const code = wave === 'noise' ? -1 : WAVE[wave as keyof typeof WAVE];
      let phase: number = st.phase;
      const gStep = (target - g0) / n;
      for (let i = 0; i < n; i++) {
        const g = g0 + gStep * (i + 1);
        const v = code < 0 ? randBi(st.rng) : oscSample(code, phase, dt);
        ol[i] = v * g;
        or[i] = v * g;
        phase += dt;
        if (phase >= 1) phase -= 1;
      }
      st.phase = phase;
      st.g = target;
    },
  }),
});
