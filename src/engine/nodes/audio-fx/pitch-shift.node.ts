import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { DelayLine } from '../../audio/dsp';

/** Granular pitch shifter: two overlapping delay taps sweep through a short window and cross-fade. */
export default defineNode({
  id: 'pitch-shift',
  title: 'Pitch Shift',
  category: 'audio-fx',
  description: 'Moves the pitch up or down by a number of semitones without changing the speed.',
  keywords: ['transpose', 'octave', 'harmonizer', 'chipmunk', 'detune', 'semitone'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    semitones: { type: 'number', default: 7, min: -24, max: 24, step: 0.01, unit: 'st', label: 'Shift' },
    window: { type: 'number', default: 60, min: 20, max: 150, step: 1, label: 'Grain ms' },
    mix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${p.semitones > 0 ? '+' : ''}${p.semitones.toFixed(2)} st`,
  audio: defineAudio({
    create: (ctx) => ({ l: new DelayLine(ctx.sampleRate * 0.2), r: new DelayLine(ctx.sampleRate * 0.2), ph: 0 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const n = io.frames;
      const w = Math.max(64, (p.window / 1000) * io.sampleRate);
      const ratio = Math.pow(2, p.semitones / 12);
      const inc = (1 - ratio) / w;
      const mix = p.mix as number;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        st.l.write(src[0][i]);
        st.r.write(src[1][i]);
        const p1 = st.ph;
        const p2 = st.ph + 0.5 >= 1 ? st.ph - 0.5 : st.ph + 0.5;
        const g1 = Math.sin(Math.PI * p1) ** 2;
        const g2 = 1 - g1;
        const d1 = p1 * w + 1;
        const d2 = p2 * w + 1;
        const yl = st.l.read(d1) * g1 + st.l.read(d2) * g2;
        const yr = st.r.read(d1) * g1 + st.r.read(d2) * g2;
        st.ph += inc;
        if (st.ph >= 1) st.ph -= 1;
        else if (st.ph < 0) st.ph += 1;
        ol[i] = src[0][i] * (1 - mix) + yl * mix;
        or[i] = src[1][i] * (1 - mix) + yr * mix;
      }
    },
  }),
});
