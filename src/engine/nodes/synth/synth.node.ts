import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { WAVE, dbToLin, makeRng, midiToHz, oscSample, panGains, rand01 } from '../../audio/dsp';

const MAXV = 16;
const MAXU = 5;
const CTRL = 16; // filter coefficients are refreshed every 16 samples

const WAVES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'saw', label: 'Saw' },
  { value: 'square', label: 'Square' },
  { value: 'pulse', label: 'Pulse' },
] as const;

/** Polyphonic subtractive synthesiser. MIDI in, audio out. */
export default defineNode({
  id: 'synth',
  title: 'Synth',
  category: 'synth',
  description: 'A playable synthesiser: two oscillators, a resonant filter, an envelope and thick unison voices. Connect MIDI to it.',
  keywords: ['synthesizer', 'subtractive', 'poly', 'pad', 'lead', 'bass', 'oscillator', 'adsr', 'supersaw', 'instrument'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    wave1: { type: 'enum', default: 'saw', options: WAVES, label: 'Wave', group: 'Oscillator 1' },
    wave2: { type: 'enum', default: 'saw', options: WAVES, label: 'Wave', group: 'Oscillator 2' },
    semi2: { type: 'number', default: 0, min: -24, max: 24, step: 1, integer: true, unit: 'st', label: 'Pitch offset', group: 'Oscillator 2' },
    detune2: { type: 'number', default: 8, min: -100, max: 100, step: 0.1, label: 'Detune (cents)', group: 'Oscillator 2' },
    mix: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Oscillator 1 ... 2', group: 'Oscillator 2' },
    pulseWidth: { type: 'number', default: 0.5, min: 0.05, max: 0.95, step: 0.01, label: 'Pulse width', group: 'Oscillator 1' },
    noise: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Noise', group: 'Oscillator 1' },
    unison: { type: 'number', default: 1, min: 1, max: MAXU, step: 1, integer: true, label: 'Unison voices', group: 'Thickness' },
    unisonDetune: { type: 'number', default: 14, min: 0, max: 60, step: 0.1, label: 'Unison detune (cents)', group: 'Thickness', visibleIf: (p) => (p.unison as number) > 1 },
    stereo: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Stereo spread', group: 'Thickness', visibleIf: (p) => (p.unison as number) > 1 },
    attack: { type: 'number', default: 0.01, min: 0.001, max: 5, step: 0.001, unit: 's', label: 'Attack', group: 'Volume envelope' },
    decay: { type: 'number', default: 0.3, min: 0.001, max: 5, step: 0.001, unit: 's', label: 'Decay', group: 'Volume envelope' },
    sustain: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Sustain', group: 'Volume envelope' },
    release: { type: 'number', default: 0.3, min: 0.001, max: 10, step: 0.001, unit: 's', label: 'Release', group: 'Volume envelope' },
    cutoff: { type: 'number', default: 5000, min: 20, max: 20000, step: 1, unit: 'hz', label: 'Cutoff', group: 'Filter' },
    resonance: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Resonance', group: 'Filter' },
    envAmount: { type: 'number', default: 0, min: -6, max: 6, step: 0.01, label: 'Envelope amount (octaves)', group: 'Filter' },
    filterDecay: { type: 'number', default: 0.4, min: 0.001, max: 5, step: 0.001, unit: 's', label: 'Filter decay', group: 'Filter' },
    filterSustain: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Filter sustain', group: 'Filter' },
    glide: { type: 'number', default: 0, min: 0, max: 2, step: 0.001, unit: 's', label: 'Glide', group: 'Playing' },
    voices: { type: 'number', default: 8, min: 1, max: MAXV, step: 1, integer: true, label: 'Max notes at once', group: 'Playing' },
    bendRange: { type: 'number', default: 2, min: 0, max: 24, step: 1, integer: true, unit: 'st', label: 'Pitch bend range', group: 'Playing' },
    gain: { type: 'number', default: -9, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Playing' },
  },
  summary: (p) => `${p.wave1}${p.mix > 0 ? '+' + p.wave2 : ''}${p.unison > 1 ? ` x${p.unison}` : ''} · ${p.voices} voices`,
  audio: defineAudio({
    create: (ctx) => ({
      sr: ctx.sampleRate,
      rng: makeRng(ctx.nodeId),
      note: new Int16Array(MAXV).fill(-1),
      stage: new Int8Array(MAXV), // 0 idle, 1 attack, 2 decay/sustain, 3 release
      held: new Uint8Array(MAXV), // key still down
      vel: new Float64Array(MAXV),
      env: new Float64Array(MAXV),
      fenv: new Float64Array(MAXV),
      freq: new Float64Array(MAXV),
      target: new Float64Array(MAXV),
      age: new Float64Array(MAXV),
      ph1: new Float64Array(MAXV * MAXU),
      ph2: new Float64Array(MAXV * MAXU),
      f: new Float64Array(MAXV * 4), // SVF states: L ic1, L ic2, R ic1, R ic2
      c: new Float64Array(MAXV * 4), // SVF coefficients: a1, a2, a3, k
      ctrl: new Int32Array(MAXV),
      lastFreq: 440,
      bend: 1,
      pedal: false,
      clock: 0,
      panL: new Float64Array(MAXU),
      panR: new Float64Array(MAXU),
      uRatio: new Float64Array(MAXU),
      wave1: 2,
      wave2: 2,
    }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const [ol, or] = io.out.audio;
      const events: MidiEvent[] = io.midiIn.midi;
      const U = p.unison as number;
      const uniDet = p.unisonDetune as number;
      for (let u = 0; u < U; u++) {
        const pos = U === 1 ? 0 : (2 * u) / (U - 1) - 1;
        const [gl, gr] = panGains(pos * p.stereo);
        st.panL[u] = gl * Math.SQRT2;
        st.panR[u] = gr * Math.SQRT2;
        st.uRatio[u] = Math.pow(2, (pos * uniDet) / 1200);
      }
      st.wave1 = WAVE[p.wave1 as keyof typeof WAVE];
      st.wave2 = WAVE[p.wave2 as keyof typeof WAVE];
      let cursor = 0;
      let ei = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) {
          handleEvent(st, events[ei], p);
          ei++;
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        render(st, io, ol, or, cursor, end, U);
        cursor = end;
      }
      while (ei < events.length) handleEvent(st, events[ei++], p);
    },
    reset(st) {
      st.stage.fill(0);
      st.env.fill(0);
      st.note.fill(-1);
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleEvent(st: any, ev: MidiEvent, p: Record<string, any>): void {
  if (ev.type === 'on') {
    const maxV = Math.min(MAXV, p.voices as number);
    let v = -1;
    for (let i = 0; i < maxV; i++) if (st.note[i] === ev.note && st.stage[i] !== 0) v = i; // retrigger
    if (v < 0) for (let i = 0; i < maxV; i++) if (st.stage[i] === 0) { v = i; break; }
    if (v < 0) {
      // steal: quietest releasing voice, else oldest
      let best = Infinity;
      for (let i = 0; i < maxV; i++) {
        const score = st.stage[i] === 3 ? st.env[i] - 10 : -st.age[i] + 1e9;
        if (score < best) {
          best = score;
          v = i;
        }
      }
    }
    if (v < 0) v = 0;
    const idle = st.stage[v] === 0;
    st.note[v] = ev.note;
    st.vel[v] = Math.max(0.02, ev.velocity);
    st.held[v] = 1;
    st.age[v] = st.clock++;
    st.target[v] = midiToHz(ev.note);
    st.freq[v] = p.glide > 0 && st.lastFreq > 0 ? st.lastFreq : st.target[v];
    st.lastFreq = st.target[v];
    st.stage[v] = 1;
    if (idle) {
      st.env[v] = 0;
      st.fenv[v] = 0;
      for (let u = 0; u < MAXU; u++) {
        st.ph1[v * MAXU + u] = u / MAXU;
        st.ph2[v * MAXU + u] = u / MAXU + 0.5 / MAXU;
      }
      for (let k = 0; k < 4; k++) st.f[v * 4 + k] = 0;
      st.ctrl[v] = 0;
    }
  } else if (ev.type === 'off') {
    for (let i = 0; i < MAXV; i++) {
      if (st.note[i] === ev.note && st.stage[i] !== 0 && st.stage[i] !== 3 && st.held[i]) {
        st.held[i] = 0;
        if (!st.pedal) st.stage[i] = 3;
      }
    }
  } else if (ev.type === 'bend') {
    st.bend = Math.pow(2, (ev.value * p.bendRange) / 12);
  } else if (ev.type === 'cc') {
    if (ev.note === 64) {
      const down = ev.value >= 0.5;
      if (!down && st.pedal) for (let i = 0; i < MAXV; i++) if (!st.held[i] && st.stage[i] !== 0 && st.stage[i] !== 3) st.stage[i] = 3;
      st.pedal = down;
    } else if (ev.note === 123 || ev.note === 120) {
      for (let i = 0; i < MAXV; i++) if (st.stage[i] !== 0) { st.stage[i] = 3; st.held[i] = 0; }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, io: any, ol: Float32Array, or: Float32Array, s0: number, s1: number, U: number): void {
  const p = io.params;
  const sr = st.sr as number;
  const gain = dbToLin(p.gain) / Math.sqrt(U);
  const a1 = 1 - p.mix;
  const a2 = p.mix as number;
  const semi = Math.pow(2, p.semi2 / 12) * Math.pow(2, p.detune2 / 1200);
  const w1 = st.wave1 as number;
  const w2 = st.wave2 as number;
  const pw = p.pulseWidth as number;
  const noiseAmt = p.noise as number;
  const atkInc = 1 / Math.max(1, p.attack * sr);
  const decC = 1 - Math.exp(-4.6 / Math.max(1, p.decay * sr));
  const relC = 1 - Math.exp(-4.6 / Math.max(1, p.release * sr));
  const fdecC = 1 - Math.exp(-4.6 / Math.max(1, p.filterDecay * sr));
  const sus = p.sustain as number;
  const fsus = p.filterSustain as number;
  const glideC = p.glide > 0 ? 1 - Math.exp(-1 / Math.max(1, p.glide * sr * 0.3)) : 1;
  const kRes = 2 - 1.96 * p.resonance;
  const cutoff = p.cutoff as number;
  const envAmt = p.envAmount as number;
  const bend = st.bend as number;
  const uRatio = st.uRatio as Float64Array;
  const panL = st.panL as Float64Array;
  const panR = st.panR as Float64Array;
  for (let v = 0; v < MAXV; v++) {
    if (st.stage[v] === 0) continue;
    const ph1: Float64Array = st.ph1;
    const ph2: Float64Array = st.ph2;
    const f: Float64Array = st.f;
    const c: Float64Array = st.c;
    let freq = st.freq[v];
    const target = st.target[v];
    let env = st.env[v];
    let fenv = st.fenv[v];
    let stage = st.stage[v];
    const vel = st.vel[v];
    const fi = v * 4;
    let ctrl = st.ctrl[v];
    for (let i = s0; i < s1; i++) {
      freq += (target - freq) * glideC;
      // envelopes
      if (stage === 1) {
        env += atkInc;
        fenv += atkInc;
        if (env >= 1) {
          env = 1;
          fenv = 1;
          stage = 2;
        }
      } else if (stage === 2) {
        env += (sus - env) * decC;
        fenv += (fsus - fenv) * fdecC;
      } else {
        env -= env * relC;
        fenv -= fenv * relC;
        if (env < 1e-4) {
          stage = 0;
          break;
        }
      }
      if (ctrl === 0) {
        const fc = Math.min(sr * 0.45, Math.max(20, cutoff * Math.pow(2, envAmt * fenv)));
        const g = Math.tan((Math.PI * fc) / sr);
        const a1c = 1 / (1 + g * (g + kRes));
        c[fi] = a1c;
        c[fi + 1] = g * a1c;
        c[fi + 2] = g * g * a1c;
        c[fi + 3] = kRes;
        ctrl = CTRL;
      }
      ctrl--;
      const fr = freq * bend;
      let sl = 0;
      let sR = 0;
      for (let u = 0; u < U; u++) {
        const idx = v * MAXU + u;
        const dt1 = (fr * uRatio[u]) / sr;
        const dt2 = dt1 * semi;
        let q1 = ph1[idx] + dt1;
        if (q1 >= 1) q1 -= 1;
        let q2 = ph2[idx] + dt2;
        if (q2 >= 1) q2 -= 1;
        ph1[idx] = q1;
        ph2[idx] = q2;
        let o = 0;
        if (a1 > 0) o += a1 * oscSample(w1, q1, dt1, pw);
        if (a2 > 0) o += a2 * oscSample(w2, q2, dt2, pw);
        sl += o * panL[u];
        sR += o * panR[u];
      }
      if (noiseAmt > 0) {
        const nz = (rand01(st.rng) * 2 - 1) * noiseAmt;
        sl += nz;
        sR += nz;
      }
      // state-variable low-pass (TPT), left then right
      const A1 = c[fi];
      const A2 = c[fi + 1];
      const A3 = c[fi + 2];
      let v3 = sl - f[fi + 1];
      let v1 = A1 * f[fi] + A2 * v3;
      let v2 = f[fi + 1] + A2 * f[fi] + A3 * v3;
      f[fi] = 2 * v1 - f[fi];
      f[fi + 1] = 2 * v2 - f[fi + 1];
      const yl = v2;
      v3 = sR - f[fi + 3];
      v1 = A1 * f[fi + 2] + A2 * v3;
      v2 = f[fi + 3] + A2 * f[fi + 2] + A3 * v3;
      f[fi + 2] = 2 * v1 - f[fi + 2];
      f[fi + 3] = 2 * v2 - f[fi + 3];
      const a = env * vel * gain;
      ol[i] += yl * a;
      or[i] += v2 * a;
    }
    st.freq[v] = freq;
    st.env[v] = env;
    st.fenv[v] = fenv;
    st.stage[v] = stage;
    st.ctrl[v] = ctrl;
    if (stage === 0) {
      st.note[v] = -1;
      st.env[v] = 0;
    }
  }
}
