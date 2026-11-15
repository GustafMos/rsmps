/**
 * Streaming monophonic pitch tracker (DC block, low-pass + decimate to ~16 kHz, McLeod NSDF every 10 ms).
 * Used by the sound-to-picture bridge. (`audio-to-midi` has its own copy with note logic on top.)
 */
import { biquadTick, hzToMidi, makeBiquad, setBiquad, type Biquad } from './dsp';
import { nsdf, pickPeriod, type PitchResult } from './pitch';

const TARGET = 16000;
const RING = 1024;
const HOP = 160;
const RECENT = 320;

export interface PitchTracker {
  D: number;
  fsD: number;
  lp: Biquad[];
  dcPrev: number;
  dcOut: number;
  phase: number;
  ring: Float32Array;
  pos: number;
  filled: number;
  hop: number;
  win: Float32Array;
  nsdf: Float32Array;
  res: PitchResult;
  /** After a hop: detected pitch as a fractional MIDI note, or -1 when unvoiced. */
  note: number;
  /** After a hop: RMS of the last ~20 ms (linear). */
  level: number;
}

export function makePitchTracker(sampleRate: number): PitchTracker {
  const D = Math.max(1, Math.round(sampleRate / TARGET));
  const fsD = sampleRate / D;
  const lp = [makeBiquad(), makeBiquad()];
  if (D > 1) {
    setBiquad(lp[0], 'lowpass', sampleRate, fsD * 0.4, 0.54);
    setBiquad(lp[1], 'lowpass', sampleRate, fsD * 0.4, 1.31);
  }
  return {
    D,
    fsD,
    lp,
    dcPrev: 0,
    dcOut: 0,
    phase: 0,
    ring: new Float32Array(RING),
    pos: 0,
    filled: 0,
    hop: 0,
    win: new Float32Array(RING),
    nsdf: new Float32Array(Math.floor(fsD / 27) + 4),
    res: { lag: 0, clarity: 0 },
    note: -1,
    level: 0,
  };
}

/** Feed one input sample. Returns true when a new analysis result is available in `t.note` / `t.level`. */
export function pitchPush(t: PitchTracker, x: number, minNote: number, maxNote: number, gateLin: number, clarityMin: number): boolean {
  const dc = x - t.dcPrev + 0.995 * t.dcOut;
  t.dcPrev = x;
  t.dcOut = dc;
  const y = t.D > 1 ? biquadTick(t.lp[1], biquadTick(t.lp[0], dc)) : dc;
  if (++t.phase < t.D) return false;
  t.phase = 0;
  t.ring[t.pos] = y;
  t.pos = (t.pos + 1) % RING;
  if (t.filled < RING) t.filled++;
  if (++t.hop < HOP) return false;
  const hzMin = 440 * Math.pow(2, (minNote - 69) / 12);
  const hzMax = 440 * Math.pow(2, (maxNote - 69) / 12);
  const minLag = Math.max(2, Math.floor(t.fsD / hzMax));
  const maxLag = Math.min(t.nsdf.length - 2, Math.ceil(t.fsD / hzMin) + 2);
  const W = Math.min(RING, Math.max(RECENT + 64, Math.ceil((2.6 * maxLag) / 8) * 8));
  if (t.filled < W) return false;
  t.hop = 0;
  let e = 0;
  for (let k = 0; k < W; k++) {
    const v = t.ring[(t.pos - W + k + RING) % RING];
    t.win[k] = v;
    if (k >= W - RECENT) e += v * v;
  }
  t.level = Math.sqrt(e / RECENT);
  t.note = -1;
  if (t.level > gateLin) {
    nsdf(t.win, W, maxLag, t.nsdf);
    pickPeriod(t.nsdf, minLag, maxLag, 0.93, t.res);
    if (t.res.lag > 0 && t.res.clarity >= clarityMin) {
      const m = hzToMidi(t.fsD / t.res.lag);
      if (m >= minNote - 0.5 && m <= maxNote + 0.5) t.note = m;
    }
  }
  return true;
}
