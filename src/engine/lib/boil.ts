/** Largest divisor of `total` that is at most `wanted` (at least 1): a boil of that many poses repeats a whole number of times per loop. */
export function wholeCyclePoses(total: number, wanted: number): number {
  const t = Math.max(1, Math.round(total));
  for (let p = Math.max(1, Math.min(t, Math.round(wanted))); p > 1; p--) if (t % p === 0) return p;
  return 1;
}
