/**
 * Small DSP building blocks shared by audio kernels. Pure functions and plain state objects:
 * no allocation after construction, no browser APIs.
 */

export const TAU = Math.PI * 2;

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const linToDb = (lin: number): number => 20 * Math.log10(Math.max(lin, 1e-9));
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const midiToHz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/** Flush denormals / tiny values to zero (feedback paths). */
export const fz = (x: number): number => (x > -1e-20 && x < 1e-20 ? 0 : x);

/** Seeded PRNG (mulberry32). Returns a state object; `rand01` advances it. */
export interface Rng {
  s: number;
}
export function makeRng(seed: string | number): Rng {
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return { s: h >>> 0 || 1 };
}
export function rand01(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** -1..1 */
export const randBi = (r: Rng): number => rand01(r) * 2 - 1;

/* ----------------------------------------------------------------------- */
/* Biquad (RBJ cookbook), transposed direct form II                         */
/* ----------------------------------------------------------------------- */

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf' | 'allpass';

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  z1: number;
  z2: number;
}
export const makeBiquad = (): Biquad => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 });

export function setBiquad(bq: Biquad, type: BiquadType, fs: number, freq: number, q: number, gainDb = 0): void {
  const f = clamp(freq, 10, fs * 0.49);
  const w0 = (TAU * f) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const Q = Math.max(q, 0.05);
  const alpha = sw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - s;
      break;
    }
  }
  bq.b0 = b0 / a0; bq.b1 = b1 / a0; bq.b2 = b2 / a0; bq.a1 = a1 / a0; bq.a2 = a2 / a0;
}

export function biquadTick(bq: Biquad, x: number): number {
  const y = bq.b0 * x + bq.z1;
  bq.z1 = fz(bq.b1 * x - bq.a1 * y + bq.z2);
  bq.z2 = fz(bq.b2 * x - bq.a2 * y);
  return y;
}

/* ----------------------------------------------------------------------- */
/* Delay line with fractional read                                          */
/* ----------------------------------------------------------------------- */

export class DelayLine {
  readonly buf: Float32Array;
  /** Power of two, so indices wrap with a mask (no branches, no modulo). */
  readonly size: number;
  readonly mask: number;
  pos = 0;
  constructor(maxSamples: number) {
    let size = 8;
    while (size < Math.ceil(maxSamples) + 4) size <<= 1;
    this.size = size;
    this.mask = size - 1;
    this.buf = new Float32Array(size);
  }
  write(x: number): void {
    this.buf[this.pos] = x;
    this.pos = (this.pos + 1) & this.mask;
  }
  /** Read `d` samples back from the most recent write (write first, then read), linear interpolated. d must be < size - 2. */
  read(d: number): number {
    const p = this.pos - 1 - d;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const a = this.buf[i0 & this.mask];
    return a + (this.buf[(i0 + 1) & this.mask] - a) * frac;
  }
  /** Integer-delay read (fast path). */
  readInt(d: number): number {
    return this.buf[(this.pos - 1 - d) & this.mask];
  }
  clear(): void {
    this.buf.fill(0);
    this.pos = 0;
  }
}

/** Linear ramp helper: value at sample `i` (0-based) of `n` going from `a` to `b`. */
export const ramp = (a: number, b: number, i: number, n: number): number => a + ((b - a) * (i + 1)) / n;

/** One-pole smoothing coefficient for a time constant in seconds. */
export const onePoleCoef = (seconds: number, fs: number): number => 1 - Math.exp(-1 / Math.max(seconds * fs, 1e-3));

/** polyBLEP residual for a discontinuity at phase 0 with phase increment dt. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Equal-power pan gains for pan -1..1. */
export function panGains(pan: number): [number, number] {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** Add `src` into `dst` for `n` samples. */
export function addInto(dst: Float32Array, src: Float32Array, n: number, gain = 1): void {
  for (let i = 0; i < n; i++) dst[i] += src[i] * gain;
}

/** Waveform codes for `oscSample`. */
export const WAVE = { sine: 0, triangle: 1, saw: 2, square: 3, pulse: 4 } as const;
export type WaveName = keyof typeof WAVE;

/** Band-limited (polyBLEP) oscillator sample. `t` in [0,1), `dt` = freq / sampleRate, `pw` = pulse width. */
export function oscSample(wave: number, t: number, dt: number, pw = 0.5): number {
  switch (wave) {
    case 0:
      return Math.sin(TAU * t);
    case 1:
      return 4 * Math.abs(t - 0.5) - 1;
    case 2:
      return 2 * t - 1 - polyBlep(t, dt);
    case 3:
    case 4: {
      const w = wave === 3 ? 0.5 : pw;
      let v = t < w ? 1 : -1;
      v += polyBlep(t, dt);
      let u = t + 1 - w;
      if (u >= 1) u -= 1;
      v -= polyBlep(u, dt);
      return v;
    }
  }
  return 0;
}

/**
 * Run a biquad over `n` samples from `x[xo..]` into `y[yo..]` (they may be the same array). Coefficients and state are held in
 * locals for the whole block, which is several times faster than calling `biquadTick` per sample.
 * Denormal protection happens once per block.
 */
export function biquadBlock(bq: Biquad, x: Float32Array, y: Float32Array, n: number, xo = 0, yo = 0): void {
  const b0 = bq.b0, b1 = bq.b1, b2 = bq.b2, a1 = bq.a1, a2 = bq.a2;
  let z1 = bq.z1, z2 = bq.z2;
  for (let i = 0; i < n; i++) {
    const v = x[xo + i];
    const o = b0 * v + z1;
    z1 = b1 * v - a1 * o + z2;
    z2 = b2 * v - a2 * o;
    y[yo + i] = o;
  }
  bq.z1 = fz(z1);
  bq.z2 = fz(z2);
}
