/**
 * History helpers for number nodes that smooth, hold or delay a signal.
 * The engine is stateless, so "the past" is fetched with ctx.pull at earlier frames.
 */
import { mod } from './util-time';

export const MAX_PULLS = 96;

export interface HistoryPlan {
  /** Frames between samples (1 = every frame; larger when the window is too long for the pull cap). */
  stride: number;
  /** Number of samples including the current one. */
  count: number;
  /** Seconds between samples. */
  dt: number;
}

/** Choose a stride and sample count that cover `windowFrames` past frames with at most `cap` samples. */
export function planHistory(windowFrames: number, fps: number, cap = MAX_PULLS): HistoryPlan {
  const frames = Math.max(1, Math.ceil(windowFrames));
  const stride = Math.max(1, Math.ceil(frames / (cap - 1)));
  const count = Math.min(cap, Math.floor(frames / stride) + 1);
  return { stride, count, dt: stride / fps };
}

export interface TimeBits {
  frame: number;
  fps: number;
  duration: number;
  loop: boolean;
}

/** Frame to read for `back` frames before `frame`: wraps around the project when loopAware, else clamps at 0. */
export function pastFrame(t: TimeBits, back: number, loopAware: boolean): number {
  const f = t.frame - back;
  if (loopAware && t.loop) return mod(f, Math.max(1, Math.round(t.duration * t.fps)));
  return Math.max(0, f);
}

/**
 * Fetch x(t - i*stride frames) for i = 1..count-1. Returns the samples NEWEST FIRST (index 0 = `current`),
 * or null when the input is not wired (the first pull comes back empty): callers then just pass the value on.
 */
export async function gatherHistory(
  pull: (seconds: number) => Promise<number | null>,
  current: number,
  t: TimeBits,
  plan: HistoryPlan,
  loopAware: boolean,
): Promise<number[] | null> {
  const frames = new Map<number, Promise<number | null>>();
  const at = (f: number) => {
    let p = frames.get(f);
    if (!p) {
      p = pull(f / t.fps);
      frames.set(f, p);
    }
    return p;
  };
  const wanted: number[] = [];
  for (let i = 1; i < plan.count; i++) wanted.push(pastFrame(t, i * plan.stride, loopAware));
  if (!wanted.length) return [current];
  const values = await Promise.all(wanted.map(at));
  if (values[0] === null) return null;
  return [current, ...values.map((v) => v ?? current)];
}

/** Shortest signed distance from a to b on a circle of `period`. */
export function angleDelta(d: number, period: number): number {
  return d - period * Math.round(d / period);
}

/** Make an oldest-first sequence continuous across the wrap point (no jumps larger than period/2). */
export function unwrapSeq(seq: number[], period: number): number[] {
  const out = [seq[0]];
  for (let i = 1; i < seq.length; i++) out.push(out[i - 1] + angleDelta(seq[i] - seq[i - 1], period));
  return out;
}

/** Exponential follow with separate rise and fall times (seconds; 0 = instant). Oldest-first in, final value out. */
export function easeSeq(seq: number[], dt: number, rise: number, fall: number): number {
  const aUp = rise > 0 ? 1 - Math.exp(-dt / rise) : 1;
  const aDown = fall > 0 ? 1 - Math.exp(-dt / fall) : 1;
  let y = seq[0];
  for (let i = 1; i < seq.length; i++) y += (seq[i] - y) * (seq[i] > y ? aUp : aDown);
  return y;
}

/** Limit change per second (0 = unlimited in that direction). Oldest-first in, final value out. */
export function slewSeq(seq: number[], dt: number, riseRate: number, fallRate: number): number {
  let y = seq[0];
  for (let i = 1; i < seq.length; i++) {
    const d = seq[i] - y;
    if (d > 0) y += riseRate > 0 ? Math.min(d, riseRate * dt) : d;
    else y += fallRate > 0 ? Math.max(d, -fallRate * dt) : d;
  }
  return y;
}

/** Step response of a unit-DC-gain second-order system (natural frequency w rad/s, damping ratio z). */
export function springStep(t: number, w: number, z: number): number {
  if (t <= 0) return 0;
  if (z >= 0.9999) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/**
 * Causal FIR weights (newest first) of a spring: w_k = S((k+1)dt) - S(k dt), normalised to sum 1.
 * Non-negative (so no overshoot) when z >= 1.
 */
export function springKernel(count: number, dt: number, w: number, z: number): number[] {
  const k: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = springStep((i + 1) * dt, w, z) - springStep(i * dt, w, z);
    k.push(v);
    sum += v;
  }
  return sum > 0 ? k.map((v) => v / sum) : [1];
}

/** Time (seconds) after which the spring's response has settled to ~1%. */
export function springSettle(w: number, z: number): number {
  return 4.6 / Math.max(1e-3, Math.min(1, z) * w);
}
