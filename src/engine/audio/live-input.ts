/**
 * Kernel shared by the live audio sources (Microphone, Phone Camera): input gain, optional noise gate, and two outputs:
 * `audio` (audible only when `monitor` is on) and `tap` (always live, silent to the speakers: wire it to Audio to MIDI,
 * Sound to Numbers or a Timeline's record input). The host provides the signal as `io.live.mic` (silence offline).
 * Params it reads: gain (dB), monitor, gate, gateThreshold (dB).
 */
import { dbToLin, onePoleCoef } from './dsp';
import { defineAudio } from './types';

export const liveInputKernel = defineAudio({
  create: (ctx) => ({
    g: 1,
    env: 0,
    open: 1,
    envCoef: onePoleCoef(0.01, ctx.sampleRate),
    gateCoef: onePoleCoef(0.005, ctx.sampleRate),
    relCoef: onePoleCoef(0.08, ctx.sampleRate),
  }),
  process(st, io) {
    const mic = io.live.mic;
    if (!mic) return;
    const n = io.frames;
    const target = dbToLin(io.params.gain);
    const g0 = st.g;
    const thr = dbToLin(io.params.gateThreshold);
    const gate = io.params.gate as boolean;
    const monitor = io.params.monitor as boolean;
    const [tl, tr] = io.out.tap;
    const [ol, or] = io.out.audio;
    for (let i = 0; i < n; i++) {
      const g = g0 + ((target - g0) * (i + 1)) / n;
      let l = mic[0][i] * g;
      let r = mic[1][i] * g;
      if (gate) {
        const a = Math.max(Math.abs(l), Math.abs(r));
        st.env += (a - st.env) * st.envCoef;
        const want = st.env > thr ? 1 : 0;
        st.open += (want - st.open) * (want > st.open ? st.gateCoef : st.relCoef);
        l *= st.open;
        r *= st.open;
      }
      tl[i] = l;
      tr[i] = r;
      if (monitor) {
        ol[i] = l;
        or[i] = r;
      }
    }
    st.g = target;
  },
});
