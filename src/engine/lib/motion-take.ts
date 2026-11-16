/**
 * Recorded phone motion ("takes"), pure. A take lives in a node param as compact keyframes per channel (resampled at the project fps,
 * quantised, simplified with Ramer-Douglas-Peucker). Reading a take is deterministic: no phone, no clock, so exports reproduce it.
 *
 * Stored channels are in `STORED`; everything else (yaw / pitch / roll, the Euler trio for 3D Object, absolute versions) is DERIVED from the
 * stored quaternions on read, so smoothing a take on the rotation manifold keeps the angles consistent with it.
 */
import { lookAngles, objectRotation, qAlign, qConj, qExp, qLog, qMul, qNorm, qSlerp, relativeTo, unwrapAngle, type Quat } from './motion-math';

export type MotionFrame = Record<string, number>;

interface ChannelSpec {
  /** Quantisation step. */
  step: number;
  /** RDP tolerance (same unit). */
  tol: number;
  /** Size of a "large deliberate move" in this channel's unit (for the keep-fast-moves option). */
  big: number;
  /** Do not smooth (counts, pulses). */
  noSmooth?: boolean;
}
const A: ChannelSpec = { step: 0.02, tol: 0.1, big: 90 };
const Q: ChannelSpec = { step: 5e-5, tol: 2e-4, big: 1 };
const RATE: ChannelSpec = { step: 0.1, tol: 1.5, big: 300 };
const ACC: ChannelSpec = { step: 0.01, tol: 0.06, big: 10 };
const UNIT: ChannelSpec = { step: 0.001, tol: 0.004, big: 1 };

export const STORED: Record<string, ChannelSpec> = {
  qx: Q, qy: Q, qz: Q, qw: Q,
  aqx: Q, aqy: Q, aqz: Q, aqw: Q,
  heading: A,
  rx: RATE, ry: RATE, rz: RATE,
  ax: ACC, ay: ACC, az: ACC,
  shake: UNIT,
  tx: UNIT, ty: UNIT, tc: { ...UNIT, noSmooth: true },
  pinch: UNIT, twist: A, panx: UNIT, pany: UNIT,
  px: { step: 0.002, tol: 0.01, big: 2 }, py: { step: 0.002, tol: 0.01, big: 2 }, pz: { step: 0.002, tol: 0.01, big: 2 },
  tap: { ...UNIT, tol: 0.25, noSmooth: true },
};
export const STORED_NAMES = Object.keys(STORED);
/** Derived angle channels (relative and `abs.` versions). */
export const DERIVED_BASE = ['yaw', 'pitch', 'roll', 'orx', 'ory', 'orz'] as const;
export const DERIVED_NAMES: string[] = [...DERIVED_BASE, ...DERIVED_BASE.map((n) => `abs.${n}`)];
export const ALL_CHANNELS: string[] = [...STORED_NAMES, ...DERIVED_NAMES];

const QUAT_GROUPS: [string, string, string, string][] = [
  ['qx', 'qy', 'qz', 'qw'],
  ['aqx', 'aqy', 'aqz', 'aqw'],
];

/** Neutral values of every channel (identity pose, nothing touched). */
export function neutralFrame(): MotionFrame {
  const f: MotionFrame = {};
  for (const n of ALL_CHANNELS) f[n] = 0;
  f.qw = 1;
  f.aqw = 1;
  f.pinch = 1;
  return f;
}

/** Add the derived angle channels of a frame from its quaternions (not unwrapped: use `deriveSeries` for a series). */
export function withDerived(f: MotionFrame): MotionFrame {
  const out = { ...f };
  for (const [prefix, g] of [['', QUAT_GROUPS[0]], ['abs.', QUAT_GROUPS[1]]] as const) {
    const q = qNorm([f[g[0]] ?? 0, f[g[1]] ?? 0, f[g[2]] ?? 0, f[g[3]] ?? 1]);
    const a = lookAngles(q);
    const o = objectRotation(q);
    out[`${prefix}yaw`] = a.yaw;
    out[`${prefix}pitch`] = a.pitch;
    out[`${prefix}roll`] = a.roll;
    out[`${prefix}orx`] = o[0];
    out[`${prefix}ory`] = o[1];
    out[`${prefix}orz`] = o[2];
  }
  return out;
}

