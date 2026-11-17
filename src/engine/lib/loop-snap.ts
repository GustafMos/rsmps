/**
 * Loop snapping: ONE place for the maths that makes an animation repeat exactly over the project length without the user choosing
 * special numbers. Pure functions on plain numbers (no GPU, no clock), shared by the nodes, their summaries and the tests.
 *
 * The rules (also in docs/ENGINE.md, "Loop snapping"):
 *  - a rate in "per loop" terms is rounded to the nearest whole number of cycles when Loop is on; never to 0 unless the typed value is 0
 *    (a value with 0 < |v| < 1 goes to +-1) -> `wholeCycles`;
 *  - a rate in "per second" terms is converted so that a whole number of cycles fits the loop -> `cyclesPerLoop` / `hzForLoop`;
 *  - a period in frames ("every N frames") becomes the nearest divisor of the frame count, or keeps its value with a shortened last
 *    epoch -> `snapPeriod` / `epochOf`;
 *  - a discrete sequence riding on a cycle (palette colours, a hue step, a stagger) must close together with it: either the travel is
 *    rounded to a multiple of the sequence length -> `closeSequence`, or the sequence drifts by the remainder over the loop ->
 *    `closingDrift`, or it is stretched so its period divides the travel -> `stretchedStep`.
 * With Loop off every function returns its input unchanged.
 */

/** What a node needs to know about the project clock to snap (a subset of TimeInfo; summaries get the same three numbers). */
export interface LoopClock {
  loop: boolean;
  /** Loop length in frames. */
  frames: number;
  fps: number;
}

/** Project settings -> LoopClock (frames = round(duration * fps), at least 1). */
export function loopClockOf(p: { loop: boolean; duration: number; fps: number }): LoopClock {
  return { loop: p.loop, frames: Math.max(1, Math.round(p.duration * p.fps)), fps: p.fps };
}

/** Loop length in seconds. */
export const loopSeconds = (c: LoopClock): number => c.frames / c.fps;

/**
 * A rate in cycles per loop -> a whole number of cycles. Rounds half away from zero; a non-zero value never becomes 0
 * (0 < |v| < 1 goes to +-1). Loop off (or a non-finite value): unchanged.
 */
export function wholeCycles(rate: number, loop = true): number {
  if (!loop || !Number.isFinite(rate) || rate === 0) return rate;
  const r = Math.sign(rate) * Math.round(Math.abs(rate));
  return r === 0 ? Math.sign(rate) : r;
}

/** A rate per second -> whole cycles per loop of `seconds` (same rounding rule as `wholeCycles`). Loop off: rate * seconds, unchanged. */
export function cyclesPerLoop(ratePerSecond: number, seconds: number, loop = true): number {
  return wholeCycles(ratePerSecond * seconds, loop);
}

/** The per-second rate that fits a whole number of cycles in `seconds`. Loop off: returned unchanged. */
export function hzForLoop(ratePerSecond: number, seconds: number, loop = true): number {
  if (!loop || !(seconds > 0)) return ratePerSecond;
  return cyclesPerLoop(ratePerSecond, seconds, true) / seconds;
}

/** All divisors of `n` (n >= 1), ascending. */
export function divisors(n: number): number[] {
  const out: number[] = [];
  const big: number[] = [];
  const m = Math.max(1, Math.round(n));
  for (let d = 1; d * d <= m; d++) {
    if (m % d) continue;
    out.push(d);
    if (d * d !== m) big.push(m / d);
  }
  return [...out, ...big.reverse()];
}

