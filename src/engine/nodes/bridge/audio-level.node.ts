import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { biquadBlock, dbToLin, makeBiquad, setBiquad } from '../../audio/dsp';
import { makePitchTracker, pitchPush } from '../../audio/pitch-tracker';

/**
 * Sound-to-picture bridge. Measures the incoming audio and outputs numbers you can wire into any number setting.
 * Every output is mapped into From..To, so `level` can go straight into e.g. a position.
 * Stream side (`audio`): measures and publishes signals. Picture side (`render`): reads them back through
 * `Host.signal`. This file must only import audio code: it is bundled into the AudioWorklet.
 */
export default defineNode({
  id: 'audio-level',
  title: 'Sound to Numbers',
  category: 'math',
  description: 'Listens to a sound (for example the microphone) and turns its loudness, bass/mid/treble and pitch into numbers that can move anything.',
  keywords: ['loudness', 'volume', 'envelope follower', 'microphone', 'sing', 'audio reactive', 'beat', 'pitch', 'drive', 'bass', 'meter'],
  inputs: { audio: { type: 'audio', label: 'Sound' } },
  outputs: {
    level: { type: 'number', label: 'Loudness' },
    peak: { type: 'number', label: 'Peak' },
    low: { type: 'number', label: 'Bass' },
    mid: { type: 'number', label: 'Mids' },
    high: { type: 'number', label: 'Treble' },
    pitch: { type: 'number', label: 'Pitch' },
  },
  params: {
    gain: { type: 'number', default: 0, min: -24, max: 48, step: 0.1, unit: 'db', label: 'Input boost' },
    attack: { type: 'number', default: 10, min: 1, max: 1000, step: 1, label: 'Rise time (ms)' },
    release: { type: 'number', default: 150, min: 1, max: 3000, step: 1, label: 'Fall time (ms)' },
    floor: { type: 'number', default: -60, min: -100, max: -10, step: 0.5, unit: 'db', label: 'Quietest (gives From)', hint: 'Sounds at or below this loudness give the From value. Also the noise floor for pitch.' },
    ceiling: { type: 'number', default: -6, min: -40, max: 6, step: 0.5, unit: 'db', label: 'Loudest (gives To)' },
    from: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'From' },
    to: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'To' },
    minNote: { type: 'number', default: 36, min: 24, max: 100, step: 1, integer: true, label: 'Lowest pitch (note)', group: 'Pitch' },
    maxNote: { type: 'number', default: 84, min: 40, max: 108, step: 1, integer: true, label: 'Highest pitch (note)', group: 'Pitch' },
    sensitivity: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Pitch sensitivity', group: 'Pitch' },
    holdPitch: { type: 'bool', default: true, label: 'Hold the last pitch when silent', group: 'Pitch' },
    pitchSmooth: { type: 'number', default: 40, min: 0, max: 1000, step: 1, label: 'Pitch smoothing (ms)', group: 'Pitch' },
  },
  summary: (p) => `${p.floor}..${p.ceiling} dB to ${p.from}..${p.to}`,
  audio: defineAudio({
    create: (ctx) => ({
      bands: [makeBiquad(), makeBiquad(), makeBiquad(), makeBiquad()], // low LP, mid HP then LP, high HP
      bandSr: 0,
      mono: new Float32Array(ctx.blockSize),
      tLow: new Float32Array(ctx.blockSize),
      tMid: new Float32Array(ctx.blockSize),
      tHigh: new Float32Array(ctx.blockSize),
      ms: new Float64Array(4), // mean-square: overall, low, mid, high
      env: new Float64Array(4), // RMS with attack/release
      peak: 0,
      tracker: makePitchTracker(ctx.sampleRate),
      pitchPos: -1,
      pitchRaw: -1,
      started: false,
    }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const src = io.in.audio;
      const range = Math.max(0.1, p.ceiling - p.floor);
      const map = (db: number): number => {
        const t = (db - p.floor) / range;
        return p.from + (p.to - p.from) * (t < 0 ? 0 : t > 1 ? 1 : t);
      };
      if (src) {
        if (st.bandSr !== sr) {
          st.bandSr = sr;
          setBiquad(st.bands[0], 'lowpass', sr, 250, 0.707);
          setBiquad(st.bands[1], 'highpass', sr, 250, 0.707);
          setBiquad(st.bands[2], 'lowpass', sr, 2500, 0.707);
          setBiquad(st.bands[3], 'highpass', sr, 2500, 0.707);
        }
        const g = dbToLin(p.gain);
        const aC = 1 - Math.exp(-1 / Math.max(1, (p.attack / 1000) * sr));
        const rC = 1 - Math.exp(-1 / Math.max(1, (p.release / 1000) * sr));
        const mono: Float32Array = st.mono;
        const tLow: Float32Array = st.tLow;
        const tMid: Float32Array = st.tMid;
        const tHigh: Float32Array = st.tHigh;
        for (let i = 0; i < n; i++) mono[i] = (src[0][i] + src[1][i]) * 0.5 * g;
        biquadBlock(st.bands[0], mono, tLow, n);
        biquadBlock(st.bands[1], mono, tMid, n);
        biquadBlock(st.bands[2], tMid, tMid, n);
        biquadBlock(st.bands[3], mono, tHigh, n);
        const env: Float64Array = st.env;
        const wC = 1 - Math.exp(-1 / (0.02 * sr)); // 20 ms mean-square window, then attack/release on the RMS
        const ms: Float64Array = st.ms;
        const track = st.tracker;
        const gate = dbToLin(p.floor);
        const clarity = 0.92 - 0.35 * p.sensitivity;
        let pk = 0;
        for (let i = 0; i < n; i++) {
          const x = mono[i];
          const ax = x < 0 ? -x : x;
          if (ax > pk) pk = ax;
          ms[0] += (x * x - ms[0]) * wC;
          ms[1] += (tLow[i] * tLow[i] - ms[1]) * wC;
          ms[2] += (tMid[i] * tMid[i] - ms[2]) * wC;
          ms[3] += (tHigh[i] * tHigh[i] - ms[3]) * wC;
          for (let k = 0; k < 4; k++) {
            const r = Math.sqrt(ms[k]);
            env[k] += (r - env[k]) * (r > env[k] ? aC : rC);
          }
          if (pitchPush(track, x, p.minNote, p.maxNote, gate, clarity)) {
            if (track.note >= 0) st.pitchRaw = track.note;
            else if (!p.holdPitch) st.pitchRaw = -1;
          }
        }
        st.peak = pk > st.peak ? pk : st.peak * Math.exp(-n / Math.max(1, (p.release / 1000) * sr));
        io.signal('level', map(20 * Math.log10(env[0] + 1e-6)));
        io.signal('peak', map(20 * Math.log10(st.peak + 1e-9)));
        io.signal('low', map(20 * Math.log10(env[1] + 1e-6)));
        io.signal('mid', map(20 * Math.log10(env[2] + 1e-6)));
        io.signal('high', map(20 * Math.log10(env[3] + 1e-6)));
      } else {
        io.signal('level', p.from);
        io.signal('peak', p.from);
        io.signal('low', p.from);
        io.signal('mid', p.from);
        io.signal('high', p.from);
      }
      // pitch as a 0..1 position between the lowest and highest note, smoothed, mapped to From..To
      if (st.pitchRaw >= 0) {
        const pos = Math.min(1, Math.max(0, (st.pitchRaw - p.minNote) / Math.max(1, p.maxNote - p.minNote)));
        const c = 1 - Math.exp(-n / Math.max(1, (p.pitchSmooth / 1000) * sr));
        st.pitchPos = st.pitchPos < 0 ? pos : st.pitchPos + (pos - st.pitchPos) * c;
      } else if (!p.holdPitch) st.pitchPos = -1;
      io.signal('pitch', p.from + (p.to - p.from) * (st.pitchPos < 0 ? 0 : st.pitchPos));
    },
  }),
  render(ctx) {
    const t = ctx.time.seconds; // reading the clock makes this node re-render every frame
    const read = (name: string): number => ctx.host.signal?.(ctx.nodeId, name, t) ?? 0;
    return { level: read('level'), peak: read('peak'), low: read('low'), mid: read('mid'), high: read('high'), pitch: read('pitch') };
  },
});