/* ------------------------------------------------------------------ dense data */

/** A take expanded to one value per frame per channel. */
export interface Dense {
  fps: number;
  frames: number;
  loop: boolean;
  ch: Record<string, Float64Array>;
}

export interface MotionTake {
  v: 1;
  fps: number;
  frames: number;
  /** The move was made to repeat: smoothing wraps around and reading loops. */
  loop: boolean;
  /** As recorded (never changed after recording): [frame, value, frame, value, ...] per channel. */
  raw: Record<string, number[]>;
  /** Result of "Smooth take" (replaces raw for reading), or null. */
  baked: Record<string, number[]> | null;
}

export function isTake(v: unknown): v is MotionTake {
  const t = v as MotionTake | null;
  return !!t && typeof t === 'object' && t.v === 1 && typeof t.fps === 'number' && typeof t.frames === 'number' && !!t.raw && typeof t.raw === 'object';
}

function expand(tracks: Record<string, number[]>, frames: number): Record<string, Float64Array> {
  const ch: Record<string, Float64Array> = {};
  const neutral = neutralFrame();
  for (const name of STORED_NAMES) {
    const k = tracks[name];
    const out = new Float64Array(frames);
    if (!k || k.length < 2) out.fill(neutral[name]);
    else {
      let j = 0;
      for (let i = 0; i < frames; i++) {
        while (j + 2 < k.length && k[j + 2] <= i) j += 2;
        const f0 = k[j];
        const v0 = k[j + 1];
        if (j + 2 >= k.length || i <= f0) out[i] = v0;
        else {
          const f1 = k[j + 2];
          out[i] = v0 + ((k[j + 3] - v0) * (i - f0)) / Math.max(1e-9, f1 - f0);
        }
      }
    }
    ch[name] = out;
  }
  return ch;
}

/** Fill the derived channels of a dense take (angles unwrapped along the series). */
export function deriveSeries(d: Dense): Dense {
  const ch = d.ch;
  for (const [prefix, g] of [['', QUAT_GROUPS[0]], ['abs.', QUAT_GROUPS[1]]] as const) {
    const arrs = DERIVED_BASE.map(() => new Float64Array(d.frames));
    let prevQ: Quat | null = null;
    const prev: number[] = [];
    for (let i = 0; i < d.frames; i++) {
      let q = qNorm([ch[g[0]][i], ch[g[1]][i], ch[g[2]][i], ch[g[3]][i]]);
      if (prevQ) q = qAlign(q, prevQ);
      prevQ = q;
      const a = lookAngles(q);
      const o = objectRotation(q);
      const vals = [a.yaw, a.pitch, a.roll, o[0], o[1], o[2]];
      for (let k = 0; k < 6; k++) {
        // pitch (k = 1) and the Y rotation (k = 4) live in -90..90 and never wrap
        const v = k === 1 || k === 4 || i === 0 ? vals[k] : unwrapAngle(prev[k], vals[k]);
        prev[k] = v;
        arrs[k][i] = v;
      }
    }
    DERIVED_BASE.forEach((n, k) => (ch[`${prefix}${n}`] = arrs[k]));
  }
  return d;
}

export function denseFromTracks(tracks: Record<string, number[]>, fps: number, frames: number, loop: boolean): Dense {
  return deriveSeries({ fps, frames, loop, ch: expand(tracks, frames) });
}

/* ------------------------------------------------------------------ building a take */

export interface RawSample {
  /** Seconds since the recording started. */
  t: number;
  v: MotionFrame;
}

function sampleSeries(samples: RawSample[], t: number): MotionFrame {
  // samples are sorted; linear interpolation, quaternions with slerp
  let hi = 0;
  while (hi < samples.length && samples[hi].t < t) hi++;
  if (hi === 0) return samples[0].v;
  if (hi >= samples.length) return samples[samples.length - 1].v;
  const a = samples[hi - 1];
  const b = samples[hi];
  const u = b.t - a.t < 1e-9 ? 0 : (t - a.t) / (b.t - a.t);
  const out: MotionFrame = {};
  for (const n of STORED_NAMES) {
    const x = a.v[n] ?? 0;
    const y = b.v[n] ?? 0;
    out[n] = n === 'tc' || n === 'tap' ? (u < 0.5 ? x : y) : x + (y - x) * u;
  }
  for (const g of QUAT_GROUPS) {
    const q = qSlerp([a.v[g[0]] ?? 0, a.v[g[1]] ?? 0, a.v[g[2]] ?? 0, a.v[g[3]] ?? 1], [b.v[g[0]] ?? 0, b.v[g[1]] ?? 0, b.v[g[2]] ?? 0, b.v[g[3]] ?? 1], u);
    g.forEach((name, i) => (out[name] = q[i]));
  }
  return out;
}

