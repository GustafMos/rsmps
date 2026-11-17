/**
 * Beat and onset detection (pure DSP, no imports: it is bundled into the AudioWorklet by `beat-detect`).
 *
 * Pipeline (the same maths runs live, causally, and offline over a whole track):
 *  1. `FluxExtractor`: STFT (Hann, 1024 samples at 44.1 / 48 kHz, hop = size / 4) -> log-compressed magnitude ->
 *     half-wave-rectified spectral flux, in four versions: all bins, low (kick), mid (snare) and high (hat) band.
 *  2. `OnsetPicker`: adaptive threshold (median + k * scaled MAD of the surrounding flux, plus a small absolute and a relative term),
 *     local-maximum peak picking and a minimum gap. Causal = 1 frame of look-ahead; offline = half a window of look-ahead.
 *  3. Tempo: autocorrelation of the onset envelope with a log-Gaussian prior around 120 BPM (octave correction), then a fine search
 *     on the onset times themselves (resultant-vector length of the onsets folded at a trial period) for BPM and phase.
 *  4. Beat tracking: live = phase-locked grid from step 3 (smoothed); offline = Ellis-style dynamic programming over the onset envelope.
 */

/* ------------------------------------------------------------------ FFT */

export interface Fft {
  n: number;
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

export function makeFft(n: number): Fft {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  return { n, cos, sin, rev };
}

/** Forward complex FFT in place (no scaling). */
export function fftInPlace(f: Fft, re: Float64Array, im: Float64Array): void {
  const n = f.n;
  for (let i = 0; i < n; i++) {
    const j = f.rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k;
        const b = a + half;
        const wr = f.cos[t];
        const wi = f.sin[t];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/* ------------------------------------------------------------ spectral flux */

export interface FluxFrame {
  /** Frame number (0 = first full window). */
  index: number;
  total: number;
  low: number;
  mid: number;
  high: number;
  /** Sum of the per-bin mean flux of the three bands (each band counts the same, whatever its width): the envelope tempo and beats are tracked on, where a kick matters as much as a hat. */
  eq: number;
  /** RMS of the window (linear). */
  rms: number;
}

export const BEAT_BANDS = { low: [30, 120], mid: [180, 2500], high: [5000, 16000] } as const;
const MAG_FLOOR = 3e-5;
const GAMMA = 100;

/**
 * Where inside a window (as a fraction of its length) an onset that this frame detects sits. Measured on click tracks and drum hits
 * (beat.test.ts, 'timing bias') so that reported onset times land on the actual transient.
 */
const ONSET_POS = 0.62;

export class FluxExtractor {
  readonly size: number;
  readonly hop: number;
  readonly hopSec: number;
  readonly sampleRate: number;
  frameCount = 0;
  private fft: Fft;
  private win: Float64Array;
  private ring: Float32Array;
  private pos = 0;
  private filled = 0;
  private since = 0;
  private re: Float64Array;
  private im: Float64Array;
  private prev: Float64Array;
  private b: number[];
  private frame: FluxFrame = { index: 0, total: 0, low: 0, mid: 0, high: 0, eq: 0, rms: 0 };
  private onFrame: (f: FluxFrame) => void;

  constructor(sampleRate: number, onFrame: (f: FluxFrame) => void) {
    this.sampleRate = sampleRate;
    this.size = sampleRate > 60000 ? 2048 : 1024;
    this.hop = this.size / 4;
    this.hopSec = this.hop / sampleRate;
    this.fft = makeFft(this.size);
    this.win = new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.size);
    this.ring = new Float32Array(this.size);
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    this.prev = new Float64Array(this.size / 2 + 1);
    const bin = (hz: number) => Math.max(1, Math.min(this.size / 2, Math.round((hz * this.size) / sampleRate)));
    this.b = [bin(BEAT_BANDS.low[0]), bin(BEAT_BANDS.low[1]), bin(BEAT_BANDS.mid[1]), bin(BEAT_BANDS.high[0]), bin(Math.min(BEAT_BANDS.high[1], sampleRate * 0.45))];
    this.onFrame = onFrame;
  }

  reset(): void {
    this.ring.fill(0);
    this.prev.fill(0);
    this.pos = 0;
    this.filled = 0;
    this.since = 0;
    this.frameCount = 0;
  }

  /** Centre time (seconds, in the stream's clock) of a frame's window, corrected for the measured onset lag. */
  onsetTime(frame: number): number {
    return (frame * this.hop + this.size * ONSET_POS) / this.sampleRate;
  }

  push(x: ArrayLike<number>, from: number, to: number): void {
    const n = this.size;
    for (let i = from; i < to; i++) {
      this.ring[this.pos] = x[i];
      this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
      if (this.filled < n) this.filled++;
      if (++this.since >= this.hop && this.filled >= n) {
        this.since = 0;
        this.analyse();
      } else if (this.since >= this.hop) this.since = 0;
    }
  }

  private analyse(): void {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const s = this.ring[(this.pos + i) % n];
      e += s * s;
      re[i] = s * this.win[i];
      im[i] = 0;
    }
    fftInPlace(this.fft, re, im);
    const norm = 4 / n;
    const half = n / 2;
    const b = this.b;
    let total = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let k = 1; k <= half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
      const c = mag > MAG_FLOOR ? Math.log1p(GAMMA * (mag - MAG_FLOOR)) : 0;
      const d = c - this.prev[k];
      this.prev[k] = c;
      if (d > 0) {
        total += d;
        if (k >= b[0] && k < b[1]) low += d;
        else if (k >= b[1] && k < b[2]) mid += d;
        else if (k >= b[3] && k < b[4]) high += d;
      }
    }
    // Per-bin means tell broadband hits (snare, hat: similar in every band) from a kick (low band only) and a hat (high only).
    const lN = low / Math.max(1, b[1] - b[0]);
    const mN = mid / Math.max(1, b[2] - b[1]);
    const hN = high / Math.max(1, b[4] - b[3]);
    this.frame.eq = lN + mN + hN;
    if (!(lN > 2 * mN && lN > 2 * hN)) low = 0; // kick: the low band must clearly dominate the mids
    if (!(mN >= 0.5 * lN && hN < 4 * mN)) mid = 0; // snare: body in the mids, not a low thump, not a high-only tick
    const f = this.frame;
    f.index = this.frameCount++;
    f.total = total;
    f.low = low;
    f.mid = mid;
    f.high = high;
    f.rms = Math.sqrt(e / n);
    this.onFrame(f);
  }
}

