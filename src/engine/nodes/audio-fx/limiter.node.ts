import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';
import { limiterProcess, makeLimiter } from '../../audio/limiter';

export default defineNode({
  id: 'limiter',
  title: 'Limiter',
  category: 'audio-fx',
  description: 'A brick wall: nothing gets louder than the ceiling. Push the input to make things louder safely.',
  keywords: ['loudness', 'clip', 'ceiling', 'maximizer', 'brickwall', 'peak'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    input: { type: 'number', default: 0, min: 0, max: 24, step: 0.1, unit: 'db', label: 'Input boost' },
    ceiling: { type: 'number', default: -1, min: -24, max: 0, step: 0.1, unit: 'db', label: 'Ceiling' },
    release: { type: 'number', default: 100, min: 10, max: 1000, step: 1, label: 'Release (ms)' },
  },
  summary: (p) => `ceiling ${p.ceiling} dB`,
  audio: defineAudio({
    create: (ctx) => ({ lim: makeLimiter(ctx.sampleRate), tmpL: new Float32Array(ctx.blockSize), tmpR: new Float32Array(ctx.blockSize) }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const n = io.frames;
      const boost = dbToLin(io.params.input);
      for (let i = 0; i < n; i++) {
        st.tmpL[i] = src[0][i] * boost;
        st.tmpR[i] = src[1][i] * boost;
      }
      limiterProcess(st.lim, io.sampleRate, st.tmpL, st.tmpR, io.out.audio[0], io.out.audio[1], n, dbToLin(io.params.ceiling), io.params.release / 1000);
    },
  }),
});
