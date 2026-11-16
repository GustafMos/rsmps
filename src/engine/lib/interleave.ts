/**
 * Frame maths of the Frame Interleave node, pure and shared by the node, its summary and the tests.
 *
 * Output frame n (0-based; the docs say "frame 1" for n = 0) of N wired sources:
 *   step    s = floor(n / hold)                       one picture is shown for `hold` output frames
 *   cycle   C = sum(pattern)                          pattern = how many consecutive steps each source gets (default 1 each)
 *   c = floor(s / C), r = s mod C                     cycle number and place inside the cycle
 *   wire k, j                                         the source whose run contains r, and r's place j inside that run
 * Which frame of that source is shown:
 *   in-step                       n                                (every source keeps running in step with the project)
 *   every-frame / longer          c * pattern[k] + j               (nothing skipped, each source advances one frame per step it is shown)
 *   every-frame / same-length     c * C * hold + j * hold          (every source shows the same moment within a cycle; real-time rate)
 * then + offsets[k] and folded into the source: wrapped inside `baseFrames` (loopSources) or clamped to its first / last frame.
 */
import { mod } from './util-time';

export type InterleaveMode = 'in-step' | 'every-frame';
export type InterleaveTiming = 'longer' | 'same-length';

export interface InterleaveOpts {
  mode: InterleaveMode;
  /** Only read for `every-frame`. */
  timing: InterleaveTiming;
  /** One entry per source (frames per cycle). Anything else (wrong length, bad numbers) means 1 each. */
  pattern: readonly number[];
  /** Output frames per step, >= 1. */
  hold: number;
  /** Start offset per source in frames; missing entries are 0. */
  offsets: readonly number[];
  /** Frames after which a source wraps (loopSources) or stops (clamped). 0 = unbounded. */
  baseFrames: number;
  loopSources: boolean;
}

export interface InterleaveFrame {
  /** Position among the wires of `sources`. */
  wire: number;
  /** Frame of that source (project frame grid). */
  sourceFrame: number;
  sourceSeconds: number;
  /** Which picture step the output frame belongs to (frames of one hold share it). */
  step: number;
}

const MAX_RUN = 64;

/**
 * Parse "2,1,3" (commas, semicolons or spaces) into a pattern for `count` sources. Empty = 1 each (valid). Wrong number of
 * entries, or anything that is not a whole number 1..64, is invalid: the result is then 1 each and `message` says why.
 */
export function parsePattern(text: unknown, count: number): { pattern: number[]; valid: boolean; message: string } {
  const n = Math.max(1, Math.floor(count) || 1);
  const ones = Array.from({ length: n }, () => 1);
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { pattern: ones, valid: true, message: '' };
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  if (!parts.every((x) => /^\d+$/.test(x) && Number(x) >= 1 && Number(x) <= MAX_RUN)) return { pattern: ones, valid: false, message: `pattern must be whole numbers 1 to ${MAX_RUN}` };
  if (parts.length !== n) return { pattern: ones, valid: false, message: `pattern needs ${n} number${n === 1 ? '' : 's'}, has ${parts.length}` };
  return { pattern: parts.map(Number), valid: true, message: '' };
}

/** "0, 12" -> [0, 12]. Anything that is not a whole number counts as 0. */
export function parseOffsets(text: unknown): number[] {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return [];
  return s.split(/[\s,;]+/).filter(Boolean).map((x) => (/^-?\d+$/.test(x) ? Number(x) : 0));
}

/** Output frames in one cycle (the sequence repeats after this many). */
export function cycleFrames(pattern: readonly number[], hold: number): number {
  return pattern.reduce((a, b) => a + b, 0) * Math.max(1, Math.floor(hold) || 1);
}

/** Pure mapping: output frame n -> which wire, which frame of it. */
export function interleaveFrame(n: number, fps: number, count: number, o: InterleaveOpts): InterleaveFrame {
  const N = Math.max(1, Math.floor(count) || 1);
  const hold = Math.max(1, Math.floor(o.hold) || 1);
  const frame = Math.max(0, Math.floor(n));
  const pat = o.pattern.length === N && o.pattern.every((x) => Number.isInteger(x) && x >= 1) ? o.pattern : Array.from({ length: N }, () => 1);
  const C = pat.reduce((a, b) => a + b, 0);
  const step = Math.floor(frame / hold);
  const cycle = Math.floor(step / C);
  const r = step - cycle * C;
  let wire = 0;
  let start = 0;
  while (wire < N - 1 && r >= start + pat[wire]) {
    start += pat[wire];
    wire++;
  }
  const j = r - start;
  let f: number;
  if (o.mode === 'in-step') f = frame;
  else if (o.timing === 'same-length') f = cycle * C * hold + j * hold;
  else f = cycle * pat[wire] + j;
  f += o.offsets[wire] ?? 0;
  if (o.baseFrames > 0) f = o.loopSources ? mod(f, o.baseFrames) : Math.min(Math.max(0, f), o.baseFrames - 1);
  else f = Math.max(0, f);
  return { wire, sourceFrame: f, sourceSeconds: f / (fps > 0 ? fps : 1), step };
}

/**
 * Length of the result in seconds when every frame of every source is shown once (every-frame / longer): the slowest-consuming source
 * (smallest pattern entry) needs `base / min` cycles, a cycle being C * hold frames. N equal sources, 1 each: N * base * hold.
 */
export function interleaveSeconds(baseSeconds: number, pattern: readonly number[], hold: number): number {
  if (!(baseSeconds > 0) || !pattern.length) return 0;
  const C = pattern.reduce((a, b) => a + b, 0);
  return (baseSeconds * C * Math.max(1, Math.floor(hold) || 1)) / Math.min(...pattern);
}

/** "cycle of 3 does not divide 96 frames", or '' when the loop closes on a whole cycle (or the length is unknown). */
export function cycleHint(cycle: number, totalFrames: number): string {
  if (!(totalFrames > 0) || cycle <= 1 || totalFrames % cycle === 0) return '';
  return `cycle of ${cycle} does not divide ${totalFrames} frames`;
}
