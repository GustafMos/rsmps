/**
 * Keyframe curves: evaluation, editing helpers and presets. Pure functions (no GPU, no DOM) so the
 * curve editor UI and the nodes share exactly the same maths.
 *
 * A curve is `{ keys: CurveKey[] }`. `t` is the position in the loop (0..1), `v` the value.
 * `interp` describes the segment AFTER a key: 'hold' (step), 'linear', 'smooth' (cubic through
 * the neighbouring keys) or 'bezier' (handles `out` of this key and `in` of the next key, as offsets [dt, dv]).
 * With `loop: true` the curve is periodic: the segment after the last key runs to the first key + 1,
 * and tangents at the wrap match.
 */
import type { CurveKey, CurveValue } from '../types';
import { ease } from './util-ease';
import { waveValue } from './util-wave';

export type CurveInterp = CurveKey['interp'];

export interface CurveOpts {
  /** Periodic curve: the end flows into the start. Default false (values hold before the first / after the last key). */
  loop?: boolean;
  /** 'smooth' segments never overshoot between keys. Default true. */
  monotone?: boolean;
}

/** Smallest time gap kept between two keys when editing. */
export const MIN_KEY_GAP = 1e-4;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fin = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const mod1 = (x: number) => x - Math.floor(x);

/* ----------------------------------------------------------------------- */
/* Normalising                                                              */
/* ----------------------------------------------------------------------- */

function cleanHandle(h: unknown): [number, number] | undefined {
  if (!Array.isArray(h) || h.length < 2 || !Number.isFinite(h[0]) || !Number.isFinite(h[1])) return undefined;
  return [h[0], h[1]];
}

/** Sort by time, clamp t to 0..1, drop duplicates (the later one wins), repair bad numbers. Never returns zero keys. */
export function normalizeCurve(curve: CurveValue | null | undefined): CurveValue {
  const raw = Array.isArray(curve?.keys) ? curve!.keys : [];
  const keys: CurveKey[] = raw.map((k) => {
    const out: CurveKey = {
      t: clamp(fin(k.t, 0), 0, 1),
      v: fin(k.v, 0),
      interp: k.interp === 'hold' || k.interp === 'linear' || k.interp === 'bezier' ? k.interp : 'smooth',
    };
    const hin = cleanHandle(k.in);
    const hout = cleanHandle(k.out);
    if (hin) out.in = hin;
    if (hout) out.out = hout;
    return out;
  });
  keys.sort((a, b) => a.t - b.t);
  const dedup: CurveKey[] = [];
  for (const k of keys) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].t - k.t) < 1e-9) dedup[dedup.length - 1] = k;
    else dedup.push(k);
  }
  if (!dedup.length) dedup.push({ t: 0, v: 0, interp: 'smooth' });
  return { keys: dedup };
}

/* ----------------------------------------------------------------------- */
/* Evaluation                                                               */
/* ----------------------------------------------------------------------- */

interface PK {
  t: number;
  v: number;
  interp: CurveInterp;
  in?: [number, number];
  out?: [number, number];
}

/** Key accessor: periodic extension when looping, undefined outside the range otherwise. */
function accessor(keys: CurveKey[], loop: boolean): (i: number) => PK | undefined {
  const n = keys.length;
  return (i) => {
    if (loop) {
      const k = keys[((i % n) + n) % n];
      return { ...k, t: k.t + Math.floor(i / n) };
    }
    return i >= 0 && i < n ? keys[i] : undefined;
  };
}

/** Tangent (dv/dt) at key i used by 'smooth' segments and for automatic bezier handles. */
function slopeAt(get: (i: number) => PK | undefined, i: number, monotone: boolean): number {
  const cur = get(i)!;
  const prev = get(i - 1);
  const next = get(i + 1);
  const d0 = prev && cur.t - prev.t > 1e-12 ? (cur.v - prev.v) / (cur.t - prev.t) : undefined;
  const d1 = next && next.t - cur.t > 1e-12 ? (next.v - cur.v) / (next.t - cur.t) : undefined;
  if (d0 === undefined && d1 === undefined) return 0;
  if (d0 === undefined) return d1!;
  if (d1 === undefined) return d0;
  if (monotone) {
    if (d0 * d1 <= 0) return 0;
    const h0 = cur.t - prev!.t;
    const h1 = next!.t - cur.t;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / d0 + w2 / d1);
  }
  return (next!.v - prev!.v) / (next!.t - prev!.t);
}