/* ------------------------------------------------------------ onset picking */

export interface PickerOpts {
  /** Frames of flux the threshold statistics look at. */
  win: number;
  /** Frames of look-ahead before a candidate is judged (>= radius). */
  look: number;
  /** A peak must be the maximum within +- radius frames. */
  radius: number;
  /** Multiplier of the scaled MAD. */
  k: number;
  /** Absolute floor added to the threshold. */
  delta: number;
  /** Fraction of the window maximum added to the threshold. */
  rel: number;
  /** Minimum distance between two onsets in frames. */
  minGap: number;
}

export function pickerOpts(hopSec: number, sensitivity: number, offline: boolean, minGapMs = 70, deltaScale = 1, rel = 0.12): PickerOpts {
  const s = Math.min(1, Math.max(0, sensitivity));
  const radius = offline ? 3 : 1;
  const win = Math.max(16, Math.round((offline ? 1.2 : 0.9) / hopSec));
  return {
    win,
    look: offline ? Math.round(win / 2) : radius,
    radius,
    k: 5.5 - 3.5 * s,
    delta: 0.6 * deltaScale * (1.4 - s),
    rel,
    minGap: Math.max(1, Math.round(minGapMs / 1000 / hopSec)),
  };
}

function insertionSort(a: Float64Array, m: number): void {
  for (let i = 1; i < m; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > v) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

export class OnsetPicker {
  private opts: PickerOpts;
  private buf: Float64Array;
  private cap: number;
  private scratch: Float64Array;
  private n = 0;
  private last = -1e9;
  private cb: (frame: number, strength: number) => void;
  /** Threshold used for the last judged candidate (for tests and meters). */
  lastThreshold = 0;

  constructor(opts: PickerOpts, cb: (frame: number, strength: number) => void) {
    this.opts = opts;
    this.cap = opts.win + opts.look + opts.radius + 2;
    this.buf = new Float64Array(this.cap);
    this.scratch = new Float64Array(opts.win + opts.look + 2);
    this.cb = cb;
  }

  reset(): void {
    this.buf.fill(0);
    this.n = 0;
    this.last = -1e9;
  }

  private at(i: number): number {
    return i < 0 ? 0 : this.buf[i % this.cap];
  }

  push(v: number): void {
    const o = this.opts;
    this.buf[this.n % this.cap] = v;
    const c = this.n - o.look;
    this.n++;
    if (c < 0) return;
    const fc = this.at(c);
    if (c - this.last < o.minGap) return;
    for (let i = 1; i <= o.radius; i++) {
      if (fc < this.at(c - i) || fc <= this.at(c + i)) return;
    }
    // statistics over the window ending at the newest value
    const m = Math.min(o.win + o.look, this.n);
    const sc = this.scratch;
    let mx = 0;
    for (let i = 0; i < m; i++) {
      const x = this.at(this.n - 1 - i);
      sc[i] = x;
      if (x > mx) mx = x;
    }
    insertionSort(sc, m);
    const med = m & 1 ? sc[(m - 1) >> 1] : 0.5 * (sc[m / 2 - 1] + sc[m / 2]);
    for (let i = 0; i < m; i++) sc[i] = Math.abs(sc[i] - med);
    insertionSort(sc, m);
    const mad = m & 1 ? sc[(m - 1) >> 1] : 0.5 * (sc[m / 2 - 1] + sc[m / 2]);
    const thr = med + o.k * 1.4826 * mad + o.delta + o.rel * mx;
    this.lastThreshold = thr;
    if (fc > thr) {
      this.last = c;
      this.cb(c, fc - thr);
    }
  }

  /** Offline: judge the last `look` candidates by feeding zeros. */
  flush(): void {
    for (let i = 0; i < this.opts.look + 1; i++) this.push(0);
  }
}

/* -------------------------------------------------------------------- tempo */

export interface TempoEstimate {
  bpm: number;
  /** Normalised autocorrelation at the chosen lag, 0..1. */
  conf: number;
}

const BPM_MIN = 55;
const BPM_MAX = 210;
/** Log-Gaussian prior (centre 120 BPM, sigma 0.6 octaves): picks the musically likely octave among 1x / 2x / 0.5x. */
export function tempoPrior(bpm: number): number {
  const o = Math.log2(bpm / 120) / 0.6;
  return Math.exp(-0.5 * o * o);
}

export function acLagRange(hopSec: number): { min: number; max: number } {
  return { min: Math.max(2, Math.floor(60 / BPM_MAX / hopSec)), max: Math.ceil(60 / BPM_MIN / hopSec) };
}

/**
 * Tempo from an onset envelope by autocorrelation. `ac` is scratch of length >= lagMax + 2. Allocation-free.
 * `env` is read as a plain array [start, start + count).
 */
export function estimateTempo(env: ArrayLike<number>, start: number, count: number, hopSec: number, ac: Float64Array, out: TempoEstimate): boolean {
  const { min, max } = acLagRange(hopSec);
  if (count < max * 2) return false;
  let mean = 0;
  for (let i = 0; i < count; i++) mean += env[start + i];
  mean /= count;
  let e0 = 0;
  for (let i = 0; i < count; i++) {
    const d = env[start + i] - mean;
    e0 += d * d;
  }
  if (e0 < 1e-9) return false;
  for (let lag = min - 1; lag <= max + 1; lag++) {
    let s = 0;
    for (let i = lag; i < count; i++) s += (env[start + i] - mean) * (env[start + i - lag] - mean);
    ac[lag] = (s / (count - lag)) / (e0 / count);
  }
  let best = -1;
  let bestScore = 0;
  for (let lag = min; lag <= max; lag++) {
    if (ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    const bpm = 60 / (lag * hopSec);
    const score = ac[lag] * tempoPrior(bpm);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || ac[best] <= 0.02) return false;
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const den = a - 2 * b + c;
  const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  out.bpm = 60 / ((best + frac) * hopSec);
  out.conf = Math.min(1, Math.max(0, ac[best]));
  return true;
}

export interface GridFit {
  /** Beat period in seconds. */
  period: number;
  /** A beat time modulo the period, in [0, period). */
  phase: number;
  /** How well the onsets sit on a grid of half beats (eighth notes), 0..1. This is what decides whether there is a tempo. */
  strength: number;
  /** How strongly the onsets favour the beat itself over the half beats, 0..1 (low = the phase may be half a beat off). */
  beatness: number;
}

/**
 * Fine tempo and phase from weighted onset times: folds the onsets at trial periods around `bpm0` (+-spread) and keeps the period where
 * they pile up on a grid of half beats (second harmonic: a kick on the beat and hats on the off-beat cancel at the beat itself, so the
 * beat's own harmonic is not used to find the period); the phase then comes from the beat's own harmonic, where louder onsets win.
 * Allocation-free.
 */
export function fitGrid(times: ArrayLike<number>, weights: ArrayLike<number>, count: number, bpm0: number, out: GridFit, spread = 0.04): boolean {
  if (count < 3) return false;
  let bestR = -1;
  let wsum = 0;
  for (let i = 0; i < count; i++) wsum += weights[i];
  if (wsum <= 0) return false;
  const lo = bpm0 * (1 - spread);
  const hi = bpm0 * (1 + spread);
  const step = Math.max(0.02, bpm0 * 0.0004);
  for (let bpm = lo; bpm <= hi; bpm += step) {
    const T = 60 / bpm;
    let cr = 0;
    let ci = 0;
    let c1r = 0;
    let c1i = 0;
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * times[i]) / T;
      const w = weights[i];
      cr += w * Math.cos(2 * a);
      ci += w * Math.sin(2 * a);
      c1r += w * Math.cos(a);
      c1i += w * Math.sin(a);
    }
    const r = Math.sqrt(cr * cr + ci * ci) / wsum;
    if (r > bestR) {
      bestR = r;
      out.period = T;
      let ph = Math.atan2(c1i, c1r) / (2 * Math.PI);
      if (ph < 0) ph += 1;
      out.phase = ph * T;
      out.strength = r;
      out.beatness = Math.sqrt(c1r * c1r + c1i * c1i) / wsum;
    }
  }
  return bestR >= 0;
}

