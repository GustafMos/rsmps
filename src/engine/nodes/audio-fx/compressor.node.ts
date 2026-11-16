import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin, fz } from '../../audio/dsp';

const CTRL = 8;

/**
 * Feed-forward compressor, soft knee, RMS or peak detector, optional sidechain input.
 * Gain reduction is computed on the linked (louder) channel so the stereo image does not shift.
 */
export default defineNode({
  id: 'compressor',
  title: 'Compressor',
  category: 'audio-fx',
  description: 'Evens out loud and quiet parts. Anything over the threshold is turned down by the ratio.',
  keywords: ['dynamics', 'squash', 'level', 'sidechain', 'ducking', 'punch'],
  inputs: {
    audio: { type: 'audio', required: true, label: 'Audio' },
    sidechain: { type: 'audio', label: 'Sidechain (optional)' },
  },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    threshold: { type: 'number', default: -18, min: -60, max: 0, step: 0.1, unit: 'db', label: 'Threshold' },
    ratio: { type: 'number', default: 4, min: 1, max: 20, step: 0.1, label: 'Ratio' },
    attack: { type: 'number', default: 10, min: 0.1, max: 200, step: 0.1, label: 'Attack ms' },
    release: { type: 'number', default: 120, min: 5, max: 2000, step: 1, label: 'Release ms' },
    knee: { type: 'number', default: 6, min: 0, max: 24, step: 0.1, unit: 'db', label: 'Knee' },
    makeup: { type: 'number', default: 0, min: 0, max: 24, step: 0.1, unit: 'db', label: 'Make-up gain' },
    detector: {
      type: 'enum',
      default: 'rms',
      label: 'Level detection',
      options: [
        { value: 'rms', label: 'Average RMS' },
        { value: 'peak', label: 'Peak' },
      ],
    },
    mix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix', hint: 'Parallel compression: how much dry signal is blended back in.' },
  },
  summary: (p) => `${p.threshold} dB · ${p.ratio}:1`,
  audio: defineAudio({
    create: () => ({ ms: 0, peak: 0, grDb: 0, g: 1, mk: 1, first: true }),
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const sc = io.in.sidechain ?? src;
      const n = io.frames;
      const sr = io.sampleRate;
      const p = io.params;
      const T = p.threshold as number;
      const R = p.ratio as number;
      const W = p.knee as number;
      // The detector runs every sample; the gain computer (log/pow) runs every CTRL samples and the gain is
      // interpolated between updates, so attack/release are in CTRL-sample steps (0.17 ms at 48 kHz).
      const atk = 1 - Math.exp(-CTRL / Math.max((p.attack / 1000) * sr, 1));
      const rel = 1 - Math.exp(-CTRL / Math.max((p.release / 1000) * sr, 1));
      const rmsCoef = 1 - Math.exp(-1 / (0.01 * sr));
      const peakRel = Math.exp(-1 / (0.03 * sr));
      const rmsMode = p.detector === 'rms';
      const makeTarget = dbToLin(p.makeup);
      if (st.first) {
        st.mk = makeTarget;
        st.first = false;
      }
      const mk0 = st.mk;
      const mix = p.mix as number;
      const [ol, or] = io.out.audio;
      let g0: number = st.g;
      for (let s0 = 0; s0 < n; s0 += CTRL) {
        const m = Math.min(CTRL, n - s0);
        // detector
        let ms: number = st.ms;
        let pk: number = st.peak;
        for (let i = s0; i < s0 + m; i++) {
          const a = Math.max(Math.abs(sc[0][i]), Math.abs(sc[1][i]));
          ms += (a * a - ms) * rmsCoef;
          pk = a > pk ? a : pk * peakRel;
        }
        st.ms = fz(ms);
        st.peak = fz(pk);
        const levelDb = rmsMode ? 10 * Math.log10(st.ms + 1e-12) : 20 * Math.log10(st.peak + 1e-9);
        const over = levelDb - T;
        let outDb: number;
        if (2 * over < -W) outDb = levelDb;
        else if (2 * Math.abs(over) <= W) outDb = levelDb + ((1 / R - 1) * (over + W / 2) * (over + W / 2)) / (2 * W);
        else outDb = T + over / R;
        const targetGr = outDb - levelDb; // <= 0
        st.grDb += (targetGr - st.grDb) * (targetGr < st.grDb ? atk : rel);
        const g1 = Math.pow(10, st.grDb / 20);
        for (let i = s0; i < s0 + m; i++) {
          const t = (i - s0 + 1) / m;
          const g = (g0 + (g1 - g0) * t) * (mk0 + ((makeTarget - mk0) * (i + 1)) / n);
          const l = src[0][i];
          const r = src[1][i];
          ol[i] = l * (1 - mix) + l * g * mix;
          or[i] = r * (1 - mix) + r * g * mix;
        }
        g0 = g1;
      }
      st.g = g0;
      st.mk = makeTarget;
    },
  }),
});