/** Effective bezier control points of the segment from key i to key i+1 (handles clamped so time never runs backwards). */
function bezierPoints(get: (i: number) => PK | undefined, i: number, monotone: boolean): { x1: number; y1: number; x2: number; y2: number } {
  const a = get(i)!;
  const b = get(i + 1)!;
  const h = b.t - a.t;
  const dtOut = a.out ? a.out[0] : h / 3;
  const dvOut = a.out ? a.out[1] : (slopeAt(get, i, monotone) * h) / 3;
  const dtIn = b.in ? b.in[0] : -h / 3;
  const dvIn = b.in ? b.in[1] : (-slopeAt(get, i + 1, monotone) * h) / 3;
  return {
    x1: a.t + clamp(dtOut, 0, h),
    y1: a.v + dvOut,
    x2: b.t + clamp(dtIn, -h, 0),
    y2: b.v + dvIn,
  };
}

function evalSegment(get: (i: number) => PK | undefined, i: number, x: number, monotone: boolean): number {
  const a = get(i)!;
  const b = get(i + 1)!;
  const h = b.t - a.t;
  if (h <= 1e-12) return x >= b.t ? b.v : a.v;
  const s = clamp((x - a.t) / h, 0, 1);
  switch (a.interp) {
    case 'hold':
      return a.v;
    case 'linear':
      return a.v + (b.v - a.v) * s;
    case 'smooth': {
      const ma = slopeAt(get, i, monotone) * h;
      const mb = slopeAt(get, i + 1, monotone) * h;
      const s2 = s * s;
      const s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * ma + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * mb;
    }
    default: {
      const p = bezierPoints(get, i, monotone);
      // x(u) is monotone because the control x's are inside [a.t, b.t]; bisect for u, then read y(u).
      const bez = (p0: number, p1: number, p2: number, p3: number, u: number) => {
        const m = 1 - u;
        return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
      };
      let lo = 0;
      let hi = 1;
      let u = s;
      for (let it = 0; it < 32; it++) {
        u = (lo + hi) / 2;
        if (bez(a.t, p.x1, p.x2, b.t, u) < x) lo = u;
        else hi = u;
      }
      return bez(a.v, p.y1, p.y2, b.v, u);
    }
  }
}

function evalPrepared(keys: CurveKey[], t: number, loop: boolean, monotone: boolean): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1) return keys[0].v;
  const get = accessor(keys, loop);
  let x: number;
  let i: number;
  if (loop) {
    x = mod1(t);
    i = -1;
    for (let k = 0; k < n; k++) if (keys[k].t <= x) i = k;
  } else {
    x = clamp(t, 0, 1);
    if (x <= keys[0].t) return keys[0].v;
    if (x >= keys[n - 1].t) return keys[n - 1].v;
    i = 0;
    for (let k = 0; k < n - 1; k++) if (keys[k].t <= x) i = k;
  }
  return evalSegment(get, i, x, monotone);
}

/** Value of the curve at position t (0..1). Looping curves wrap t; others clamp it. */
export function evalCurve(curve: CurveValue, t: number, opts: CurveOpts = {}): number {
  return evalPrepared(normalizeCurve(curve).keys, t, !!opts.loop, opts.monotone !== false);
}

/** Slope dv/dt at t (numeric). */
export function evalCurveSlope(curve: CurveValue, t: number, opts: CurveOpts = {}): number {
  const keys = normalizeCurve(curve).keys;
  const loop = !!opts.loop;
  const mono = opts.monotone !== false;
  const h = 1e-5;
  return (evalPrepared(keys, t + h, loop, mono) - evalPrepared(keys, t - h, loop, mono)) / (2 * h);
}

/** `n` evenly spaced samples [t, v] from t = 0 to t = 1 (inclusive), for drawing. */
export function sampleCurve(curve: CurveValue, n: number, opts: CurveOpts = {}): [number, number][] {
  const keys = normalizeCurve(curve).keys;
  const count = Math.max(2, Math.floor(n));
  const out: [number, number][] = [];
  const loop = !!opts.loop;
  const mono = opts.monotone !== false;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    // t = 1 is the start of the next period for looping curves: show the end of this one instead
    out.push([t, evalPrepared(keys, loop && i === count - 1 ? 1 - 1e-9 : t, loop, mono)]);
  }
  return out;
}