/* --------------------------------------------------------- offline analysis */

export interface BeatAnalysis {
  version: 1;
  duration: number;
  bpm: number;
  /** Seconds, ascending. Empty when no steady beat was found. */
  beats: number[];
  onsets: number[];
  kick: number[];
  snare: number[];
  hat: number[];
}

/** Band onsets must reach this fraction of the loudest recent hit in their band: a snare's low rumble is not a kick. */
export const BAND_REL = 0.4;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Ellis (2007) dynamic-programming beat tracker. `env` is the onset envelope at hop rate; returns beat frames. */
export function trackBeatsDP(env: Float32Array, periodFrames: number, tightness = 80): number[] {
  const n = env.length;
  if (n < periodFrames * 2) return [];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (env[i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) e[i] = env[i] / sd;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const t0 = Math.max(1, Math.round(periodFrames / 2));
  const t1 = Math.round(periodFrames * 2);
  const pen = new Float64Array(t1 + 1);
  for (let t = t0; t <= t1; t++) pen[t] = tightness * Math.log(t / periodFrames) ** 2;
  for (let i = 0; i < n; i++) {
    let bs = 0; // starting a new chain here is allowed
    let bi = -1;
    for (let t = t0; t <= t1 && i - t >= 0; t++) {
      const v = score[i - t] - pen[t];
      if (v > bs || bi < 0) {
        if (v > bs) {
          bs = v;
          bi = i - t;
        }
      }
    }
    score[i] = e[i] + bs;
    back[i] = bi;
  }
  // best end within the last period
  let end = n - 1;
  let bestV = -Infinity;
  for (let i = Math.max(0, n - Math.round(periodFrames)); i < n; i++) {
    if (score[i] > bestV) {
      bestV = score[i];
      end = i;
    }
  }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) {
    beats.push(i);
    if (back[i] < 0) break;
  }
  return beats.reverse();
}

