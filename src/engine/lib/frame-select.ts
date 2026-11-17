/**
 * Choosing frames of a clip for camera solving and splat training (Splat from Video). Pure functions on small luma thumbnails.
 *
 *  - Candidates are evenly spaced moments of the clip (at most a few hundred).
 *  - MOTION between neighbouring candidates = mean absolute luma difference of 48 px wide thumbnails (0..1). The cumulative motion is the
 *    clip's "distance travelled"; picks are spaced EVENLY ALONG IT, so a stretch where the camera stands still gets (almost) no frames and a
 *    fast stretch gets more. Fewer picks than asked when the clip does not move enough (`minMotion` between picks).
 *  - SHARPNESS = variance of the Laplacian of a ~256 px luma picture. In each window between two pick positions the sharpest candidate
 *    wins, which drops motion-blurred frames.
 */

export interface FrameCandidate {
  seconds: number;
  /** Variance of the Laplacian (larger = sharper). */
  sharpness: number;
  /** Small luma thumbnail (0..1), the same size for every candidate. */
  thumb: Float32Array;
}

/** `count` evenly spaced moments in [start, end) on whole frames of `fps`; every frame when there are fewer. */
export function candidateTimes(start: number, end: number, fps: number, count: number): number[] {
  const f0 = Math.max(0, Math.ceil(start * fps - 1e-6));
  const f1 = Math.max(f0 + 1, Math.floor(end * fps + 1e-6));
  const total = f1 - f0;
  const n = Math.max(1, Math.min(total, Math.round(count)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((f0 + Math.floor((i * total) / n)) / fps);
  return out;
}

/** Luma (Rec. 709, 0..1) of straight RGBA, box-filtered down to `tw` x `th`. */
export function lumaThumb(rgba: ArrayLike<number>, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  const cnt = new Float32Array(tw * th);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(tw - 1, Math.floor((x * tw) / w));
      const i = (y * w + x) * 4;
      out[ty * tw + tx] += (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
      cnt[ty * tw + tx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
  return out;
}

/** Variance of the 4-neighbour Laplacian of a luma picture (0..1 values). */
export function sharpnessOf(luma: Float32Array, w: number, h: number): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w] - 4 * luma[i];
      s += l;
      s2 += l * l;
      n++;
    }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/** Mean absolute difference of two thumbnails, each scaled to the same mean brightness first (an exposure change is not motion). */
export function motionBetween(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= a.length;
  if (ma < 1e-6 || mb < 1e-6) return 0;
  const m = (ma + mb) / 2;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs((b[i] / mb - a[i] / ma) * m);
  return d / a.length;
}

export interface Selection {
  /** Indices into the candidates, ascending. */
  picks: number[];
  /** Cumulative motion of the clip (sum over neighbouring candidates). */
  travel: number;
}

/**
 * Pick at most `target` candidates spaced evenly along the cumulative motion, at least `minMotion` apart, the sharpest in each window.
 * Always returns at least one pick when there is a candidate.
 */
export function selectFrames(c: readonly FrameCandidate[], target: number, minMotion: number): Selection {
  const n = c.length;
  if (!n) return { picks: [], travel: 0 };
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + motionBetween(c[i - 1].thumb, c[i].thumb);
  const travel = cum[n - 1];
  const k = Math.max(1, Math.min(n, Math.round(target), minMotion > 0 ? Math.floor(travel / minMotion) + 1 : n));
  const picks: number[] = [];
  for (let b = 0; b < k; b++) {
    const lo = (travel * b) / k;
    const hi = (travel * (b + 1)) / k;
    let best = -1;
    for (let i = 0; i < n; i++) {
      const inBin = b === k - 1 ? cum[i] >= lo - 1e-12 : cum[i] >= lo - 1e-12 && cum[i] < hi;
      if (inBin && (best < 0 || c[i].sharpness > c[best].sharpness)) best = i;
    }
    if (best >= 0 && picks[picks.length - 1] !== best) picks.push(best);
  }
  return { picks, travel };
}