/** Ramer-Douglas-Peucker on (frame, value); keeps the first and last point. Returns indices. */
export function rdp(values: ArrayLike<number>, tol: number): number[] {
  const n = values.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let wd = tol;
    for (let i = a + 1; i < b; i++) {
      const y = values[a] + ((values[b] - values[a]) * (i - a)) / (b - a);
      const d = Math.abs(values[i] - y);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

function quantise(v: number, step: number): number {
  const q = Math.round(v / step) * step;
  return Number(q.toFixed(6));
}

/** Simplify dense channels into the stored keyframe form. */
export function tracksFromDense(ch: Record<string, ArrayLike<number>>, frames: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const name of STORED_NAMES) {
    const spec = STORED[name];
    const src = ch[name];
    const q = new Float64Array(frames);
    for (let i = 0; i < frames; i++) q[i] = quantise(src[i], spec.step);
    const idx = rdp(q, spec.tol);
    const flat: number[] = [];
    for (const i of idx) flat.push(i, q[i]);
    out[name] = flat;
  }
  return out;
}

/** Blend the last `n` frames into the first `n` so the move loops without a jump. Shortens the take by `n` frames. */
export function blendLoop(d: Dense, n: number): Dense {
  const N = Math.max(0, Math.min(Math.floor(n), Math.floor(d.frames / 2) - 1));
  if (N === 0) return { ...d, loop: true };
  const L = d.frames - N;
  const ch: Record<string, Float64Array> = {};
  for (const name of STORED_NAMES) ch[name] = d.ch[name].slice(0, L);
  for (let i = 0; i < N; i++) {
    const w = i / N; // 0 = the tail continuing the move, 1 = the head itself
    for (const name of STORED_NAMES) {
      if (name === 'tc' || name === 'tap') continue;
      ch[name][i] = d.ch[name][L + i] * (1 - w) + d.ch[name][i] * w;
    }
    for (const g of QUAT_GROUPS) {
      const tail: Quat = [d.ch[g[0]][L + i], d.ch[g[1]][L + i], d.ch[g[2]][L + i], d.ch[g[3]][L + i]];
      const head: Quat = [d.ch[g[0]][i], d.ch[g[1]][i], d.ch[g[2]][i], d.ch[g[3]][i]];
      const q = qSlerp(tail, head, w);
      g.forEach((name, k) => (ch[name][i] = q[k]));
    }
  }
  return { fps: d.fps, frames: L, loop: true, ch };
}

export interface BuildOptions {
  fps: number;
  loop?: boolean;
  /** Frames to cross-fade for a looping move (0 = none). */
  loopBlend?: number;
}

/** Turn raw timed samples into a take. Returns null when there is nothing usable. */
export function buildTake(samples: RawSample[], opts: BuildOptions): MotionTake | null {
  if (samples.length < 2) return null;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  const shifted = sorted.map((s) => ({ t: s.t - t0, v: s.v }));
  const dur = shifted[shifted.length - 1].t;
  const frames = Math.max(2, Math.round(dur * opts.fps) + 1);
  const ch: Record<string, Float64Array> = {};
  for (const n of STORED_NAMES) ch[n] = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const f = sampleSeries(shifted, i / opts.fps);
    for (const n of STORED_NAMES) ch[n][i] = f[n];
  }
  // one hemisphere along the whole take, so component-wise simplification and interpolation never cross a sign flip
  for (const g of QUAT_GROUPS) {
    let prev: Quat | null = null;
    for (let i = 0; i < frames; i++) {
      let q: Quat = [ch[g[0]][i], ch[g[1]][i], ch[g[2]][i], ch[g[3]][i]];
      if (prev) q = qAlign(q, prev);
      prev = q;
      g.forEach((name, k) => (ch[name][i] = q[k]));
    }
  }
  let dense: Dense = { fps: opts.fps, frames, loop: !!opts.loop, ch };
  if (opts.loop && (opts.loopBlend ?? 0) > 0) dense = blendLoop(dense, opts.loopBlend!);
  return { v: 1, fps: opts.fps, frames: dense.frames, loop: !!opts.loop, raw: tracksFromDense(dense.ch, dense.frames), baked: null };
}