/**
 * Whole-track analysis. Feed mono samples with `push` (any chunking, `await` between chunks to keep a UI alive), then `finish`.
 * `sensitivity` 0..1 (default 0.5).
 */
export class TrackAnalyzer {
  private flux: FluxExtractor;
  private tot: number[] = [];
  private bands: number[][] = [[], [], []];
  private eq: number[] = [];
  private samples = 0;
  private sensitivity: number;

  constructor(readonly sampleRate: number, sensitivity = 0.5) {
    this.sensitivity = sensitivity;
    this.flux = new FluxExtractor(sampleRate, (f) => {
      this.tot.push(f.total);
      this.eq.push(f.eq);
      this.bands[0].push(f.low);
      this.bands[1].push(f.mid);
      this.bands[2].push(f.high);
    });
  }

  push(x: ArrayLike<number>, from = 0, to = x.length): void {
    this.flux.push(x, from, to);
    this.samples += to - from;
  }

  finish(): BeatAnalysis {
    const fx = this.flux;
    const hopSec = fx.hopSec;
    const pick = (series: number[], minGapMs: number, deltaScale: number, rel = 0.12): number[] => {
      const out: number[] = [];
      const p = new OnsetPicker(pickerOpts(hopSec, this.sensitivity, true, minGapMs, deltaScale, rel), (f) => out.push(r3(fx.onsetTime(f))));
      for (const v of series) p.push(v);
      p.flush();
      return out;
    };
    const onsets = pick(this.tot, 70, 1);
    const kick = pick(this.bands[0], 120, 0.5, BAND_REL);
    const snare = pick(this.bands[1], 120, 0.5, BAND_REL);
    const hat = pick(this.bands[2], 50, 0.5, BAND_REL);
    const duration = this.samples / this.sampleRate;
    const res: BeatAnalysis = { version: 1, duration: r3(duration), bpm: 0, beats: [], onsets, kick, snare, hat };
    const env = Float32Array.from(this.eq);
    const beatOnsets = pick(this.eq, 70, 1);
    const { max } = acLagRange(hopSec);
    const est: TempoEstimate = { bpm: 0, conf: 0 };
    if (!estimateTempo(env, 0, env.length, hopSec, new Float64Array(max + 4), est) || beatOnsets.length < 4) return res;
    const w = new Float64Array(beatOnsets.length).fill(1);
    const fit: GridFit = { period: 0, phase: 0, strength: 0, beatness: 0 };
    let bpm0 = est.bpm;
    if (fitGrid(beatOnsets, w, beatOnsets.length, bpm0, fit)) bpm0 = 60 / fit.period;
    const frames = trackBeatsDP(env, 60 / bpm0 / hopSec);
    // drop beats at the ends that have no onset nearby (silence before / after the music)
    const near = (t: number) => beatOnsets.some((o) => Math.abs(o - t) < 0.08);
    const times = frames.map((f) => r3(fx.onsetTime(f)));
    while (times.length && !near(times[0])) times.shift();
    while (times.length && !near(times[times.length - 1])) times.pop();
    if (times.length < 4) return res;
    const ibi: number[] = [];
    for (let i = 1; i < times.length; i++) ibi.push(times[i] - times[i - 1]);
    ibi.sort((a, b) => a - b);
    let bpm = 60 / ibi[ibi.length >> 1];
    // a straight-line fit through the beats is finer than the hop; trust it when the beats really are that regular
    const m = times.length;
    const tm = (m - 1) / 2;
    const ym = times.reduce((a, b) => a + b, 0) / m;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < m; i++) {
      sxy += (i - tm) * (times[i] - ym);
      sxx += (i - tm) ** 2;
    }
    const slope = sxy / sxx;
    let res2 = 0;
    for (let i = 0; i < m; i++) res2 += (times[i] - (ym + slope * (i - tm))) ** 2;
    if (slope > 0 && Math.sqrt(res2 / m) < 0.02 && Math.abs(60 / slope / bpm - 1) < 0.03) bpm = 60 / slope;
    res.bpm = Math.round(bpm * 100) / 100;
    res.beats = times;
    return res;
  }
}

/** Convenience for tests and tools: analyse a whole mono buffer. */
export function analyzeTrack(mono: ArrayLike<number>, sampleRate: number, sensitivity = 0.5): BeatAnalysis {
  const a = new TrackAnalyzer(sampleRate, sensitivity);
  a.push(mono);
  return a.finish();
}
