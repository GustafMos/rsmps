import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { DelayLine, TAU, fz } from '../../audio/dsp';

/** Short swept delay with feedback: the classic "jet plane" comb sweep. */
export default defineNode({
  id: 'flanger',
  title: 'Flanger',
  category: 'audio-fx',
  description: 'A sweeping, whooshing comb effect, like a jet passing overhead.',
  keywords: ['jet', 'sweep', 'comb', 'whoosh', 'modulation', 'phaser'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    rate: { type: 'number', default: 0.3, min: 0.02, max: 5, step: 0.01, unit: 'hz', label: 'Speed' },
    depth: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Depth' },
    delay: { type: 'number', default: 2, min: 0.2, max: 8, step: 0.1, label: 'Centre delay (ms)' },
    feedback: { type: 'number', default: 0.5, min: -0.95, max: 0.95, step: 0.01, label: 'Feedback' },
    mix: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${p.rate.toFixed(2)} Hz · feedback ${Math.round(p.feedback * 100)}%`,
  audio: defineAudio({
    create: (ctx) => ({ l: new DelayLine(ctx.sampleRate * 0.02), r: new DelayLine(ctx.sampleRate * 0.02), phase: 0, fl: 0, fr: 0 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const centre = (p.delay / 1000) * sr;
      const swing = Math.min(centre - 1, centre * p.depth);
      const inc = p.rate / sr;
      const fb = p.feedback as number;
      const mix = p.mix as number;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        const dl = Math.max(1, centre + swing * Math.sin(TAU * st.phase));
        const dr = Math.max(1, centre + swing * Math.sin(TAU * (st.phase + 0.25)));
        const yl = st.l.read(dl - 1);
        const yr = st.r.read(dr - 1);
        st.l.write(src[0][i] + fz(yl) * fb);
        st.r.write(src[1][i] + fz(yr) * fb);
        st.phase += inc;
        if (st.phase >= 1) st.phase -= 1;
        ol[i] = src[0][i] * (1 - mix * 0.5) + yl * mix * 0.7;
        or[i] = src[1][i] * (1 - mix * 0.5) + yr * mix * 0.7;
      }
    },
  }),
});
