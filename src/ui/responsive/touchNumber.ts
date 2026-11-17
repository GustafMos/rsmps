/** Decisions for number fields on touch screens (pure; NumberField calls them). */

export type ScrubIntent = 'undecided' | 'scrub' | 'scroll';

/**
 * What a finger that went down on a number field is doing. A mostly horizontal drag scrubs the value; a mostly vertical one is the
 * user scrolling the page (the field leaves it alone). Under `slop` px it is still undecided (it may turn out to be a tap).
 */
export function scrubIntent(dx: number, dy: number, slop = 6): ScrubIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < slop) return 'undecided';
  return ax >= ay * 1.2 ? 'scrub' : 'scroll';
}

export interface StepRange {
  step: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

/** One press of a − / + button: moves by `step` (integers by at least 1), stays inside the range, avoids float dust like 0.30000000000000004. */
export function stepValue(value: number, dir: 1 | -1, r: StepRange): number {
  const step = r.integer ? Math.max(1, Math.round(r.step)) : r.step;
  let v = value + dir * step;
  if (r.integer) v = Math.round(v);
  else {
    const decimals = Math.min(10, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
    v = Number(v.toFixed(decimals));
  }
  if (r.min !== undefined) v = Math.max(r.min, v);
  if (r.max !== undefined) v = Math.min(r.max, v);
  return v;
}

/** True when a − / + pair should be offered: a coarse pointer and a field wide enough to hold it. */
export function wantsSteppers(coarse: boolean, width: number): boolean {
  return coarse && width >= 150;
}
