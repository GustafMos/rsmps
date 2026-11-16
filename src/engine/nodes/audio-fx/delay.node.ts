import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { DelayLine, fz } from '../../audio/dsp';

const SYNC_BEATS: Record<string, number> = { '1/4': 1, '1/8': 0.5, '1/8d': 0.75, '1/16': 0.25, '1/2': 2 };

/** Echo with feedback, damping (each repeat gets darker), optional ping-pong and tempo sync. */
export default defineNode({
  id: 'delay',
  title: 'Audio Echo',
  category: 'audio-fx',
  description: 'Audio echo: repeats the sound after a short time, fading away. Can bounce between left and right.',
  keywords: ['delay', 'repeat', 'ping pong', 'tape', 'slapback', 'tempo', 'echo'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    sync: {
      type: 'enum',
      default: 'off',
      label: 'Time from tempo',
      options: [
        { value: 'off', label: 'Milliseconds' },
        { value: '1/2', label: 'Half note' },
        { value: '1/4', label: 'Quarter note' },
        { value: '1/8d', label: 'Dotted eighth' },
        { value: '1/8', label: 'Eighth note' },
        { value: '1/16', label: 'Sixteenth note' },
      ],
    },
    time: { type: 'number', default: 350, min: 1, max: 2000, step: 1, label: 'Time ms', visibleIf: (p) => p.sync === 'off' },
    bpm: { type: 'number', default: 120, min: 40, max: 240, step: 0.1, label: 'Tempo BPM', visibleIf: (p) => p.sync !== 'off' },
    feedback: { type: 'number', default: 0.4, min: 0, max: 0.95, step: 0.01, label: 'Repeats' },
    damping: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Darken repeats' },
    pingPong: { type: 'bool', default: false, label: 'Ping-pong' },
    mix: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => (p.sync === 'off' ? `${Math.round(p.time)} ms` : `${p.sync} @ ${Math.round(p.bpm)} bpm`) + ` · ${Math.round(p.feedback * 100)}% repeats`,
  audio: defineAudio({
    create: (ctx) => {
      const max = Math.ceil(ctx.sampleRate * 3);
      return { l: new DelayLine(max), r: new DelayLine(max), d: -1, lpL: 0, lpR: 0 };
    },
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const ms = p.sync === 'off' ? p.time : (60000 / p.bpm) * SYNC_BEATS[p.sync];
      const target = Math.min(Math.max(1, (ms / 1000) * sr), sr * 2.9);
      if (st.d < 0) st.d = target;
      const fb = p.feedback as number;
      const damp = 1 - (p.damping as number) * 0.95;
      const mix = p.mix as number;
      const pp = p.pingPong as boolean;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        const diff = target - st.d;
        // changing the time glides (tape-style, at most +-10% pitch) instead of clicking
        st.d = Math.abs(diff) < 0.01 ? target : st.d + Math.max(-0.1, Math.min(0.1, diff * 0.001));
        const d = Math.max(1, st.d) - 1;
        const yl = st.l.read(d);
        const yr = st.r.read(d);
        st.lpL += (yl - st.lpL) * damp;
        st.lpR += (yr - st.lpR) * damp;
        st.lpL = fz(st.lpL);
        st.lpR = fz(st.lpR);
        const xl = src[0][i];
        const xr = src[1][i];
        if (pp) {
          st.l.write(0.5 * (xl + xr) + fb * st.lpR);
          st.r.write(fb * st.lpL);
        } else {
          st.l.write(xl + fb * st.lpL);
          st.r.write(xr + fb * st.lpR);
        }
        ol[i] = xl * (1 - mix) + yl * mix;
        or[i] = xr * (1 - mix) + yr * mix;
      }
    },
  }),
});