/* ------------------------------------------------------------------ smoothing (zero phase) */

export interface Smoothing {
  /** 0 = as recorded .. 1 = very smooth (up to about 0.5 s of Gaussian sigma). */
  amount: number;
  /** 0..1: smooth small jitter more than large deliberate motion. */
  keepFast?: number;
}
export const smoothingKey = (s: Smoothing): string => `${s.amount.toFixed(3)}|${(s.keepFast ?? 0).toFixed(3)}`;

function kernel(sigmaFrames: number): { r: number; w: Float64Array } {
  const r = Math.max(1, Math.ceil(sigmaFrames * 3));
  const w = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) w[k + r] = Math.exp(-(k * k) / (2 * sigmaFrames * sigmaFrames));
  return { r, w };
}
const idx = (i: number, n: number, loop: boolean): number => (loop ? ((i % n) + n) % n : i < 0 ? 0 : i >= n ? n - 1 : i);

/** Zero-phase Gaussian (optionally edge preserving) smoothing of one scalar series. Constant input is unchanged. */
export function smoothSeries(x: ArrayLike<number>, sigmaFrames: number, loop: boolean, rangeSigma = 0): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (sigmaFrames < 1e-3 || n < 3) {
    for (let i = 0; i < n; i++) out[i] = x[i];
    return out;
  }
  const { r, w } = kernel(sigmaFrames);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -r; k <= r; k++) {
      // without looping, taps beyond the ends are skipped (not clamped) so the ends do not drag towards themselves
      if (!loop && (i + k < 0 || i + k >= n)) continue;
      const v = x[idx(i + k, n, loop)];
      let wt = w[k + r];
      if (rangeSigma > 0) {
        const d = (v - x[i]) / rangeSigma;
        wt *= Math.exp(-0.5 * d * d);
      }
      sum += wt * v;
      wsum += wt;
    }
    out[i] = sum / wsum;
  }
  return out;
}

/** Zero-phase smoothing of a quaternion series on the rotation manifold (weighted mean of log maps around each sample). */
export function smoothQuatSeries(q: Quat[], sigmaFrames: number, loop: boolean, rangeAngleRad = 0): Quat[] {
  const n = q.length;
  if (sigmaFrames < 1e-3 || n < 3) return q.map((x) => qNorm(x));
  const { r, w } = kernel(sigmaFrames);
  const out: Quat[] = [];
  for (let i = 0; i < n; i++) {
    const c = qNorm(q[i]);
    const cInv = qConj(c);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      if (!loop && (i + k < 0 || i + k >= n)) continue;
      const o = qAlign(qNorm(q[idx(i + k, n, loop)]), c);
      const l = qLog(qMul(cInv, o));
      let wt = w[k + r];
      if (rangeAngleRad > 0) {
        const ang = 2 * Math.hypot(l[0], l[1], l[2]);
        const d = ang / rangeAngleRad;
        wt *= Math.exp(-0.5 * d * d);
      }
      sx += wt * l[0];
      sy += wt * l[1];
      sz += wt * l[2];
      ws += wt;
    }
    out.push(qNorm(qMul(c, qExp([sx / ws, sy / ws, sz / ws]))));
  }
  return out;
}

