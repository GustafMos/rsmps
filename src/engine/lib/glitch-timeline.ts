/**
 * The event timeline of Digital Glitch: a pure function of (seed, frame index mod loop length), so it is deterministic and the loop closes
 * exactly (an event that starts near the end of the loop carries on into its first frames).
 *
 * Real stream errors are ABRUPT (a new pattern appears on one frame and is held for a few frames, then it is gone), BURSTY (quiet stretches,
 * then several bad frames in a row) and different in KIND each time. So every frame is a candidate event start; the chance of a start is
 * `rate / fps` times a burst gain that is constant over windows of BURST_WINDOW frames (some windows are almost silent, a few are much
 * busier, the mean stays 1). An event lasts a long-tailed 1..MAX_HOLD frames. The frame being drawn belongs to the most recent event that
 * still covers it.
 */

export const KIND_NAMES = ['block', 'tear', 'split', 'smear', 'quant', 'stutter', 'timeTear', 'bitrot', 'scan', 'flash'] as const;
export type GlitchKind = (typeof KIND_NAMES)[number];
const KIND_STUTTER = 5;
const KIND_TIME_TEAR = 6;
const KIND_FLASH = 9;

export const MAX_HOLD = 16;
const BURST_WINDOW = 6;

export interface GlitchTimelineParams {
  seed: number;
  /** Events per second. */
  rate: number;
  /** 0 = events spread evenly, 1 = a few bursts and long clean stretches. */
  burst: number;
  /** Typical event length in frames. */
  hold: number;
  /** 0 = quiet stretches keep a light corruption, 1 = they are perfectly clean. */
  calm: number;
  intensity: number;
  /** Amount of each kind (KIND_NAMES order), 0..1: the chance that an event contains it. */
  kinds: number[];
  fps: number;
}

export interface GlitchEvent {
  /** Frame (mod total) where the event began. */
  start: number;
  /** Frames since the start (0 on the first frame). */
  age: number;
  /** Length in frames. */
  len: number;
  /** Pseudo random identity, 0..997: feeds the shader hashes. */
  key: number;
  /** Per kind strength, 0 = this kind is not part of the event. */
  strength: number[];
  /** True for the light corruption between events. */
  quiet: boolean;
  /** Frames the frozen picture is taken behind the event start (stutter) / the second time lags (time tear). */
  back: number;
  lag: number;
}

export function hash01(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 8) / 16777216;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Does an event start on frame `g`, and how long does it last (0 = none)? */
export function eventLength(g: number, total: number, p: GlitchTimelineParams): number {
  const seed = Math.round(p.seed);
  const win = Math.floor(g / BURST_WINDOW);
  // mean 1: a few windows are 4x busier than average, most are quiet
  const b = 0.85 * p.burst;
  const gain = 1 - b + b * 4 * hash01(seed, win, 2) ** 3;
  const prob = Math.min(0.85, Math.max(0, (p.rate / Math.max(1, p.fps)) * gain));
  if (hash01(seed, g, 1) >= prob) return 0;
  const hold = Math.max(1, p.hold);
  return Math.min(MAX_HOLD, 1 + Math.floor(2.7 * hold * hash01(seed, g, 3) ** 2.2));
}

/**
 * Which kinds an event that starts at frame `start` contains: one PRIMARY kind chosen with probability proportional to the amounts, plus each other
 * kind with a smaller chance (amount x 0.4), so most events are one clear fault and a few are a pile-up. `allowAlt` false removes the kinds
 * that need a second moment of the input.
 */
export function pickKinds(start: number, p: GlitchTimelineParams, strength: number, allowAlt: boolean): number[] {
  const seed = Math.round(p.seed);
  const out = new Array<number>(KIND_NAMES.length).fill(0);
  const w = KIND_NAMES.map((_, k) => (allowAlt || (k !== KIND_STUTTER && k !== KIND_TIME_TEAR) ? Math.max(0, p.kinds[k] ?? 0) : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return out;
  let pick = hash01(seed, start, 9) * sum;
  let primary = 0;
  for (let k = 0; k < w.length; k++) {
    if (pick < w[k]) { primary = k; break; }
    pick -= w[k];
  }
  for (let k = 0; k < w.length; k++) {
    if (w[k] <= 0) continue;
    if (k === primary || hash01(seed, start, 10 + k) < w[k] * 0.4) out[k] = Math.min(1.25, strength * (0.55 + 0.45 * w[k]) * (k === primary ? 1 : 0.7));
  }
  return out;
}

function makeEvent(start: number, age: number, len: number, p: GlitchTimelineParams, allowAlt: boolean, forced: boolean): GlitchEvent {
  const seed = Math.round(p.seed);
  // long-tailed strength: most events are middling, some are violent
  const strength = p.intensity * (0.25 + 1.0 * hash01(seed, start, 5) ** 1.8) * (forced ? 1.1 : 1);
  const strengths = pickKinds(start, p, strength, allowAlt);
  // a flash is a single bright frame: only the first frame of its event
  if (age > 1) strengths[KIND_FLASH] = 0;
  return {
    start,
    age,
    len,
    key: Math.floor(hash01(seed, start, 4) * 997),
    strength: strengths,
    quiet: false,
    back: 1 + Math.floor(hash01(seed, start, 6) * 6),
    lag: 2 + Math.floor(hash01(seed, start, 7) * 8),
  };
}

/**
 * The event frame `frame` belongs to (frame is the loop frame index, 0..total-1), or the light between-events corruption, or null when the
 * frame is clean. `forceFrom` (a trigger) starts a fresh event every `hold` frames for as long as it is on.
 */
export function glitchAt(frame: number, total: number, p: GlitchTimelineParams, opts: { allowAlt: boolean; trigger?: boolean } = { allowAlt: true }): GlitchEvent | null {
  const n = Math.max(1, total);
  const f = mod(frame, n);
  if (opts.trigger) {
    const h = Math.max(1, Math.round(p.hold));
    const start = f - (f % h);
    return makeEvent(start, f - start, h, { ...p, kinds: p.kinds.map((v) => (v > 0 ? Math.max(v, 0.5) : 0)) }, opts.allowAlt, true);
  }
  for (let j = 0; j < Math.min(MAX_HOLD, n); j++) {
    const s = mod(f - j, n);
    const len = eventLength(s, n, p);
    if (len > j) return makeEvent(s, j, len, p, opts.allowAlt, false);
  }
  if (p.calm >= 1) return null;
  // between events: a faint, constantly changing corruption (only the gentle kinds)
  const light = (1 - Math.max(0, p.calm)) * 0.5 * p.intensity;
  const gentle = new Array<number>(KIND_NAMES.length).fill(0);
  for (const k of [1, 2, 8]) gentle[k] = (p.kinds[k] ?? 0) > 0 ? light * (0.5 + 0.5 * hash01(Math.round(p.seed), f, 20 + k)) : 0;
  if (!gentle.some((v) => v > 0)) return null;
  return { start: f, age: 0, len: 1, key: Math.floor(hash01(Math.round(p.seed), f, 4) * 997), strength: gentle, quiet: true, back: 1, lag: 2 };
}

/** The single, fixed event of a frozen glitch (nothing reads the clock). */
export function frozenGlitch(p: GlitchTimelineParams): GlitchEvent {
  return makeEvent(0, 0, 1, p, false, true);
}
