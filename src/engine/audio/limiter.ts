/**
 * Look-ahead peak limiter shared by the `limiter` effect and the `audio-out` sink.
 * ~1.5 ms look-ahead, smooth release, and a final clamp so the ceiling is never exceeded.
 */
import { DelayLine, fz } from './dsp';

export interface LimiterState {
  dl: DelayLine;
  dr: DelayLine;
  look: number;
  gain: number;
  atk: number;
}

export function makeLimiter(sampleRate: number): LimiterState {
  const look = Math.max(8, Math.round(sampleRate * 0.0015));
  return { dl: new DelayLine(look + 2), dr: new DelayLine(look + 2), look, gain: 1, atk: 1 - Math.exp(-3 / look) };
}

/** Process `n` samples. `ceil` is linear, `release` in seconds. Input and output may be the same array. */
export function limiterProcess(
  st: LimiterState,
  sampleRate: number,
  inL: Float32Array,
  inR: Float32Array,
  outL: Float32Array,
  outR: Float32Array,
  n: number,
  ceil: number,
  release: number,
): void {
  const rel = 1 - Math.exp(-1 / Math.max(release * sampleRate, 1));
  const atk = Math.min(1, st.atk * 4);
  const bufL = st.dl.buf;
  const bufR = st.dr.buf;
  const mask = st.dl.mask;
  const look = st.look;
  let pos = st.dl.pos;
  let g = st.gain;
  for (let i = 0; i < n; i++) {
    const l = inL[i];
    const r = inR[i];
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    const a = al > ar ? al : ar;
    const need = a > ceil ? ceil / a : 1;
    g += (need - g) * (need < g ? atk : rel);
    bufL[pos] = l;
    bufR[pos] = r;
    const rp = (pos - look) & mask;
    pos = (pos + 1) & mask;
    let yl = bufL[rp] * g;
    let yr = bufR[rp] * g;
    if (yl > ceil) yl = ceil;
    else if (yl < -ceil) yl = -ceil;
    if (yr > ceil) yr = ceil;
    else if (yr < -ceil) yr = -ceil;
    outL[i] = yl;
    outR[i] = yr;
  }
  st.dl.pos = pos;
  st.dr.pos = pos;
  st.gain = fz(g);
}