/** A period in frames -> the nearest divisor of `frames` (at least 1; ties go to the shorter). Loop off: unchanged. */
export function snapPeriod(frames: number, period: number, loop = true): number {
  if (!loop || !Number.isFinite(period)) return period;
  const want = Math.max(1, period);
  let best = 1;
  let bestDist = Infinity;
  for (const d of divisors(frames)) {
    const dist = Math.abs(d - want);
    if (dist < bestDist - 1e-9) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Epoch number of a frame when something changes "every `period` frames" and the loop is `frames` long: the LAST epoch is shortened,
 * so the sequence starts over exactly at frame 0 (epoch ids are `0 .. ceil(frames / period) - 1`, never a period that straddles the seam).
 * `frame` is wrapped into the loop first. Loop off: plain floor(frame / period).
 */
export function epochOf(frame: number, frames: number, period: number, loop = true): number {
  const p = Math.max(1, Math.round(period));
  const f = loop ? ((Math.round(frame) % frames) + frames) % frames : Math.max(0, Math.round(frame));
  return Math.floor(f / p);
}

/** Number of epochs of a loop of `frames` when something changes every `period` frames (the last one may be shorter). */
export function epochCount(frames: number, period: number): number {
  return Math.max(1, Math.ceil(frames / Math.max(1, Math.round(period))));
}

/**
 * Pose number of an epoch when something cycles through `poses` poses (a hand-drawn "boil"): epoch mod poses, so the pattern repeats exactly
 * over a loop of any length. When the last epoch would show the same pose as the first (the seam would hold one pose twice) it takes the
 * next one instead.
 */
export function cyclePose(epoch: number, epochs: number, poses: number): number {
  const n = Math.max(1, Math.round(poses));
  const p = ((epoch % n) + n) % n;
  return n > 1 && epochs > 1 && epoch === epochs - 1 && p === 0 ? 1 : p;
}

/** Frame number inside the loop (wrapped) for hashes that must repeat. */
export function loopFrameOf(frame: number, frames: number, loop = true): number {
  const f = Math.round(frame);
  return loop ? ((f % frames) + frames) % frames : f;
}

export interface Closed {
  /** The travel to use (signed). */
  travel: number;
  /** True when it differs from what was asked. */
  snapped: boolean;
}

/**
 * Close a discrete sequence of `length` entries (palette colours, a pattern) that rides on a travel of `travel` levels per loop by
 * ROUNDING THE TRAVEL to the nearest multiple of `length` (at least 1 x length). Used only when that is close to what was asked
 * (within `tolerance` of the asked travel, default +-50%); otherwise the travel is kept and `snapped` is false: the caller closes the
 * sequence another way (`closingDrift`, `stretchedStep`). A travel that already is a multiple, or a length <= 1, is returned as is.
 */
export function closeSequence(travel: number, length: number, tolerance = 0.5): Closed {
  const L = Math.max(1, Math.round(length));
  const T = Math.abs(travel);
  if (T === 0 || L <= 1 || T % L === 0) return { travel, snapped: false };
  const multiple = Math.max(1, Math.round(T / L)) * L;
  if (Math.abs(multiple - T) > tolerance * T) return { travel, snapped: false };
  return { travel: Math.sign(travel) * multiple, snapped: true };
}

/** A travel rounded to the nearest multiple of `length` (at least 1 x length; 0 stays 0). For things that cannot be blended (pictures picked per copy). */
export function snapMultiple(travel: number, length: number): number {
  const L = Math.max(1, Math.round(length));
  if (travel === 0 || L <= 1) return travel;
  return Math.sign(travel) * Math.max(1, Math.round(Math.abs(travel) / L)) * L;
}

/**
 * How far a sequence of `length` entries must drift, in entries per loop, so that it closes with a travel of `travel`:
 * `length * round(travel / length) - travel` (|result| <= length / 2; 0 when the travel is a multiple). A copy whose index is
 * `k + drift * phase` ends the loop on the entry its neighbour started it on.
 */
export function closingDrift(travel: number, length: number): number {
  const L = Math.max(1, Math.round(length));
  if (L <= 1) return 0;
  const d = L * Math.round(travel / L) - travel;
  return Math.abs(d) < 1e-9 ? 0 : d;
}

/**
 * The same for a continuous cycle (a hue step): the drift, in turns per loop, so that `travel * stepTurns` plus the drift is a whole
 * number of turns. `stepTurns` is the step per level in turns (degrees / 360).
 */
export function closingTurns(travel: number, stepTurns: number): number {
  const total = travel * stepTurns;
  const d = Math.round(total) - total;
  return Math.abs(d) < 1e-9 ? 0 : d;
}

/**
 * Stretch a per-level step so the sequence closes: the multiplier for a palette index (`index = k * result`) so that a travel of
 * `travel` levels advances it by a whole number (>= 1) of palette lengths. 1 when the travel is already a multiple.
 */
export function stretchedStep(travel: number, length: number): number {
  const L = Math.max(1, Math.round(length));
  const T = Math.abs(travel);
  if (T === 0 || L <= 1 || T % L === 0) return 1;
  return (Math.max(1, Math.round(T / L)) * L) / T;
}

/** The per-level hue step (turns) stretched so `travel` levels make a whole number (>= 1) of turns. Unchanged when it already does. */
export function stretchedTurns(travel: number, stepTurns: number): number {
  const T = Math.abs(travel);
  if (T === 0 || stepTurns === 0) return stepTurns;
  const total = T * Math.abs(stepTurns);
  if (Math.abs(total - Math.round(total)) < 1e-9 && Math.round(total) >= 1) return stepTurns;
  return (Math.sign(stepTurns) * Math.max(1, Math.round(total))) / T;
}

/** Short text for a node summary when snapping changed a value: `speed 2 -> 3 to loop`. Empty when nothing changed. */
export function snapNote(label: string, typed: number, effective: number): string {
  if (Math.abs(typed - effective) < 1e-6) return '';
  const f = (n: number) => String(Math.round(n * 100) / 100);
  return `${label} ${f(typed)} → ${f(effective)} to loop`;
}
