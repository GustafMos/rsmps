import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { DelayLine } from '../../audio/dsp';

// Freeverb tunings (samples at 44.1 kHz): 8 parallel damped combs feeding 4 series all-passes per channel.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];
const SPREAD = 23;
const MAX_SCALE = 1.6;

/** Algorithmic reverb (Freeverb topology) with RT60-based decay, size, damping and pre-delay. */
export default defineNode({
  id: 'reverb',
  title: 'Reverb',
  category: 'audio-fx',
  description: 'Makes the sound seem to be in a room or hall.',
  keywords: ['room', 'hall', 'space', 'ambience', 'plate', 'tail', 'freeverb'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    size: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Room size' },
    decay: { type: 'number', default: 2.5, min: 0.1, max: 20, step: 0.1, unit: 's', label: 'Decay time' },
    damping: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Damping', hint: 'Higher = darker tail.' },
    preDelay: { type: 'number', default: 15, min: 0, max: 250, step: 1, label: 'Pre-delay ms' },
    width: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Stereo width' },
    mix: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${p.decay.toFixed(1)} s · ${Math.round(p.mix * 100)}% wet`,
  audio: defineAudio({
    create: (ctx) => {
      const k = ctx.sampleRate / 44100;
      // 16 combs (8 left, 8 right) and 8 all-passes (4 left, 4 right). Each lives in its own power-of-two slice of one
      // flat typed array and all share one write index: no per-line bookkeeping, wrap-around is a bit mask.
      const combBase = [...COMBS.map((c) => Math.round(c * k)), ...COMBS.map((c) => Math.round((c + SPREAD) * k))];
      let capC = 256;
      while (capC < Math.max(...combBase) * MAX_SCALE + 4) capC <<= 1;
      const apLen = [...ALLPASS.map((a) => Math.round(a * k)), ...ALLPASS.map((a) => Math.round((a + SPREAD) * k))];
      let capA = 64;
      while (capA < Math.max(...apLen) + 4) capA <<= 1;
      return {
        capC,
        capA,
        cBuf: new Float32Array(capC * 16),
        cBase: Int32Array.from(combBase),
        cLen: Int32Array.from(combBase),
        cStore: new Float64Array(16),
        cFb: new Float64Array(16),
        aBuf: new Float32Array(capA * 8),
        aLen: Int32Array.from(apLen),
        wc: 0,
        wa: 0,
        pre: new DelayLine(ctx.sampleRate * 0.26),
        size: -1,
        decay: -1,
        norm: 0.1,
      };
    },
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const cBuf: Float32Array = st.cBuf;
      const cLen: Int32Array = st.cLen;
      const cStore: Float64Array = st.cStore;
      const cFb: Float64Array = st.cFb;
      const aBuf: Float32Array = st.aBuf;
      const aLen: Int32Array = st.aLen;
      const capC: number = st.capC;
      const capA: number = st.capA;
      const maskC = capC - 1;
      const maskA = capA - 1;
      const scale = 0.5 + p.size; // 0.5 .. 1.5
      if (scale !== st.size || p.decay !== st.decay) {
        st.size = scale;
        st.decay = p.decay;
        let fbSum = 0;
        for (let c = 0; c < 16; c++) {
          cLen[c] = Math.max(8, Math.min(capC - 2, Math.round(st.cBase[c] * scale)));
          // feedback per comb so that the tail falls 60 dB in `decay` seconds
          cFb[c] = Math.pow(10, (-3 * cLen[c]) / (sr * p.decay));
          fbSum += cFb[c];
        }
        const fbAvg = fbSum / 16;
        // calibrated: sustained noise in -> roughly unity level out, whatever the decay
        st.norm = Math.sqrt(Math.max(1e-4, 1 - fbAvg * fbAvg) / COMBS.length) * 0.17;
      }
      // Denormals cannot build up here: every recirculating value is rounded into a Float32Array, which flushes to zero.
      const damp = p.damping * 0.8;
      const keep = 1 - damp;
      const preD = Math.max(1, (p.preDelay / 1000) * sr);
      const mix = p.mix as number;
      const wet1 = (1 + p.width) / 2;
      const wet2 = (1 - p.width) / 2;
      const norm = st.norm as number;
      const [ol, or] = io.out.audio;
      let wc: number = st.wc;
      let wa: number = st.wa;
      for (let i = 0; i < n; i++) {
        const xl = src[0][i];
        const xr = src[1][i];
        st.pre.write((xl + xr) * 0.5);
        const x = st.pre.read(preD - 1) * norm;
        let sl = 0;
        let sr2 = 0;
        for (let c = 0; c < 8; c++) {
          const base = c * capC;
          const y = cBuf[base + ((wc - cLen[c]) & maskC)];
          const store = y * keep + cStore[c] * damp;
          cStore[c] = store;
          cBuf[base + wc] = x + store * cFb[c];
          sl += y;
        }
        for (let c = 8; c < 16; c++) {
          const base = c * capC;
          const y = cBuf[base + ((wc - cLen[c]) & maskC)];
          const store = y * keep + cStore[c] * damp;
          cStore[c] = store;
          cBuf[base + wc] = x + store * cFb[c];
          sr2 += y;
        }
        wc = (wc + 1) & maskC;
        for (let a = 0; a < 4; a++) {
          const baseL = a * capA;
          let b = aBuf[baseL + ((wa - aLen[a]) & maskA)];
          aBuf[baseL + wa] = sl + b * 0.5;
          sl = b - sl;
          const baseR = (a + 4) * capA;
          b = aBuf[baseR + ((wa - aLen[a + 4]) & maskA)];
          aBuf[baseR + wa] = sr2 + b * 0.5;
          sr2 = b - sr2;
        }
        wa = (wa + 1) & maskA;
        ol[i] = xl * (1 - mix) + (sl * wet1 + sr2 * wet2) * mix;
        or[i] = xr * (1 - mix) + (sr2 * wet1 + sl * wet2) * mix;
      }
      st.wc = wc;
      st.wa = wa;
    },
  }),
});
