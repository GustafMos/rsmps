/**
 * McLeod Pitch Method (MPM): normalised square-difference function, key-maximum picking and
 * parabolic interpolation. Allocation-free after the caller provides the NSDF buffer.
 */

/** Fill out[0..maxLag] with the NSDF of x[0..w). */
export function nsdf(x: Float32Array, w: number, maxLag: number, out: Float32Array): void {
  let m = 0;
  for (let j = 0; j < w; j++) m += 2 * x[j] * x[j];
  for (let tau = 0; tau <= maxLag; tau++) {
    let r = 0;
    const lim = w - tau;
    for (let j = 0; j < lim; j++) r += x[j] * x[j + tau];
    out[tau] = m > 1e-12 ? (2 * r) / m : 0;
    m -= x[tau] * x[tau] + x[w - 1 - tau] * x[w - 1 - tau];
  }
}

export interface PitchResult {
  /** Refined lag in samples, 0 when nothing was found. */
  lag: number;
  /** NSDF value at the chosen peak (0..1): how periodic the signal is. */
  clarity: number;
}

/**
 * Find the period. `minLag` skips peaks above the maximum wanted frequency.
 * `cutoff` (0.8..1) is MPM's k: the first key maximum above cutoff * highest wins (avoids octave-down errors).
 */
export function pickPeriod(n: Float32Array, minLag: number, maxLag: number, cutoff: number, res: PitchResult): PitchResult {
  res.lag = 0;
  res.clarity = 0;
  let pos = 0;
  // skip the initial positive lobe around lag 0
  while (pos < maxLag - 1 && n[pos] > 0) pos++;
  while (pos < maxLag - 1 && n[pos] <= 0) pos++;
  if (pos < 1) pos = 1;
  let curMax = 0;
  let bestVal = 0;
  // Collected key maxima, kept in two small fixed arrays to avoid allocation.
  const keyPos = KEY_POS;
  const keyVal = KEY_VAL;
  let nKeys = 0;
  while (pos < maxLag - 1) {
    if (n[pos] > n[pos - 1] && n[pos] >= n[pos + 1]) {
      if (curMax === 0 || n[pos] > n[curMax]) curMax = pos;
    }
    pos++;
    if (pos < maxLag - 1 && n[pos] <= 0) {
      if (curMax > 0) {
        if (curMax >= MIN_LAG && nKeys < keyPos.length) {
          keyPos[nKeys] = curMax;
          keyVal[nKeys] = n[curMax];
          nKeys++;
          if (n[curMax] > bestVal) bestVal = n[curMax];
        }
        curMax = 0;
      }
      while (pos < maxLag - 1 && n[pos] <= 0) pos++;
    }
  }
  if (curMax > 0 && curMax >= MIN_LAG && nKeys < keyPos.length) {
    keyPos[nKeys] = curMax;
    keyVal[nKeys] = n[curMax];
    nKeys++;
    if (n[curMax] > bestVal) bestVal = n[curMax];
  }
  if (nKeys === 0) return res;
  const thr = cutoff * bestVal;
  let chosen = 0;
  for (let k = 0; k < nKeys; k++) {
    if (keyVal[k] >= thr) {
      chosen = keyPos[k];
      break;
    }
  }
  if (chosen < 1 || chosen < minLag) return res; // too high a pitch: do not fall back to a longer multiple of the period
  const a = n[chosen - 1];
  const b = n[chosen];
  const c = n[chosen + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  res.lag = chosen + Math.max(-1, Math.min(1, shift));
  res.clarity = b - 0.25 * (a - c) * shift;
  return res;
}

/** Peaks at lags this short are meaningless (above Nyquist/2 at the analysis rate). */
const MIN_LAG = 3;
const KEY_POS = new Int32Array(64);
const KEY_VAL = new Float64Array(64);
