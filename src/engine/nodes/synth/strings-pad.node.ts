import { defineNode } from '../../define';
import { defineAudio, type MidiEvent } from '../../audio/types';
import { DelayLine, biquadBlock, dbToLin, makeBiquad, midiToHz, oscSample, panGains, setBiquad, type Biquad } from '../../audio/dsp';
import { adsrStep, allIdle, expCoef, fastSin, handleController, makeVoices, newPresetCache, pickVoice, presetOptions, presetView, releaseNote } from '../../audio/instrument';

const MAXV = 8;
const MAXU = 7;
const VOWELS: Record<string, [number, number]> = { ah: [800, 1150], oh: [450, 800], ee: [270, 2300], oo: [325, 700] };

const PRESETS: Record<string, Record<string, unknown>> = {
  'warm-pad': { unison: 7, detune: 18, attack: 0.9, release: 1.4, cutoff: 1600, resonance: 0.8, chorus: 0.5, formant: 0 },
  'string-machine': { unison: 5, detune: 12, attack: 0.25, release: 0.55, cutoff: 5200, resonance: 0.7, chorus: 0.85, formant: 0 },
  'choir-ish': { unison: 5, detune: 8, attack: 0.5, release: 1, cutoff: 4500, resonance: 0.7, chorus: 0.4, formant: 0.85, vowel: 'ah' },
};

