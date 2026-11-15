import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';
import { limiterProcess, makeLimiter } from '../../audio/limiter';

/**
 * Sink. Everything wired here is summed (that is how sources are layered), run through the master
 * gain and a safety limiter, and handed to the host (`out.master`): the player plays it and the
 * exporter muxes it.
 */
export default defineNode({
  id: 'audio-out',
  title: 'Audio Output',
  category: 'output',
  description: 'The speakers and the exported sound track. Everything wired here is mixed together.',
  keywords: ['speaker', 'master', 'sound', 'export', 'mix', 'limiter'],
  inputs: { audio: { type: 'audio', multi: true, label: 'Audio' } },
  outputs: {},
  params: {
    enabled: { type: 'bool', default: true, label: 'Include in export', hint: 'Untick to leave this sound out of exported files. You still hear it while working.' },
    gain: { type: 'number', default: 0, min: -60, max: 12, step: 0.1, unit: 'db', label: 'Master volume' },
    limiter: { type: 'bool', default: true, label: 'Protect against clipping' },
    ceiling: { type: 'number', default: -1, min: -12, max: 0, step: 0.1, unit: 'db', label: 'Ceiling', visibleIf: (p) => p.limiter !== false },
  },
  summary: (p) => `${p.gain >= 0 ? '+' : ''}${p.gain.toFixed(1)} dB${p.limiter ? ' · limited' : ''}`,
  audio: defineAudio({
    create: (ctx) => ({ g: 1, lim: makeLimiter(ctx.sampleRate), sr: ctx.sampleRate }),
    process(st, io) {
      const src = io.in.audio;
      const n = io.frames;
      const [ol, or] = io.out.master;
      if (!src) return;
      const target = dbToLin(io.params.gain);
      const g0 = st.g;
      for (let i = 0; i < n; i++) {
        const g = g0 + ((target - g0) * (i + 1)) / n;
        ol[i] = src[0][i] * g;
        or[i] = src[1][i] * g;
      }
      st.g = target;
      if (io.params.limiter) limiterProcess(st.lim, st.sr, ol, or, ol, or, n, dbToLin(io.params.ceiling), 0.1);
    },
  }),
});