/** Value range of the curve (sampled, including the keys). */
export function curveBounds(curve: CurveValue, opts: CurveOpts = {}): { tMin: number; tMax: number; vMin: number; vMax: number } {
  const keys = normalizeCurve(curve).keys;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [, v] of sampleCurve(curve, 256, opts)) {
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  for (const k of keys) {
    vMin = Math.min(vMin, k.v);
    vMax = Math.max(vMax, k.v);
  }
  return { tMin: 0, tMax: 1, vMin, vMax };
}

/* ----------------------------------------------------------------------- */
/* Editing helpers (all return new curves; inputs are never mutated)        */
/* ----------------------------------------------------------------------- */

/** Insert a key. `v` defaults to the curve's current value at t. Returns the new curve and the index of the new key. */
export function addKey(curve: CurveValue, t: number, v?: number, interp: CurveInterp = 'smooth', opts: CurveOpts = {}): { curve: CurveValue; index: number } {
  const base = normalizeCurve(curve);
  const tt = clamp(t, 0, 1);
  const existing = base.keys.findIndex((k) => Math.abs(k.t - tt) < MIN_KEY_GAP);
  const value = v ?? evalCurve(base, tt, opts);
  if (existing >= 0) {
    const keys = base.keys.map((k, i) => (i === existing ? { ...k, v: value } : k));
    return { curve: { keys }, index: existing };
  }
  const keys = [...base.keys, { t: tt, v: value, interp }].sort((a, b) => a.t - b.t);
  return { curve: { keys }, index: keys.findIndex((k) => k.t === tt) };
}

/** Remove a key (a curve always keeps at least one). */
export function removeKey(curve: CurveValue, index: number): CurveValue {
  const base = normalizeCurve(curve);
  if (base.keys.length <= 1 || index < 0 || index >= base.keys.length) return base;
  return { keys: base.keys.filter((_, i) => i !== index) };
}

/** Move a key in time and/or value. Time is clamped to 0..1 and to between its neighbours, so order is kept. Handles move with it. */
export function moveKey(curve: CurveValue, index: number, t: number, v?: number): CurveValue {
  const base = normalizeCurve(curve);
  if (index < 0 || index >= base.keys.length) return base;
  const lo = index > 0 ? base.keys[index - 1].t + MIN_KEY_GAP : 0;
  const hi = index < base.keys.length - 1 ? base.keys[index + 1].t - MIN_KEY_GAP : 1;
  const tt = lo > hi ? base.keys[index].t : clamp(t, lo, hi);
  return { keys: base.keys.map((k, i) => (i === index ? { ...k, t: tt, v: v === undefined ? k.v : fin(v, k.v) } : k)) };
}

/** Change how the segment after key `index` is interpolated. */
export function setInterp(curve: CurveValue, index: number, interp: CurveInterp): CurveValue {
  const base = normalizeCurve(curve);
  return { keys: base.keys.map((k, i) => (i === index ? { ...k, interp } : k)) };
}

/** Set bezier handles of a key (offsets [dt, dv]). Pass `null` to remove one handle (back to automatic). */
export function setHandles(curve: CurveValue, index: number, handles: { in?: [number, number] | null; out?: [number, number] | null }): CurveValue {
  const base = normalizeCurve(curve);
  return {
    keys: base.keys.map((k, i) => {
      if (i !== index) return k;
      const next: CurveKey = { ...k };
      if (handles.in === null) delete next.in;
      else if (handles.in) next.in = [handles.in[0], handles.in[1]];
      if (handles.out === null) delete next.out;
      else if (handles.out) next.out = [handles.out[0], handles.out[1]];
      return next;
    }),
  };
}

/** Write automatic (smooth, optionally non-overshooting) bezier handles on every key; with `loop` the tangents match across the wrap. */
export function autoTangents(curve: CurveValue, opts: CurveOpts = {}): CurveValue {
  const base = normalizeCurve(curve);
  const loop = !!opts.loop;
  const monotone = opts.monotone !== false;
  const get = accessor(base.keys, loop);
  const n = base.keys.length;
  if (n < 2) return base;
  return {
    keys: base.keys.map((k, i) => {
      const m = slopeAt(get, i, monotone);
      const next = get(i + 1);
      const prev = get(i - 1);
      const out: CurveKey = { ...k };
      if (next) out.out = [(next.t - k.t) / 3, (m * (next.t - k.t)) / 3];
      else delete out.out;
      if (prev) out.in = [-(k.t - prev.t) / 3, (-m * (k.t - prev.t)) / 3];
      else delete out.in;
      return out;
    }),
  };
}

