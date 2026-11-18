import { defineNode } from '../../define';
import { defineAudio, midiEvent, type MidiEvent } from '../../audio/types';
import { biquadTick, dbToLin, hzToMidi, makeBiquad, setBiquad, type Biquad } from '../../audio/dsp';
import { nsdf, pickPeriod, type PitchResult } from '../../audio/pitch';
import { KEY_OPTIONS, SCALE_OPTIONS, snapToScale } from '../../audio/scales';

const RING = 1024; // history kept, in decimated samples (64 ms at 16 kHz)
const HOP = 160; // decimated samples between analyses (~10 ms)
const TARGET_RATE = 16000;
const RECENT = 320; // decimated samples used for the level estimate (~20 ms)
const HIST = 32; // pitch estimates kept (320 ms)
const CENT = 8; // centre values kept: the centre counts as settled when these 80 ms agree
const STABLE_RANGE = 0.5; // semitones: the short window spans less than this when the voice holds a pitch
const ONSET_RANGE = 0.3; // semitones: tighter for the first note, so a vibrato peak is not taken for the note
const CENTER_RANGE = 0.3; // semitones: the same for the centre

/**
 * Monophonic pitch tracker: audio in, MIDI notes out ("sing a melody, play a synth").
 *
 * Pipeline: DC-block -> low-pass + decimate to ~16 kHz -> McLeod NSDF on a 64 ms window every 10 ms ->
 * note logic that follows the SETTLED pitch, not the momentary one. Two views of the recent pitch are kept: a short window
 * (is the voice holding a pitch right now?) and a long one of about a vibrato cycle (the centre it sings around).
 *   - a note starts when the short window holds still (a scoop into the note is waited out);
 *   - a note changes when the short window holds a different note AND the centre has left the old one the same way.
 *     Vibrato holds a pitch at its peaks but leaves the centre in place; a slide moves the centre but holds nothing:
 *     neither plays the notes in between;
 *   - note-off after the sound has been unvoiced or quiet for a short time.
 */
