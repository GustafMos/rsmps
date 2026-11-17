/** Synthetic drum audio for the beat tests (deterministic: seeded noise, no Math.random). */

export const BSR = 48000;

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kick: sine sweeping 140 -> 45 Hz with a 120 ms decay. */
export function addKick(x: Float32Array, at: number, amp = 0.9, sr = BSR): void {
  const n = Math.floor(0.25 * sr);
  let ph = 0;
  for (let i = 0; i < n && at + i < x.length; i++) {
    const t = i / sr;
    const f = 45 + 95 * Math.exp(-t / 0.03);
    ph += (2 * Math.PI * f) / sr;
    x[at + i] += amp * Math.sin(ph) * Math.exp(-t / 0.07) * Math.min(1, i / 100);
  }
}

/** Hat: 30 ms of white noise high-passed by a first difference, fast decay. */
export function addHat(x: Float32Array, at: number, amp = 0.35, sr = BSR, seed = 7): void {
  const r = rng(seed + at);
  const n = Math.floor(0.05 * sr);
  let prev = 0;
  for (let i = 0; i < n && at + i < x.length; i++) {
    const w = r() * 2 - 1;
    const hp = w - prev;
    prev = w;
    x[at + i] += amp * 0.5 * hp * Math.exp(-i / sr / 0.012);
  }
}

/** Snare: 200 Hz tone body plus noise, 100 ms decay. */
export function addSnare(x: Float32Array, at: number, amp = 0.6, sr = BSR, seed = 11): void {
  const r = rng(seed + at);
  const n = Math.floor(0.2 * sr);
  for (let i = 0; i < n && at + i < x.length; i++) {
    const t = i / sr;
    x[at + i] += amp * (0.5 * Math.sin(2 * Math.PI * 200 * t) + 0.7 * (r() * 2 - 1)) * Math.exp(-t / 0.05);
  }
}

/** Short broadband click (decaying 3 kHz burst), as a wideband "metronome". */
export function addClick(x: Float32Array, at: number, amp = 0.8, sr = BSR): void {
  const n = Math.floor(0.02 * sr);
  for (let i = 0; i < n && at + i < x.length; i++) {
    const t = i / sr;
    x[at + i] += amp * Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t / 0.004);
  }
}

export interface Track {
  audio: Float32Array;
  /** True onset times in seconds. */
  times: number[];
}

/** Click track at `bpm` for `seconds`; each click is displaced by +-jitterMs (deterministic). */
export function clickTrack(bpm: number, seconds: number, jitterMs = 0, sr = BSR, first = 0.3): Track {
  const audio = new Float32Array(Math.round(seconds * sr));
  const r = rng(bpm * 31 + 5);
  const times: number[] = [];
  for (let t = first; t < seconds - 0.1; t += 60 / bpm) {
    const tj = t + ((r() * 2 - 1) * jitterMs) / 1000;
    times.push(tj);
    addClick(audio, Math.round(tj * sr), 0.8, sr);
  }
  return { audio, times };
}

/** Rock beat: kick on 1 and 3, snare on 2 and 4, hats on eighths, at `bpm` in 4/4. */
export function drumPattern(bpm: number, bars: number, sr = BSR, first = 0.25): { audio: Float32Array; kick: number[]; snare: number[]; hat: number[]; beats: number[] } {
  const beat = 60 / bpm;
  const audio = new Float32Array(Math.round((first + bars * 4 * beat + 0.5) * sr));
  const kick: number[] = [];
  const snare: number[] = [];
  const hat: number[] = [];
  const beats: number[] = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = first + b * beat;
    beats.push(t);
    if (b % 4 === 0 || b % 4 === 2) {
      addKick(audio, Math.round(t * sr), 0.9, sr);
      kick.push(t);
    } else {
      addSnare(audio, Math.round(t * sr), 0.6, sr);
      snare.push(t);
    }
    for (const h of [0, 0.5]) {
      addHat(audio, Math.round((t + h * beat) * sr), 0.35, sr);
      hat.push(t + h * beat);
    }
  }
  return { audio, kick, snare, hat, beats };
}

/** For each expected time, the distance to the nearest detection (Infinity when there is none). */
export function matchErrors(expected: number[], found: number[]): number[] {
  return expected.map((e) => found.reduce((m, f) => Math.min(m, Math.abs(f - e)), Infinity));
}