/** Mirror the curve in time (t -> 1 - t). */
export function reverse(curve: CurveValue): CurveValue {
  const base = normalizeCurve(curve);
  const n = base.keys.length;
  const keys: CurveKey[] = base.keys.map((_, j) => {
    const k = base.keys[n - 1 - j];
    const before = base.keys[n - 2 - j]; // the key whose segment now follows this one
    const out: CurveKey = { t: 1 - k.t, v: k.v, interp: before ? before.interp : k.interp };
    if (k.out) out.in = [-k.out[0], k.out[1]];
    if (k.in) out.out = [-k.in[0], k.in[1]];
    return out;
  });
  return { keys };
}

/** Stretch the curve in time by `factor` (> 1 pushes keys past 1 and drops them; < 1 compresses it toward the start). */
export function scaleTime(curve: CurveValue, factor: number): CurveValue {
  const base = normalizeCurve(curve);
  const f = Math.max(0, fin(factor, 1));
  const keys = base.keys
    .map((k) => {
      const out: CurveKey = { ...k, t: k.t * f };
      if (k.in) out.in = [k.in[0] * f, k.in[1]];
      if (k.out) out.out = [k.out[0] * f, k.out[1]];
      return out;
    })
    .filter((k) => k.t <= 1 + 1e-9);
  return normalizeCurve({ keys });
}

/** Slide the curve in time by `dt`, wrapping around 0..1 (for looping curves). */
export function shiftTime(curve: CurveValue, dt: number): CurveValue {
  const base = normalizeCurve(curve);
  return normalizeCurve({ keys: base.keys.map((k) => ({ ...k, t: mod1(k.t + dt) })) });
}

/** Rescale values so the curve's range becomes [min, max]. A flat curve becomes `min`. */
export function fitToRange(curve: CurveValue, min: number, max: number, opts: CurveOpts = {}): CurveValue {
  const base = normalizeCurve(curve);
  const { vMin, vMax } = curveBounds(base, opts);
  const span = vMax - vMin;
  const map = (v: number) => (span < 1e-12 ? min : min + ((v - vMin) / span) * (max - min));
  const k = span < 1e-12 ? 0 : (max - min) / span;
  return {
    keys: base.keys.map((key) => {
      const out: CurveKey = { ...key, v: map(key.v) };
      if (key.in) out.in = [key.in[0], key.in[1] * k];
      if (key.out) out.out = [key.out[0], key.out[1] * k];
      return out;
    }),
  };
}

/* ----------------------------------------------------------------------- */
/* Presets                                                                  */
/* ----------------------------------------------------------------------- */

function sampled(f: (x: number) => number, n: number, interp: CurveInterp = 'smooth'): CurveValue {
  const keys: CurveKey[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    keys.push({ t, v: f(t), interp });
  }
  return { keys };
}

export const presetLinear = (): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 1, v: 1, interp: 'linear' }] });
export const presetEaseIn = (): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'bezier', out: [0.42, 0] }, { t: 1, v: 1, interp: 'bezier', in: [0, 0] }] });
export const presetEaseOut = (): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'bezier', out: [0.58, 1] }, { t: 1, v: 1, interp: 'bezier', in: [0, 0] }] });
export const presetEaseInOut = (): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'bezier', out: [0.42, 0] }, { t: 1, v: 1, interp: 'bezier', in: [-0.42, 0] }] });
export const presetBounce = (): CurveValue => sampled((x) => ease('bounce', x), 41);
export const presetOvershoot = (): CurveValue => sampled((x) => ease('overshoot', x), 25);
export const presetElastic = (): CurveValue => sampled((x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin(((x * 10 - 0.75) * (2 * Math.PI)) / 3) + 1), 49);
/** `n` equal steps from 0 up to 1. */
export function presetSteps(n: number): CurveValue {
  const count = Math.max(2, Math.round(n));
  return { keys: Array.from({ length: count }, (_, i) => ({ t: i / count, v: i / (count - 1), interp: 'hold' as const })) };
}
export const presetSawtooth = (): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 0.9999, v: 1, interp: 'linear' }] });
export const presetTriangle = (): CurveValue => ({ keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 0.5, v: 1, interp: 'linear' }] });
/** 1 for the first `duty` of the loop, then 0. */
export const presetPulse = (duty = 0.5): CurveValue => ({ keys: [{ t: 0, v: 1, interp: 'hold' }, { t: clamp(duty, MIN_KEY_GAP, 1 - MIN_KEY_GAP), v: 0, interp: 'hold' }] });