/** Smooth every stored channel of a dense take (zero phase), then re-derive the angles. Returns a new Dense. */
export function smoothDense(d: Dense, s: Smoothing): Dense {
  const amount = Math.max(0, Math.min(1, s.amount));
  if (amount <= 0) return d;
  const keep = Math.max(0, Math.min(1, s.keepFast ?? 0));
  const sigma = amount * 0.5 * d.fps; // frames
  const rangeFrac = keep <= 0 ? 0 : 0.015 + 0.6 * (1 - keep) * (1 - keep);
  const ch: Record<string, Float64Array> = {};
  for (const name of STORED_NAMES) {
    const spec = STORED[name];
    ch[name] = spec.noSmooth ? d.ch[name] : smoothSeries(d.ch[name], sigma, d.loop, rangeFrac > 0 ? spec.big * rangeFrac : 0);
  }
  for (const g of QUAT_GROUPS) {
    const qs: Quat[] = [];
    for (let i = 0; i < d.frames; i++) qs.push([d.ch[g[0]][i], d.ch[g[1]][i], d.ch[g[2]][i], d.ch[g[3]][i]]);
    const sm = smoothQuatSeries(qs, sigma, d.loop, rangeFrac > 0 ? (90 * rangeFrac * Math.PI) / 180 : 0);
    g.forEach((name, k) => {
      const a = new Float64Array(d.frames);
      for (let i = 0; i < d.frames; i++) a[i] = sm[i][k];
      ch[name] = a;
    });
  }
  return deriveSeries({ fps: d.fps, frames: d.frames, loop: d.loop, ch });
}

/* ------------------------------------------------------------------ reading */

const denseCache = new WeakMap<object, Map<string, Dense>>();

/** The take as dense data with smoothing applied at read time (cached per take object and setting). */
export function takeDense(take: MotionTake, s: Smoothing = { amount: 0 }): Dense {
  let m = denseCache.get(take);
  if (!m) denseCache.set(take, (m = new Map()));
  const key = smoothingKey(s);
  let d = m.get(key);
  if (!d) {
    let base = m.get('base');
    if (!base) m.set('base', (base = denseFromTracks(take.baked ?? take.raw, take.fps, take.frames, take.loop)));
    d = s.amount > 0 ? smoothDense(base, s) : base;
    m.set(key, d);
  }
  return d;
}

/** The raw (as recorded) dense data, ignoring any baked smoothing. */
export function takeRawDense(take: MotionTake): Dense {
  let m = denseCache.get(take);
  if (!m) denseCache.set(take, (m = new Map()));
  let d = m.get('raw');
  if (!d) m.set('raw', (d = denseFromTracks(take.raw, take.fps, take.frames, take.loop)));
  return d;
}

/** Bake smoothing into the take (the raw tracks stay, so it can be reset). */
export function bakeSmoothing(take: MotionTake, s: Smoothing): MotionTake {
  const base = denseFromTracks(take.baked ?? take.raw, take.fps, take.frames, take.loop);
  const sm = smoothDense(base, s);
  return { ...take, baked: tracksFromDense(sm.ch, sm.frames) };
}
export const resetToRaw = (take: MotionTake): MotionTake => ({ ...take, baked: null });

export function takeDuration(take: MotionTake): number {
  return take.frames / take.fps;
}

/** Value of every channel at `seconds`. Loops when the take loops (or `forceLoop`), otherwise holds the ends. */
export function sampleTake(d: Dense, seconds: number, forceLoop = false): MotionFrame {
  const n = d.frames;
  const loop = d.loop || forceLoop;
  let f = seconds * d.fps;
  if (loop) f = ((f % n) + n) % n;
  else f = Math.max(0, Math.min(n - 1, f));
  const i0 = Math.floor(f);
  const i1 = loop ? (i0 + 1) % n : Math.min(n - 1, i0 + 1);
  const u = f - i0;
  const out: MotionFrame = {};
  for (const name of ALL_CHANNELS) {
    const a = d.ch[name];
    out[name] = name === 'tc' || name === 'tap' ? (u < 0.5 ? a[i0] : a[i1]) : a[i0] + (a[i1] - a[i0]) * u;
  }
  for (const g of QUAT_GROUPS) {
    const q = qNorm(qSlerp([d.ch[g[0]][i0], d.ch[g[1]][i0], d.ch[g[2]][i0], d.ch[g[3]][i0]], [d.ch[g[0]][i1], d.ch[g[1]][i1], d.ch[g[2]][i1], d.ch[g[3]][i1]], u));
    g.forEach((name, k) => (out[name] = q[k]));
  }
  return out;
}

/** Re-export so callers do not need two imports for the common relative-pose helper. */
export { relativeTo };