export default defineNode({
  id: 'audio-to-midi',
  title: 'Audio to MIDI',
  category: 'synth',
  description: 'Listens to a single voice or instrument and turns what it plays into MIDI notes. Connect the microphone, then a synth.',
  keywords: ['pitch', 'voice', 'sing', 'tracker', 'convert', 'monophonic', 'pitch detection', 'microphone'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { midi: { type: 'midi', label: 'MIDI' } },
  params: {
    gate: { type: 'number', default: -45, min: -80, max: -10, step: 0.5, unit: 'db', label: 'Gate level', hint: 'Sounds quieter than this are ignored.' },
    sensitivity: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Sensitivity', hint: 'Higher accepts noisier, less clear tones; lower only accepts clean pitched sounds.' },
    minNote: { type: 'number', default: 36, min: 24, max: 100, step: 1, integer: true, label: 'Lowest note' },
    maxNote: { type: 'number', default: 96, min: 40, max: 108, step: 1, integer: true, label: 'Highest note' },
    smoothing: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Steadiness', hint: 'Higher holds the current note longer before changing (fewer flutters, slower response).' },
    scale: { type: 'enum', default: 'off', options: SCALE_OPTIONS, label: 'Snap to scale' },
    key: { type: 'enum', default: '0', options: KEY_OPTIONS, label: 'Key', visibleIf: (p) => p.scale !== 'off' },
    bend: { type: 'bool', default: false, label: 'Pitch bend', hint: 'Send pitch bend for slides.' },
    channel: { type: 'number', default: 0, min: 0, max: 15, step: 1, integer: true, label: 'MIDI channel' },
  },
  summary: (p) => `${p.scale === 'off' ? 'any note' : p.scale} · gate ${p.gate} dB`,
  audio: defineAudio({
    create: (ctx) => {
      const D = Math.max(1, Math.round(ctx.sampleRate / TARGET_RATE));
      const fsD = ctx.sampleRate / D;
      const lp: Biquad[] = [makeBiquad(), makeBiquad()];
      if (D > 1) {
        setBiquad(lp[0], 'lowpass', ctx.sampleRate, fsD * 0.4, 0.54);
        setBiquad(lp[1], 'lowpass', ctx.sampleRate, fsD * 0.4, 1.31);
      }
      const maxLagCap = Math.floor(fsD / 27) + 2; // lowest supported note ~ 27 Hz
      return {
        D,
        fsD,
        lp,
        dcPrev: 0,
        dcOut: 0,
        phase: 0,
        ring: new Float32Array(RING),
        ringPos: 0,
        filled: 0,
        hop: 0,
        win: new Float32Array(RING),
        nsdf: new Float32Array(maxLagCap + 2),
        res: { lag: 0, clarity: 0 } as PitchResult,
        // sample-domain energy tracking (for gate and velocity)
                // note state
        note: -1,
        quiet: 0,
        lastBend: 0,
        peak: 0,
        raw0: -1,
        raw1: -1,
        hist: new Float32Array(HIST),
        histPos: 0,
        histN: 0,
        cent: new Float32Array(CENT),
        centPos: 0,
        centN: 0,
      };
    },
    process(st, io) {
      const src = io.in.audio;
      const out = io.midiOut.midi;
      if (!src) return;
      const p = io.params;
      const n = io.frames;
      const clarityMin = 0.92 - 0.35 * p.sensitivity; // 0.745 at the default
      const gateLin = dbToLin(p.gate);
      const minLag = Math.max(2, Math.floor(st.fsD / hzMax(p.maxNote)));
      const maxLag = Math.min(st.nsdf.length - 2, Math.ceil(st.fsD / hzMin(p.minNote)) + 2);
      // Window just long enough for ~2.6 periods of the lowest note: cheaper for higher 'Lowest note' settings.
      const W = Math.min(RING, Math.max(RECENT + 64, Math.ceil((2.6 * maxLag) / 8) * 8));
      const stableHops = 4 + Math.round(p.smoothing * 4); // 4..8 analyses (40..80 ms) the pitch must hold still
      const centerHops = 12 + Math.round(p.smoothing * 12); // 12..24 analyses (120..240 ms): about one vibrato cycle
      const hyst = 0.4 + 0.2 * p.smoothing; // semitones the centre must leave the old note by
      const releaseHops = 3 + Math.round(p.smoothing * 4);
      const key = Number(p.key);
      for (let i = 0; i < n; i++) {
        const x = (src[0][i] + src[1][i]) * 0.5;
        // DC block (one-pole high-pass)
        const dc = x - st.dcPrev + 0.995 * st.dcOut;
        st.dcPrev = x;
        st.dcOut = dc;
        let y = dc;
        if (st.D > 1) y = biquadTick(st.lp[1], biquadTick(st.lp[0], dc));
        if (++st.phase < st.D) continue;
        st.phase = 0;
        st.ring[st.ringPos] = y;
        st.ringPos = (st.ringPos + 1) % RING;
        if (st.filled < RING) st.filled++;
        if (++st.hop < HOP || st.filled < W) continue;
        st.hop = 0;

        // linearise the window (oldest first) and measure its level
        let e = 0;
        for (let k = 0; k < W; k++) {
          const v = st.ring[(st.ringPos - W + k + RING) % RING];
          st.win[k] = v;
          if (k >= W - RECENT) e += v * v;
        }
        // Level of the most recent ~20 ms: gates onsets and decides velocity. (Using the whole 64 ms window
        // would let a short click keep 'sounding' until it left the window.)
        const level = Math.sqrt(e / RECENT);
        let voiced = level > gateLin * (st.note >= 0 ? 0.5 : 1);
        let midi = 0;
        if (voiced) {
          nsdf(st.win, W, maxLag, st.nsdf);
          pickPeriod(st.nsdf, minLag, maxLag, 0.93, st.res);
          if (st.res.lag > 0 && st.res.clarity >= clarityMin) {
            midi = hzToMidi(st.fsD / st.res.lag);
            if (midi < p.minNote - 0.5 || midi > p.maxNote + 0.5) voiced = false;
          } else voiced = false;
        }

        if (voiced) {
          st.quiet = 0;
          // Median of the last three estimates: a single wrong estimate (an octave blip on a consonant) is dropped.
          const m0 = st.raw0;
          const m1 = st.raw1;
          st.raw0 = st.raw1 < 0 ? midi : st.raw1;
          st.raw1 = midi;
          const med = m0 < 0 || m1 < 0 ? midi : Math.max(Math.min(m0, m1), Math.min(Math.max(m0, m1), midi));
          // History of the pitch (voiced analyses only) and of its running centre.
          st.hist[st.histPos] = med;
          st.histPos = (st.histPos + 1) % HIST;
          if (st.histN < HIST) st.histN++;
          // Short window: is the voice holding a pitch right now (not sliding, not mid-vibrato)?
          const ns = Math.min(st.histN, stableHops);
          let lo = Infinity;
          let hi = -Infinity;
          let sum = 0;
          for (let k = 1; k <= ns; k++) {
            const v = st.hist[(st.histPos - k + HIST) % HIST];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            sum += v;
          }
          const shortMean = sum / ns;
          const shortStable = st.histN >= stableHops && hi - lo < STABLE_RANGE;
          // Long window (about one vibrato cycle): the centre the voice is singing around.
          const nc = Math.min(st.histN, centerHops);
          let csum = 0;
          for (let k = 1; k <= nc; k++) csum += st.hist[(st.histPos - k + HIST) % HIST];
          const center = csum / nc;
          st.cent[st.centPos] = center;
          st.centPos = (st.centPos + 1) % CENT;
          if (st.centN < CENT) st.centN++;
          let clo = Infinity;
          let chi = -Infinity;
          for (let k = 1; k <= st.centN; k++) {
            const v = st.cent[(st.centPos - k + CENT) % CENT];
            if (v < clo) clo = v;
            if (v > chi) chi = v;
          }
          const centerStable = st.histN >= centerHops && st.centN >= CENT && chi - clo < CENTER_RANGE;
          if (level > st.peak) st.peak = level;

          let next = -1;
          if (st.note < 0) {
            // A note starts when the pitch has settled (a scoop into the note is waited out), or, for a voice that never
            // holds still (vibrato from the first moment), on the centre once a full cycle has been heard.
            if (shortStable && hi - lo < ONSET_RANGE) next = snapNote(shortMean, p.scale, key);
            else if (centerStable) next = snapNote(center, p.scale, key);
          } else {
            const d = center - st.note;
            const t = snapNote(shortMean, p.scale, key);
            // A new note: the voice holds a different pitch AND the centre has left the old note the same way. Vibrato
            // peaks hold a pitch for a moment but leave the centre where it was; a slide moves the centre but holds nothing.
            // (not while the sound is dying away: the pitch of a voice often drops as a note ends, and that is not a new note)
            if (level > 0.35 * st.peak && shortStable && st.histN >= centerHops && t !== st.note && Math.abs(d) > hyst && Math.abs(shortMean - st.note) > hyst && d > 0 === t > st.note) next = t;
            // ... or the centre itself has settled on another note (a vibrato note that was caught off-centre).
            else if (level > 0.35 * st.peak && centerStable && Math.abs(d) > 0.6 && snapNote(center, p.scale, key) !== st.note) next = snapNote(center, p.scale, key);
          }
          if (next >= 0 && next !== st.note && next >= p.minNote && next <= p.maxNote) {
            if (st.note >= 0) out.push(midiEvent('off', st.note, 0, i, p.channel));
            emitOn(out, next, velocityFor(level, gateLin), i, p.channel);
            st.note = next;
            st.peak = level;
            st.lastBend = 0;
          } else if (st.note >= 0 && p.bend) {
            const bend = Math.max(-1, Math.min(1, (med - st.note) / 2));
            if (Math.abs(bend - st.lastBend) > 0.02) {
              out.push({ type: 'bend', note: st.note, velocity: 0, value: bend, offset: i, channel: p.channel });
              st.lastBend = bend;
            }
          }
        } else if (++st.quiet >= releaseHops) {
          // silence or noise for long enough: the note ends and the pitch history starts over
          if (st.note >= 0) out.push(midiEvent('off', st.note, 0, i, p.channel));
          st.note = -1;
          st.peak = 0;
          st.histN = 0;
          st.centN = 0;
          st.raw0 = -1;
          st.raw1 = -1;
        }
      }
    },
    reset(st) {
      st.note = -1;
      st.histN = 0;
      st.centN = 0;
      st.raw0 = -1;
      st.raw1 = -1;
    },
  }),
});

const hzMax = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const hzMin = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

/** The note a pitch belongs to: the nearest one, or the nearest of the chosen scale. */
function snapNote(v: number, scale: string, key: number): number {
  return scale === 'off' ? Math.round(v) : snapToScale(v, scale as never, key);
}

function velocityFor(level: number, gateLin: number): number {
  const db = 20 * Math.log10(Math.max(level, 1e-6) / Math.max(gateLin, 1e-6));
  return Math.max(0.15, Math.min(1, 0.3 + db / 40));
}

function emitOn(out: MidiEvent[], note: number, velocity: number, offset: number, channel: number): void {
  out.push(midiEvent('on', note, velocity, offset, channel));
}
