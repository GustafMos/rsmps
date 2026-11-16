import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';

function shape(x: number, kind: number): number {
  switch (kind) {
    case 0: // soft clip: smooth odd rational curve (tanh look-alike), exactly +-1 beyond |x| = 3
      return x >= 3 ? 1 : x <= -3 ? -1 : (x * (27 + x * x)) / (27 + 9 * x * x);
    case 1: // hard clip
      return x > 1 ? 1 : x < -1 ? -1 : x;
    case 2: {
      // wave fold
      let y = x;
      for (let k = 0; k < 8 && (y > 1 || y < -1); k++) y = y > 1 ? 2 - y : -2 - y;
      return y;
    }
  }
  return x;
}

export default defineNode({
  id: 'distortion',
  title: 'Distortion',
  category: 'audio-fx',
  description: 'Adds grit: soft or hard clipping, wave folding, or lo-fi bit crushing.',
  keywords: ['overdrive', 'fuzz', 'saturation', 'bitcrusher', 'lofi', 'clip', 'fold', 'crunch'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    type: {
      type: 'enum',
      default: 'soft',
      label: 'Style',
      options: [
        { value: 'soft', label: 'Soft clip' },
        { value: 'hard', label: 'Hard clip' },
        { value: 'fold', label: 'Wave fold' },
        { value: 'crush', label: 'Bit crush' },
      ],
    },
    drive: { type: 'number', default: 12, min: 0, max: 48, step: 0.1, unit: 'db', label: 'Drive' },
    bits: { type: 'number', default: 8, min: 1, max: 16, step: 1, integer: true, label: 'Bits', visibleIf: (p) => p.type === 'crush' },
    downsample: { type: 'number', default: 1, min: 1, max: 32, step: 1, integer: true, label: 'Sample-rate divide', visibleIf: (p) => p.type === 'crush' },
    tone: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Tone', hint: 'Dark to bright.' },
    level: { type: 'number', default: -6, min: -36, max: 12, step: 0.1, unit: 'db', label: 'Output level' },
    mix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${p.type} · ${p.drive.toFixed(0)} dB drive`,
  audio: defineAudio({
    create: () => ({ lp: [0, 0], held: [0, 0], cnt: 0 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const n = io.frames;
      const kind = p.type === 'soft' ? 0 : p.type === 'hard' ? 1 : p.type === 'fold' ? 2 : 3;
      const drive = dbToLin(p.drive);
      const level = dbToLin(p.level);
      const mix = p.mix as number;
      // tone: one-pole low-pass from ~800 Hz (dark) to open (bright)
      const fc = 800 * Math.pow(20, p.tone);
      const a = p.tone >= 0.999 ? 1 : 1 - Math.exp((-2 * Math.PI * fc) / io.sampleRate);
      const levels = Math.pow(2, p.bits - 1);
      const div = p.downsample as number;
      for (let c = 0; c < 2; c++) {
        const inp = src[c];
        const o = io.out.audio[c];
        let cnt = st.cnt;
        for (let i = 0; i < n; i++) {
          const x = inp[i];
          let y: number;
          if (kind === 3) {
            if (cnt === 0) st.held[c] = Math.round(Math.max(-1, Math.min(1, x * drive * 0.25)) * levels) / levels;
            cnt = (cnt + 1) % div;
            y = st.held[c] * 4;
          } else y = shape(x * drive, kind);
          st.lp[c] += (y - st.lp[c]) * a;
          const w = (a >= 1 ? y : st.lp[c]) * level;
          o[i] = x * (1 - mix) + w * mix;
        }
        if (c === 1) st.cnt = cnt;
      }
    },
  }),
});