/** Supersaw ensemble pad: detuned band-limited saws, slow attack, low-pass, string-machine chorus, optional vowel formants. */
export default defineNode({
  id: 'strings-pad',
  title: 'Strings & Pad',
  category: 'synth',
  description: 'Lush, slowly swelling pads and string-machine ensembles from thick detuned sawtooth layers with chorus.',
  keywords: ['pad', 'strings', 'ensemble', 'supersaw', 'choir', 'ambient', 'warm', 'string machine', 'atmosphere'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    preset: { type: 'enum', default: 'warm-pad', label: 'Sound', options: presetOptions({ 'warm-pad': 'Warm pad', 'string-machine': 'String machine', 'choir-ish': 'Choir-ish' }) },
    unison: { type: 'number', default: 7, min: 1, max: MAXU, softMax: 7, step: 1, integer: true, label: 'Layers per note', group: 'Sound' },
    detune: { type: 'number', default: 18, min: 0, max: 50, step: 0.5, label: 'Detune', hint: 'In cents.', group: 'Sound' },
    attack: { type: 'number', default: 0.9, min: 0.005, max: 8, step: 0.005, unit: 's', label: 'Swell in', group: 'Sound' },
    release: { type: 'number', default: 1.4, min: 0.01, max: 10, step: 0.01, unit: 's', label: 'Fade out', group: 'Sound' },
    cutoff: { type: 'number', default: 1600, min: 100, max: 16000, step: 1, unit: 'hz', label: 'Brightness', group: 'Filter' },
    resonance: { type: 'number', default: 0.8, min: 0.3, max: 4, step: 0.01, label: 'Resonance', group: 'Filter' },
    chorus: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Ensemble chorus', group: 'Filter' },
    formant: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Voice vowel amount', group: 'Voice' },
    vowel: { type: 'enum', default: 'ah', label: 'Vowel', group: 'Voice', options: [{ value: 'ah', label: 'Ah' }, { value: 'oh', label: 'Oh' }, { value: 'ee', label: 'Ee' }, { value: 'oo', label: 'Oo' }], visibleIf: (p) => (p.formant as number) > 0 },
    voices: { type: 'number', default: 6, min: 1, max: MAXV, softMax: 6, step: 1, integer: true, label: 'Notes at once', group: 'Sound' },
    gain: { type: 'number', default: -12, min: -60, max: 6, step: 0.1, unit: 'db', label: 'Volume', group: 'Sound' },
  },
  summary: (p) => (p.preset !== 'custom' ? String(p.preset) : `${p.unison} layers`),
  audio: defineAudio({
    create: (ctx) => ({
      v: makeVoices(MAXV),
      phase: new Float64Array(MAXV * MAXU),
      freq: new Float64Array(MAXV),
      lp: [makeBiquad(), makeBiquad()] as Biquad[],
      f1: [makeBiquad(), makeBiquad()] as Biquad[],
      f2: [makeBiquad(), makeBiquad()] as Biquad[],
      tmp: [new Float32Array(ctx.blockSize), new Float32Array(ctx.blockSize)],
      dl: new DelayLine(ctx.sampleRate * 0.05),
      dr: new DelayLine(ctx.sampleRate * 0.05),
      lfo: 0,
      ratio: new Float64Array(MAXU),
      key: '',
      presets: newPresetCache(),
    }),
    process(st, io) {
      const p = presetView(st.presets, io.params, PRESETS);
      const n = io.frames;
      const sr = io.sampleRate;
      const [ol, or] = io.out.audio;
      const events: MidiEvent[] = io.midiIn.midi;
      const v = st.v;
      let ei = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) {
          const ev = events[ei++];
          if (ev.type === 'on') {
            const i = pickVoice(v, ev.note, p.voices);
            v.vel[i] = 0.5 + 0.5 * ev.velocity;
            st.freq[i] = midiToHz(ev.note);
            if (v.fresh) for (let u = 0; u < MAXU; u++) st.phase[i * MAXU + u] = u / MAXU;
          } else if (ev.type === 'off') releaseNote(v, ev.note);
          else handleController(v, ev);
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        renderVoices(st, p, sr, ol, or, cursor, end);
        cursor = end;
      }
      post(st, p, sr, ol, or, n);
    },
    reset(st) {
      allIdle(st.v);
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderVoices(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  const v = st.v;
  const U = p.unison as number;
  const atk = 1 / Math.max(1, p.attack * sr);
  const relC = expCoef(p.release, sr);
  const gain = (dbToLin(p.gain) * 0.55) / Math.sqrt(U);
  const ratio: Float64Array = st.ratio;
  for (let u = 0; u < U; u++) ratio[u] = Math.pow(2, ((U === 1 ? 0 : (2 * u) / (U - 1) - 1) * p.detune) / 1200);
  for (let i = 0; i < v.n; i++) {
    if (v.stage[i] === 0) continue;
    const f = st.freq[i];
    for (let k = s0; k < s1; k++) {
      const e = adsrStep(v, i, atk, 1, 1, relC);
      if (v.stage[i] === 0) break;
      let l = 0;
      let r = 0;
      for (let u = 0; u < U; u++) {
        const dt = (f * ratio[u]) / sr;
        const ix = i * MAXU + u;
        let ph = st.phase[ix] + dt;
        if (ph >= 1) ph -= 1;
        st.phase[ix] = ph;
        const o = oscSample(2, ph, dt);
        const pn = PAN[U === 1 ? MAXU >> 1 : Math.round((u * (MAXU - 1)) / (U - 1))];
        l += o * pn[0];
        r += o * pn[1];
      }
      const a = e * v.vel[i] * gain;
      ol[k] += l * a;
      or[k] += r * a;
    }
  }
}

// pan table per unison layer (hard-wired spread: 0.6 of the stereo field)
const PAN: [number, number][] = Array.from({ length: MAXU }, (_, u) => {
  const pos = (2 * u) / (MAXU - 1) - 1;
  const [a, b] = panGains(pos * 0.6);
  return [a * Math.SQRT2, b * Math.SQRT2];
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function post(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, n: number): void {
  // low-pass
  const key = `${p.cutoff}|${p.resonance}|${p.formant}|${p.vowel}`;
  if (key !== st.key) {
    st.key = key;
    const [a, b] = VOWELS[p.vowel] ?? VOWELS.ah;
    for (let c = 0; c < 2; c++) {
      setBiquad(st.lp[c], 'lowpass', sr, p.cutoff, p.resonance);
      setBiquad(st.f1[c], 'bandpass', sr, a, 6);
      setBiquad(st.f2[c], 'bandpass', sr, b, 6);
    }
  }
  const chans = [ol, or];
  for (let c = 0; c < 2; c++) {
    const x = chans[c];
    if (p.formant > 0) {
      const t = st.tmp[0] as Float32Array;
      const u = st.tmp[1] as Float32Array;
      biquadBlock(st.f1[c], x, t, n);
      biquadBlock(st.f2[c], x, u, n);
      for (let i = 0; i < n; i++) x[i] = x[i] * (1 - p.formant * 0.7) + (t[i] + u[i] * 0.7) * p.formant * 2.2;
    }
    biquadBlock(st.lp[c], x, x, n);
  }
  // ensemble chorus: three slowly moving taps per side
  if (p.chorus > 0) {
    const base = 0.018 * sr;
    const depth = 0.004 * sr * (0.4 + 0.6 * p.chorus);
    for (let i = 0; i < n; i++) {
      st.dl.write(ol[i]);
      st.dr.write(or[i]);
      st.lfo += 0.6 / sr;
      if (st.lfo >= 1) st.lfo -= 1;
      let wl = 0;
      let wr = 0;
      for (let t = 0; t < 3; t++) {
        const d = base * (1 + 0.15 * t) + depth * fastSin(st.lfo + t / 3);
        wl += st.dl.read(d);
        wr += st.dr.read(d * 1.07);
      }
      ol[i] = ol[i] * (1 - 0.35 * p.chorus) + (wl / 3) * 0.9 * p.chorus;
      or[i] = or[i] * (1 - 0.35 * p.chorus) + (wr / 3) * 0.9 * p.chorus;
    }
  }
}
