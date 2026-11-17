/**
 * Beat grid of an analysed track, evaluated as a pure function of time (pure, no imports: bundled into the AudioWorklet).
 * Nudges (`offset`, `bpmOverride`, half / double time, loop snap) are applied here, without allocating, so they can change while playing.
 */
import type { BeatAnalysis } from './beat';

export interface GridParams {
  /** Seconds added to every beat and onset (positive = later). */
  offset: number;
  /** 0 = use the analysed beats; otherwise a regular grid at this tempo, anchored on the first analysed beat. */
  bpmOverride: number;
  half: boolean;
  double: boolean;
  /** With loop on and a known duration: make a regular grid whose beats divide the loop when the tempo nearly fits. */
  snap: boolean;
  loop: boolean;
  duration: number;
}

export interface GridPos {
  /** Beat index (0 = first beat of the track; negative before it). */
  index: number;
  /** 0..1 through the current beat. */
  phase: number;
  /** Seconds of the current beat. */
  period: number;
  /** Time of the current beat. */
  time: number;
}

/** Largest mismatch between a loop and a whole number of beats that `snap` will correct, in beats. */
export const SNAP_TOLERANCE = 0.12;

const jMin = -100000;

/** Period used for a regular grid (override and snap resolved). 0 when there is no usable tempo. */
export function regularPeriod(a: BeatAnalysis, g: GridParams): number {
  const bpm = g.bpmOverride > 0 ? g.bpmOverride : g.snap ? a.bpm : 0;
  if (bpm <= 0) return 0;
  let T = 60 / bpm;
  if (g.snap && g.loop && g.duration > 0) {
    const n = Math.round(g.duration / T);
    if (n >= 1 && Math.abs(n * T - g.duration) <= SNAP_TOLERANCE * T) T = g.duration / n;
  }
  return g.double ? T / 2 : g.half ? T * 2 : T;
}

function baseTime(b: number[], j: number): number {
  const m = b.length;
  if (j < 0) return b[0] + j * (m > 1 ? (b[m - 1] - b[0]) / (m - 1) : 0.5);
  if (j >= m) return b[m - 1] + (j - m + 1) * (m > 1 ? (b[m - 1] - b[0]) / (m - 1) : 0.5);
  return b[j];
}

/** Time of beat `j` of the nudged grid. */
export function beatTime(a: BeatAnalysis, g: GridParams, j: number, regT: number): number {
  if (regT > 0) {
    const anchor = a.beats.length ? a.beats[0] : 0;
    return anchor + j * regT + g.offset;
  }
  const b = a.beats;
  if (g.double) {
    const h = Math.floor(j / 2);
    return (j & 1 ? 0.5 * (baseTime(b, h) + baseTime(b, h + 1)) : baseTime(b, h)) + g.offset;
  }
  if (g.half) return baseTime(b, 2 * j) + g.offset;
  return baseTime(b, j) + g.offset;
}

/** True when the analysis has a beat grid to evaluate (regular override or at least two analysed beats). */
export function hasGrid(a: BeatAnalysis | null | undefined, g: GridParams): a is BeatAnalysis {
  if (!a || !Array.isArray(a.beats)) return false;
  return a.beats.length >= 2 || (g.bpmOverride > 0 && a.beats.length >= 1);
}

/** Locate time `t` on the grid. Binary search over beat indices (the grid is monotone). */
export function gridAt(a: BeatAnalysis, g: GridParams, t: number, out: GridPos): void {
  const regT = regularPeriod(a, g);
  let lo = jMin;
  let hi = a.beats.length * 2 + 100000;
  // largest j with beatTime(j) <= t
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beatTime(a, g, mid, regT) <= t) lo = mid;
    else hi = mid;
  }
  const t0 = beatTime(a, g, lo, regT);
  const t1 = beatTime(a, g, lo + 1, regT);
  const period = Math.max(1e-3, t1 - t0);
  out.index = lo;
  out.time = t0;
  out.period = period;
  out.phase = Math.min(1, Math.max(0, (t - t0) / period));
}

/** Last event time <= `t` in an ascending list (after adding `offset`), or -Infinity. */
export function lastEvent(times: number[] | undefined, t: number, offset: number): number {
  if (!times || !times.length) return -Infinity;
  let lo = -1;
  let hi = times.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] + offset <= t) lo = mid;
    else hi = mid;
  }
  return lo < 0 ? -Infinity : times[lo] + offset;
}

/** Pulse that is 1 at the event and falls to about 5 % after `decaySec`. */
export function pulse(sinceEvent: number, decaySec: number): number {
  if (!(sinceEvent >= 0) || !Number.isFinite(sinceEvent)) return 0;
  const v = Math.exp((-3 * sinceEvent) / Math.max(1e-3, decaySec));
  return v < 0.001 ? 0 : v;
}

/** Validate a stored analysis (project files can hold anything). */
export function asAnalysis(x: unknown): BeatAnalysis | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const grid = (o.grid ?? o) as Record<string, unknown>;
  if (!grid || typeof grid !== 'object' || grid.version !== 1 || !Array.isArray(grid.beats) || !Array.isArray(grid.onsets)) return null;
  return grid as unknown as BeatAnalysis;
}
