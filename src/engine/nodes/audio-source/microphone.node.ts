import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin, onePoleCoef } from '../../audio/dsp';

/**
 * Live microphone. Silent in exports (live sources render as silence).
 * Two outputs: "Audio" is what you hear when "Hear myself" is on; "Tap" is always live, so you can
 * drive effects or the audio-to-MIDI converter without the mic being audible (avoids feedback).
 */
export default defineNode({
  id: 'microphone',
  title: 'Microphone',
  category: 'audio-source',
  description: 'Live input from your microphone. Feed it to effects, or convert it to MIDI to play a synth.',
  keywords: ['mic', 'input', 'voice', 'record', 'live', 'sing'],
  inputs: {},
  outputs: {
    audio: { type: 'audio', label: 'Audio' },
    tap: { type: 'audio', label: 'Silent tap (always live)' },
  },
  params: {
    gain: { type: 'number', default: 0, min: -40, max: 40, step: 0.1, unit: 'db', label: 'Input gain' },
    monitor: { type: 'bool', default: false, label: 'Hear myself', hint: 'Off by default: with speakers, hearing yourself causes feedback. Use headphones.' },
    gate: { type: 'bool', default: false, label: 'Noise gate' },
    gateThreshold: { type: 'number', default: -50, min: -90, max: -10, step: 0.5, unit: 'db', label: 'Gate level', visibleIf: (p) => !!p.gate },
  },
  summary: (p) => `${p.gain >= 0 ? '+' : ''}${p.gain.toFixed(0)} dB${p.gate ? ' · gate' : ''}${p.monitor ? ' · monitor' : ''}`,
  audio: defineAudio({
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
  }),
});
