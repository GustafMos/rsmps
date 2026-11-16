import { defineNode } from '../../define';
import { defineAudio, midiEvent, type MidiEvent } from '../../audio/types';
import { biquadTick, dbToLin, hzToMidi, makeBiquad, setBiquad, type Biquad } from '../../audio/dsp';
import { nsdf, pickPeriod, type PitchResult } from '../../audio/pitch';
import { KEY_OPTIONS, SCALE_OPTIONS, snapToScale } from '../../audio/scales';

const RING = 1024; // history kept, in decimated samples (64 ms at 16 kHz)
const HOP = 160; // decimated samples between analyses (~10 ms)
const TARGET_RATE = 16000;
const RECENT = 320; // decimated samples used for the level estimate (~20 ms)

/**
 * Monophonic pitch tracker: audio in, MIDI notes out ("sing a melody, play a synth").
 *
 * Pipeline: DC-block -> low-pass + decimate to ~16 kHz -> McLeod NSDF on a 64 ms window every 10 ms ->
 * snap to the nearest note (optionally to a scale) -> note-on only after the same note repeats
 * `confirm` times, a note changes only when the pitch moves clearly past the old note (hysteresis),
 * and note-off after the sound has been unvoiced or quiet for a short time.
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
        cand: -1,
        candCount: 0,
        quiet: 0,
        lastBend: 0,
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
      const confirm = 2 + Math.round(p.smoothing * 4); // 2..6 hops (20..60 ms)
      const hyst = 0.5 + 0.3 * p.smoothing; // semitones past the old note before a change is considered
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
          const target = p.scale === 'off' ? Math.round(midi) : snapToScale(midi, p.scale, key);
          if (st.note < 0) {
            // starting a note: the same note must be heard `confirm` times in a row
            if (target === st.cand) st.candCount++;
            else {
              st.cand = target;
              st.candCount = 1;
            }
            if (st.candCount >= confirm) {
              emitOn(out, st.cand, velocityFor(level, gateLin), i, p.channel);
              st.note = st.cand;
              st.candCount = 0;
              st.lastBend = 0;
            }
          } else {
            const moved = Math.abs(midi - st.note) > hyst && target !== st.note;
            if (moved) {
              if (target === st.cand) st.candCount++;
              else {
                st.cand = target;
                st.candCount = 1;
              }
              if (st.candCount >= confirm) {
                out.push(midiEvent('off', st.note, 0, i, p.channel));
                emitOn(out, target, velocityFor(level, gateLin), i, p.channel);
                st.note = target;
                st.candCount = 0;
                st.lastBend = 0;
              }
            } else {
              st.candCount = 0;
              st.cand = -1;
              if (p.bend) {
                const bend = Math.max(-1, Math.min(1, (midi - st.note) / 2));
                if (Math.abs(bend - st.lastBend) > 0.02) {
                  out.push({ type: 'bend', note: st.note, velocity: 0, value: bend, offset: i, channel: p.channel });
                  st.lastBend = bend;
                }
              }
            }
          }
        } else {
          st.candCount = 0;
          st.cand = -1;
          if (st.note >= 0 && ++st.quiet >= releaseHops) {
            out.push(midiEvent('off', st.note, 0, i, p.channel));
            st.note = -1;
            st.quiet = 0;
          }
        }
      }
    },
    reset(st) {
      st.note = -1;
      st.cand = -1;
      st.candCount = 0;
    },
  }),
});

const hzMax = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const hzMin = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

function velocityFor(level: number, gateLin: number): number {
  const db = 20 * Math.log10(Math.max(level, 1e-6) / Math.max(gateLin, 1e-6));
  return Math.max(0.15, Math.min(1, 0.3 + db / 40));
}

function emitOn(out: MidiEvent[], note: number, velocity: number, offset: number, channel: number): void {
  out.push(midiEvent('on', note, velocity, offset, channel));
}
