import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { DelayLine, TAU } from '../../audio/dsp';

const VOICES = 3;
const TABLE = new Float32Array(2049);
for (let i = 0; i <= 2048; i++) TABLE[i] = Math.sin((TAU * i) / 2048);
/** Sine LFO by table lookup with linear interpolation (phase in cycles, any real number). */
function sinLfo(ph: number): number {
  const x = (ph - Math.floor(ph)) * 2048;
  const i = x | 0;
  return TABLE[i] + (TABLE[i + 1] - TABLE[i]) * (x - i);
}
// Each voice sits at pan -0.7, 0, +0.7: how much of its left/right read goes to each output.
const PAN = [-0.7, 0, 0.7];
const LL = PAN.map((p) => 1 - Math.max(0, p));
const RL = PAN.map((p) => Math.max(0, -p) * 0.5);
const RR = PAN.map((p) => 1 + Math.min(0, p));
const LR = PAN.map((p) => Math.max(0, p) * 0.5);

/** Thickens a sound with slightly detuned, slowly moving copies spread across the stereo field. */
export default defineNode({
  id: 'chorus',
  title: 'Chorus',
  category: 'audio-fx',
  description: 'Makes one sound seem like several playing together: wider and richer.',
  keywords: ['ensemble', 'thicken', 'detune', 'wide', 'modulation', 'double'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    rate: { type: 'number', default: 0.8, min: 0.05, max: 8, step: 0.01, unit: 'hz', label: 'Speed' },
    depth: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Depth' },
    delay: { type: 'number', default: 18, min: 5, max: 40, step: 0.1, label: 'Base delay ms' },
    mix: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${p.rate.toFixed(1)} Hz · depth ${Math.round(p.depth * 100)}%`,
  audio: defineAudio({
    create: (ctx) => ({ l: new DelayLine(ctx.sampleRate * 0.06), r: new DelayLine(ctx.sampleRate * 0.06), phase: 0 }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const base = (p.delay / 1000) * sr;
      const depth = (p.depth * 0.004 + 0.0002) * sr; // up to ~4 ms of swing
      const inc = p.rate / sr;
      const mix = p.mix as number;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        st.l.write(src[0][i]);
        st.r.write(src[1][i]);
        let wl = 0;
        let wr = 0;
        for (let v = 0; v < VOICES; v++) {
          const ph = st.phase + v / VOICES;
          const d = base * (1 + 0.06 * v) + depth * sinLfo(ph);
          const yl = st.l.read(d);
          const yr = st.r.read(d);
          const a = yl * LL[v] + yr * RL[v];
          const b = yr * RR[v] + yl * LR[v];
          wl += a / VOICES;
          wr += b / VOICES;
        }
        st.phase += inc;
        if (st.phase >= 1) st.phase -= 1;
        ol[i] = src[0][i] * (1 - mix * 0.5) + wl * mix * 1.2;
        or[i] = src[1][i] * (1 - mix * 0.5) + wr * mix * 1.2;
      }
    },
  }),
});
