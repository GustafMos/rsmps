import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { dbToLin, midiToHz, oscSample } from '../../audio/dsp';
import { fastSin, newPresetCache, presetOptions, presetView } from '../../audio/instrument';

const CTRL = 16;

const PRESETS: Record<string, Record<string, unknown>> = {
  acid: { sawLevel: 1, squareLevel: 0, subLevel: 0, detune: 0, cutoff: 420, resonance: 0.82, envAmount: 3.2, decay: 0.22, glide: 55, drive: 0.35, attack: 1, release: 60 },
  sub: { sawLevel: 0, squareLevel: 0.15, subLevel: 1, detune: 0, cutoff: 380, resonance: 0.1, envAmount: 0.3, decay: 0.4, glide: 0, drive: 0, attack: 3, release: 90 },
  reese: { sawLevel: 1, squareLevel: 0, subLevel: 0.5, detune: 24, cutoff: 650, resonance: 0.25, envAmount: 0.8, decay: 0.6, glide: 20, drive: 0.2, attack: 6, release: 180 },
};

/** Monophonic bass: saw/square/sub, 24 dB resonant filter with envelope, glide, accent and drive. Overlapping notes slide (legato). */
export default defineNode({
  id: 'bass',
  title: 'Bass',
  category: 'synth',
  description: 'A mono bass synth: acid squelch, deep sub, or a growling reese. Overlap notes to slide between them.',
  keywords: ['303', 'acid', 'sub', 'reese', 'mono', 'bassline', 'low', 'squelch', 'slide', 'dnb', 'techno'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    preset: { type: 'enum', default: 'acid', label: 'Sound', options: presetOptions({ acid: 'Acid', sub: 'Sub', reese: 'Reese' }) },
    sawLevel: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Saw', group: 'Oscillators' },
    squareLevel: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Square', group: 'Oscillators' },
    subLevel: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Sub level', hint: 'One octave down.', group: 'Oscillators' },
    detune: { type: 'number', default: 0, min: 0, max: 60, step: 0.5, label: 'Saw 2 detune', hint: 'In cents.', group: 'Oscillators' },
    cutoff: { type: 'number', default: 420, min: 30, max: 8000, step: 1, unit: 'hz', label: 'Cutoff', group: 'Filter' },
    resonance: { type: 'number', default: 0.82, min: 0, max: 1, step: 0.01, label: 'Resonance', group: 'Filter' },
    envAmount: { type: 'number', default: 3.2, min: 0, max: 6, step: 0.05, label: 'Env octaves', hint: 'Envelope amount, in octaves.', group: 'Filter' },
    decay: { type: 'number', default: 0.22, min: 0.02, max: 2, step: 0.01, unit: 's', label: 'Envelope decay', group: 'Filter' },
    accent: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Accent', hint: 'Hard notes get louder and snappier.', group: 'Filter' },
    glide: { type: 'number', default: 55, min: 0, max: 500, step: 1, label: 'Slide ms', group: 'Playing' },
    drive: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Drive', group: 'Playing' },
    attack: { type: 'number', default: 1, min: 0.5, max: 500, step: 0.5, label: 'Attack ms', group: 'Playing' },
    release: { type: 'number', default: 60, min: 5, max: 3000, step: 1, label: 'Release ms', group: 'Playing' },
    gain: { type: 'number', default: -8, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Playing' },
  },
  summary: (p) => (p.preset !== 'custom' ? String(p.preset) : 'custom bass'),
  audio: defineAudio({
    create: () => ({
      stack: new Int16Array(32), // held notes, oldest first
      vel: new Float64Array(32),
      nStack: 0,
      stage: 0, // 0 idle 1 attack 2 hold 3 release
      env: 0,
      fenv: 0,
      accent: 0,
      freq: 55,
      target: 55,
      ph: new Float64Array(4), // saw A, saw B, square, sub
      s: new Float64Array(4), // two SVF stages: ic1, ic2 each
      c: new Float64Array(4), // a1, a2, a3, k
      ctrl: 0,
      presets: newPresetCache(),
    }),
    process(st, io) {
      const p = presetView(st.presets, io.params, PRESETS);
      const n = io.frames;
      const sr = io.sampleRate;
      const [ol, or] = io.out.audio;
      const events: MidiEvent[] = io.midiIn.midi;
      let ei = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) onEvent(st, events[ei++], p);
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        if (st.stage !== 0) render(st, p, sr, ol, or, cursor, end);
        cursor = end;
      }
    },
    reset(st) {
      st.stage = 0;
      st.env = 0;
      st.nStack = 0;
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onEvent(st: any, ev: MidiEvent, p: any): void {
  if (ev.type === 'on') {
    const legato = st.nStack > 0 && st.stage !== 0 && st.stage !== 3;
    if (st.nStack < 32) {
      st.stack[st.nStack] = ev.note;
      st.vel[st.nStack++] = ev.velocity;
    }
    st.target = midiToHz(ev.note);
    if (!legato || p.glide <= 0) {
      if (st.stage === 0 || p.glide <= 0) st.freq = st.target;
      st.fenv = 1; // retrigger the filter sweep
      st.accent = ev.velocity > 0.85 ? p.accent : 0;
      st.stage = 1;
    } else {
      st.accent = Math.max(st.accent, ev.velocity > 0.85 ? p.accent : 0);
    }
  } else if (ev.type === 'off') {
    let j = 0;
    for (let i = 0; i < st.nStack; i++) {
      if (st.stack[i] !== ev.note) {
        st.stack[j] = st.stack[i];
        st.vel[j++] = st.vel[i];
      }
    }
    const removed = j !== st.nStack;
    st.nStack = j;
    if (removed) {
      if (j === 0) {
        if (st.stage !== 0) st.stage = 3;
      } else st.target = midiToHz(st.stack[j - 1]); // slide back to the previous held note
    }
  } else if (ev.type === 'cc' && (ev.note === 123 || ev.note === 120)) {
    st.nStack = 0;
    if (st.stage !== 0) st.stage = 3;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  const gain = dbToLin(p.gain) * 0.5;
  const atkInc = 1 / Math.max(1, (p.attack / 1000) * sr);
  const relC = 1 - Math.exp(-4.6 / Math.max(1, (p.release / 1000) * sr));
  const glideC = p.glide > 0 ? 1 - Math.exp(-4.6 / Math.max(1, (p.glide / 1000) * sr)) : 1;
  const k = 2 - 1.95 * p.resonance;
  const detuneRatio = Math.pow(2, p.detune / 1200);
  const drive = 1 + p.drive * 5;
  const driveNorm = 1 / Math.tanh(drive);
  const decC = 1 - Math.exp(-4.6 / Math.max(1, p.decay * (1 - 0.5 * st.accent) * sr));
  for (let i = s0; i < s1; i++) {
    st.freq += (st.target - st.freq) * glideC;
    st.fenv -= st.fenv * decC;
    if (st.stage === 1) {
      st.env += atkInc;
      if (st.env >= 1) {
        st.env = 1;
        st.stage = 2;
      }
    } else if (st.stage === 3) {
      st.env -= st.env * relC;
      if (st.env < 1e-4) {
        st.env = 0;
        st.stage = 0;
        return;
      }
    }
    if (st.ctrl === 0) {
      st.ctrl = CTRL;
      const oct = p.envAmount * (1 + 0.4 * st.accent) * st.fenv;
      const fc = Math.min(sr * 0.45, Math.max(30, p.cutoff * Math.pow(2, oct)));
      const g = Math.tan((Math.PI * fc) / sr);
      const a1 = 1 / (1 + g * (g + k));
      st.c[0] = a1;
      st.c[1] = g * a1;
      st.c[2] = g * g * a1;
    }
    st.ctrl--;
    const dt = st.freq / sr;
    const dtB = dt * detuneRatio;
    let x = 0;
    if (p.sawLevel > 0) {
      st.ph[0] = (st.ph[0] + dt) % 1;
      x += oscSample(2, st.ph[0], dt) * p.sawLevel;
      if (p.detune > 0) {
        st.ph[1] = (st.ph[1] + dtB) % 1;
        x += oscSample(2, st.ph[1], dtB) * p.sawLevel;
      }
    }
    if (p.squareLevel > 0) {
      st.ph[2] = (st.ph[2] + dt) % 1;
      x += oscSample(3, st.ph[2], dt) * p.squareLevel;
    }
    if (p.subLevel > 0) {
      st.ph[3] = (st.ph[3] + dt * 0.5) % 1;
      x += fastSin(st.ph[3]) * p.subLevel * 1.2;
    }
    x *= 0.6;
    // two cascaded TPT state-variable low-pass stages = 24 dB/oct
    for (let s = 0; s < 2; s++) {
      const b = s * 2;
      const v3 = x - st.s[b + 1];
      const v1 = st.c[0] * st.s[b] + st.c[1] * v3;
      const v2 = st.s[b + 1] + st.c[1] * st.s[b] + st.c[2] * v3;
      st.s[b] = 2 * v1 - st.s[b];
      st.s[b + 1] = 2 * v2 - st.s[b + 1];
      x = v2;
    }
    if (p.drive > 0) x = Math.tanh(x * drive) * driveNorm;
    const o = x * st.env * gain * (1 + 0.25 * st.accent);
    ol[i] += o;
    or[i] += o;
  }
}
