/**
 * Exposure timing: how many timeline frames each drawing is shot for ("on ones / twos / threes" plus per-drawing
 * holds). Pure. A hold list is indexed by drawing (recovered frame) number; missing or invalid entries use `shootOn`.
 */

export interface HoldOptions {
  /** Global default: 1 = on ones, 2 = on twos, 3 = on threes... (default 1). */
  shootOn?: number;
  /** Per-drawing frames to hold; entries that are not integers >= 1 fall back to `shootOn`. */
  holds?: readonly (number | null | undefined)[];
}

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** Hold count of every drawing (length `drawings`). */
export function resolveHolds(drawings: number, o: HoldOptions = {}): number[] {
  const on = clampInt(o.shootOn ?? 1, 1, 24);
  const out: number[] = [];
  for (let i = 0; i < drawings; i++) {
    const h = o.holds?.[i];
    out.push(typeof h === 'number' && Number.isFinite(h) && h >= 1 ? clampInt(h, 1, 240) : on);
  }
  return out;
}

/** The drawing shown on every timeline frame: `[0,0,1,1,2,2]` for three drawings on twos. */
export function expandTimeline(drawings: number, o: HoldOptions = {}): number[] {
  const out: number[] = [];
  resolveHolds(drawings, o).forEach((h, i) => {
    for (let k = 0; k < h; k++) out.push(i);
  });
  return out;
}

/** Timeline frame where each drawing first appears. */
export function startFrames(holds: readonly number[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const h of holds) {
    out.push(t);
    t += h;
  }
  return out;
}

export function totalFrames(holds: readonly number[]): number {
  return holds.reduce((s, h) => s + h, 0);
}

/** Drawing on timeline frame `t` (clamped to the last drawing). */
export function drawingAt(holds: readonly number[], t: number): number {
  let acc = 0;
  for (let i = 0; i < holds.length; i++) {
    acc += holds[i];
    if (t < acc) return i;
  }
  return Math.max(0, holds.length - 1);
}
