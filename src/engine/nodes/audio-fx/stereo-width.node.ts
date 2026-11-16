import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';

/** Mid/side width control. 0 = mono, 1 = unchanged, 2 = extra wide. */
export default defineNode({
  id: 'stereo-width',
  title: 'Stereo Width',
  category: 'audio-fx',
  description: 'Makes the sound narrower (towards mono) or wider.',
  keywords: ['mono', 'wide', 'mid side', 'stereo', 'spread', 'image'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    width: { type: 'number', default: 1.5, min: 0, max: 2, step: 0.01, label: 'Width', hint: '0 = mono, 1 = normal.' },
  },
  summary: (p) => (p.width === 0 ? 'mono' : `${Math.round(p.width * 100)}%`),
  audio: defineAudio({
    create: () => ({ w: -1 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const n = io.frames;
      const target = io.params.width as number;
      if (st.w < 0) st.w = target;
      const w0 = st.w;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        const w = w0 + ((target - w0) * (i + 1)) / n;
        const m = (src[0][i] + src[1][i]) * 0.5;
        const s = (src[0][i] - src[1][i]) * 0.5 * w;
        ol[i] = m + s;
        or[i] = m - s;
      }
      st.w = target;
    },
  }),
});
