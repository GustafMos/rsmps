import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin, fz, makeRng, midiToHz, rand01 } from '../../audio/dsp';

const VOICES = 8;

/** Karplus-Strong plucked string: a noise burst circulating in a damped delay loop. */
export default defineNode({
  id: 'pluck',
  title: 'Plucked String',
  category: 'synth',
  description: 'A guitar-like plucked string instrument. Connect MIDI to it.',
  keywords: ['guitar', 'karplus', 'string', 'harp', 'pizzicato', 'instrument'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    decay: { type: 'number', default: 2.5, min: 0.1, max: 12, step: 0.1, unit: 's', label: 'Ring time' },
    brightness: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Brightness' },
    damp: { type: 'bool', default: true, label: 'Damp on release', hint: 'Mutes the string when the key is released.' },
    gain: { type: 'number', default: -8, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume' },
  },
  summary: (p) => `ring ${p.decay.toFixed(1)} s`,
  audio: defineAudio({
    create: (ctx) => ({
      bufs: Array.from({ length: VOICES }, () => new Float32Array(Math.ceil(ctx.sampleRate / 20) + 8)),
      w: new Int32Array(VOICES),
      period: new Float64Array(VOICES),
      lp: new Float64Array(VOICES),
      fb: new Float64Array(VOICES),
      damp: new Float64Array(VOICES),
      amp: new Float64Array(VOICES),
      note: new Int16Array(VOICES).fill(-1),
      active: new Uint8Array(VOICES),
      muted: new Uint8Array(VOICES),
      age: new Float64Array(VOICES),
      clock: 0,
      rng: makeRng(ctx.nodeId),
    }),
    process(st, io) {
      const p = io.params;
      const sr = io.sampleRate;
      const n = io.frames;
      const [ol, or] = io.out.audio;
      const events = io.midiIn.midi;
      const gain = dbToLin(p.gain);
      let ei = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) {
          const ev = events[ei++];
          if (ev.type === 'on') {
            let v = -1;
            for (let i = 0; i < VOICES; i++) if (!st.active[i]) { v = i; break; }
            if (v < 0) {
              let oldest = Infinity;
              for (let i = 0; i < VOICES; i++) if (st.age[i] < oldest) { oldest = st.age[i]; v = i; }
            }
            const d = 0.15 + 0.8 * (1 - p.brightness) * 0.6; // loop low-pass: brighter = less smoothing
            const f = midiToHz(ev.note);
            const period = Math.max(4, sr / f - d / (1 - d));
            const buf: Float32Array = st.bufs[v];
            buf.fill(0);
            const len = Math.min(buf.length - 2, Math.ceil(period) + 1);
            // excitation: noise, softened for dark settings
            let prev = 0;
            const soft = 0.9 * (1 - p.brightness);
            for (let k = 0; k < len; k++) {
              const x = rand01(st.rng) * 2 - 1;
              prev = x * (1 - soft) + prev * soft;
              buf[k] = prev;
            }
            st.w[v] = len;
            st.period[v] = period;
            st.lp[v] = 0;
            st.damp[v] = d;
            st.fb[v] = Math.pow(10, (-3 * (period / sr)) / p.decay);
            st.amp[v] = ev.velocity * 1.6;
            st.note[v] = ev.note;
            st.active[v] = 1;
            st.muted[v] = 0;
            st.age[v] = st.clock++;
          } else if (ev.type === 'off' && p.damp) {
            for (let i = 0; i < VOICES; i++) if (st.active[i] && st.note[i] === ev.note) st.muted[i] = 1;
          }
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        for (let v = 0; v < VOICES; v++) {
          if (!st.active[v]) continue;
          const buf: Float32Array = st.bufs[v];
          const size = buf.length;
          const d = st.damp[v];
          const period = st.period[v];
          const fb = st.muted[v] ? Math.min(st.fb[v], 0.9) * 0.6 : st.fb[v];
          let w = st.w[v];
          let lp = st.lp[v];
          const amp = st.amp[v] * gain;
          let energy = 0;
          for (let i = cursor; i < end; i++) {
            let rp = w - period;
            if (rp < 0) rp += size;
            const i0 = Math.floor(rp);
            const fr = rp - i0;
            const i1 = i0 + 1 >= size ? 0 : i0 + 1;
            const y = buf[i0] * (1 - fr) + buf[i1] * fr;
            lp = fz(y * (1 - d) + lp * d);
            buf[w] = lp * fb;
            if (++w >= size) w = 0;
            const o = y * amp;
            ol[i] += o;
            or[i] += o;
            energy += y * y;
          }
          st.w[v] = w;
          st.lp[v] = lp;
          if (energy / Math.max(1, end - cursor) < 1e-10) st.active[v] = 0;
        }
        cursor = end;
      }
    },
    reset(st) {
      st.active.fill(0);
    },
  }),
});