export const CURVE_PRESETS: { id: string; label: string; make: () => CurveValue }[] = [
  { id: 'linear', label: 'Straight line', make: presetLinear },
  { id: 'ease-in', label: 'Ease in', make: presetEaseIn },
  { id: 'ease-out', label: 'Ease out', make: presetEaseOut },
  { id: 'ease-in-out', label: 'Ease in and out', make: presetEaseInOut },
  { id: 'overshoot', label: 'Overshoot', make: presetOvershoot },
  { id: 'bounce', label: 'Bounce', make: presetBounce },
  { id: 'elastic', label: 'Elastic', make: presetElastic },
  { id: 'steps', label: 'Steps (4)', make: () => presetSteps(4) },
  { id: 'sawtooth', label: 'Sawtooth', make: presetSawtooth },
  { id: 'triangle', label: 'Triangle (there and back)', make: presetTriangle },
  { id: 'pulse', label: 'Pulse', make: () => presetPulse(0.5) },
];

/* ----------------------------------------------------------------------- */
/* From the Animate node                                                    */
/* ----------------------------------------------------------------------- */

export interface WaveSettings {
  wave: string;
  from: number;
  to: number;
  cycles: number;
  /** Start offset 0..1. */
  phase: number;
  easing: string;
  steps: number;
  seed: number;
}

/**
 * A looping curve equivalent to what the Animate node outputs over one project loop (use it with `loop: true`).
 * Keys never sit at exactly t = 1, since that is the start of the next period.
 */
export function animateToCurve(s: WaveSettings): CurveValue {
  const cycles = Math.max(0, Math.round(s.cycles));
  const val = (t: number) => {
    const w = waveValue({ wave: s.wave, t: t * cycles + s.phase, steps: s.steps, seed: s.seed, cycles });
    const shaped = s.wave === 'steps' || s.wave === 'square' ? w : ease(s.easing, w);
    return s.from + (s.to - s.from) * shaped;
  };
  if (cycles === 0) return { keys: [{ t: 0, v: val(0), interp: 'smooth' }] };
  const linearExact = s.easing === 'linear' && (s.wave === 'triangle' || s.wave === 'saw-up' || s.wave === 'saw-down');
  if (s.wave === 'square' || s.wave === 'steps') {
    const N = 2048;
    const keys: CurveKey[] = [];
    let prev = NaN;
    for (let i = 0; i < N; i++) {
      const v = val(i / N);
      if (v !== prev) keys.push({ t: i / N, v, interp: 'hold' });
      prev = v;
    }
    return { keys };
  }
  if (linearExact) {
    // breakpoints: every wave period boundary (and the peak for triangles)
    const period = 1 / cycles;
    const shift = (((-s.phase / cycles) % period) + period) % period;
    const marks = new Set<number>([0]);
    for (let k = -1; k <= cycles + 1; k++) {
      const base = shift + k * period;
      const pts = s.wave === 'triangle' ? [base, base + period / 2] : [base];
      for (const m of pts) if (m >= 0 && m < 1) marks.add(Math.round(m * 1e9) / 1e9);
    }
    const keys: CurveKey[] = [];
    for (const t of [...marks].sort((a, b) => a - b)) {
      if (s.wave !== 'triangle' && t > 0) keys.push({ t: Math.max(0, t - 1e-4), v: val(t - 1e-4), interp: 'linear' });
      keys.push({ t, v: val(t), interp: 'linear' });
    }
    if (s.wave !== 'triangle') keys.push({ t: 1 - 1e-4, v: val(1 - 1e-4), interp: 'linear' }); // end of the last ramp, just before the jump
    return normalizeCurve({ keys });
  }
  const perCycle = s.wave === 'noise' ? 24 : 16;
  const n = Math.min(256, Math.max(16, perCycle * cycles));
  const keys: CurveKey[] = [];
  for (let i = 0; i < n; i++) keys.push({ t: i / n, v: val(i / n), interp: 'smooth' });
  return { keys };
}
