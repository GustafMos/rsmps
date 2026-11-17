/**
 * The pure maths around the AI depth model, shared by the node (clip-level normalisation, interpolation), the runtime that
 * feeds the model (sizes, resizing, input tensor) and the tests. No GPU, no model, no DOM.
 *
 * Why the normalisation is done per CLIP and not per frame: Depth Anything predicts RELATIVE inverse depth, affine-invariant per
 * picture (the numbers mean "larger = nearer" but their scale and offset float from frame to frame). Stretching every frame to its
 * own min / max would make a video flicker (and smoothing those ranges over time does NOT help: a frame whose numbers were shifted
 * would be mapped with the wrong range). So each frame is fitted onto the previous one by a robust least-squares scale + shift on the
 * pixels that did not change (`alignChain`), which puts the whole clip in one coordinate system; one clip-wide 2% / 98% range then maps
 * it to 0..1. The depth itself can additionally be blended across time (`temporalBlend`).
 */

/** Both sides of the model input are a multiple of this (the export has dynamic height / width axes). */
export const MODEL_MULTIPLE = 14;

/** Model input size for a picture: the long side is about `long`, the aspect ratio is kept, both sides are multiples of `multiple` (at least one). */
export function modelDims(srcWidth: number, srcHeight: number, long: number, multiple = MODEL_MULTIPLE): { width: number; height: number } {
  const w = Math.max(1, srcWidth);
  const h = Math.max(1, srcHeight);
  const k = long / Math.max(w, h);
  const snap = (v: number) => Math.max(multiple, Math.round((v * k) / multiple) * multiple);
  return { width: snap(w), height: snap(h) };
}

/** Image resize helper: where does a destination pixel centre fall in the source (continuous pixel coordinates)? */
export function mapCentre(dstIndex: number, srcSize: number, dstSize: number): number {
  return ((dstIndex + 0.5) * srcSize) / dstSize - 0.5;
}

/** Weights of a triangle (bilinear) filter whose support grows when shrinking, so a big picture is averaged and not point-sampled. */
function axisWeights(srcSize: number, dstSize: number): { start: Int32Array; count: Int32Array; weights: Float32Array[] } {
  const scale = srcSize / dstSize;
  const support = Math.max(1, scale);
  const start = new Int32Array(dstSize);
  const count = new Int32Array(dstSize);
  const weights: Float32Array[] = [];
  for (let i = 0; i < dstSize; i++) {
    const c = mapCentre(i, srcSize, dstSize);
    const lo = Math.max(0, Math.ceil(c - support));
    const hi = Math.min(srcSize - 1, Math.floor(c + support));
    const w: number[] = [];
    let sum = 0;
    for (let s = lo; s <= hi; s++) {
      const v = Math.max(0, 1 - Math.abs(s - c) / support);
      w.push(v);
      sum += v;
    }
    if (sum <= 0) {
      const s = Math.min(srcSize - 1, Math.max(0, Math.round(c)));
      start[i] = s;
      count[i] = 1;
      weights.push(Float32Array.of(1));
    } else {
      start[i] = lo;
      count[i] = w.length;
      weights.push(Float32Array.from(w, (v) => v / sum));
    }
  }
  return { start, count, weights };
}

/** Resize interleaved data with `channels` channels (bilinear when enlarging, area-like when shrinking). Same size returns a copy. */
export function resizeChannels(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number, channels: number): Float32Array {
  if (sw === dw && sh === dh) return Float32Array.from(src as ArrayLike<number>);
  const ax = axisWeights(sw, dw);
  const ay = axisWeights(sh, dh);
  // horizontal pass
  const tmp = new Float32Array(dw * sh * channels);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const s0 = ax.start[x];
      const n = ax.count[x];
      const w = ax.weights[x];
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += src[(y * sw + s0 + k) * channels + c] * w[k];
        tmp[(y * dw + x) * channels + c] = acc;
      }
    }
  }
  const out = new Float32Array(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    const s0 = ay.start[y];
    const n = ay.count[y];
    const w = ay.weights[y];
    for (let x = 0; x < dw; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += tmp[((s0 + k) * dw + x) * channels + c] * w[k];
        out[(y * dw + x) * channels + c] = acc;
      }
    }
  }
  return out;
}

/**
 * The model's input tensor: straight sRGB RGBA bytes of `width x height` resized to `dw x dh`, scaled to 0..1, normalised with the
 * model's mean and std, laid out NCHW (planar R, then G, then B). Alpha is ignored.
 */
export function rgbaToInput(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, dw: number, dh: number, mean: readonly number[], std: readonly number[]): Float32Array {
  const rs = resizeChannels(rgba, width, height, dw, dh, 4);
  const n = dw * dh;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (rs[i * 4 + c] / 255 - mean[c]) / std[c];
  }
  return out;
}

/** Percentile (0..1) of the finite values, from at most `maxSamples` evenly spaced samples (so a big frame is still cheap). */
export function percentile(values: ArrayLike<number>, q: number, maxSamples = 16384): number {
  const n = values.length;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const s: number[] = [];
  for (let i = 0; i < n; i += step) {
    const v = values[i];
    if (Number.isFinite(v)) s.push(v);
  }
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  const pos = Math.min(s.length - 1, Math.max(0, q * (s.length - 1)));
  const a = Math.floor(pos);
  const b = Math.min(s.length - 1, a + 1);
  return s[a] + (s[b] - s[a]) * (pos - a);
}

export interface DepthRange {
  lo: number;
  hi: number;
}

/** Robust range of a raw model output: the 2% and 98% percentiles. A flat picture gets a minimum span so it does not blow up noise. */
export function robustRange(raw: ArrayLike<number>, lowQ = 0.02, highQ = 0.98): DepthRange {
  const lo = percentile(raw, lowQ);
  let hi = percentile(raw, highQ);
  if (!(hi > lo)) hi = lo + 1e-3;
  return { lo, hi };
}

function median(v: number[]): number {
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The affine map that takes a frame into the coordinates of the frame before it: aligned = scale * raw + shift. */
export interface Affine {
  scale: number;
  shift: number;
}

/**
 * Robust fit of `scale * cur + shift ~ ref` over (a sample of) the pixels, by least TRIMMED squares: only the 60% of pixels that fit best count, so
 * up to 40% of the picture may have really changed (a moving object, an uncovered background) without pulling the line. The fit therefore follows
 * the STATIC part of the picture; the model's per-frame scale and offset are what it removes. Several starting lines (quantile matching, plain least
 * squares, identity) are each refined by concentration steps and the best is kept; a last least-squares pass runs on its inliers.
 * Falls back to the identity when the frames cannot be related (a flat picture).
 */
export function alignAffine(ref: ArrayLike<number>, cur: ArrayLike<number>, maxSamples = 8192): Affine {
  const n = Math.min(ref.length, cur.length);
  const step = Math.max(1, Math.floor(n / maxSamples));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i += step) {
    if (Number.isFinite(ref[i]) && Number.isFinite(cur[i])) {
      xs.push(cur[i]);
      ys.push(ref[i]);
    }
  }
  const m = xs.length;
  if (m < 16) return { scale: 1, shift: 0 };
  const fitLs = (idx: ArrayLike<number>, count: number): Affine | null => {
    let mx = 0;
    let my = 0;
    for (let k = 0; k < count; k++) {
      mx += xs[idx[k]];
      my += ys[idx[k]];
    }
    mx /= count;
    my /= count;
    let sxx = 0;
    let sxy = 0;
    for (let k = 0; k < count; k++) {
      const dx = xs[idx[k]] - mx;
      sxx += dx * dx;
      sxy += dx * (ys[idx[k]] - my);
    }
    if (sxx < 1e-12) return null;
    const scale = Math.max(0.05, sxy / sxx); // a depth map never flips
    return { scale, shift: my - scale * mx };
  };
  const all = new Int32Array(m).map((_, i) => i);
  const h = Math.max(8, Math.floor(m * 0.6));
  const res2 = new Float64Array(m);
  const order = new Int32Array(m);
  /** Trimmed objective of a line, and the indices of its h best pixels (in `order`, best first). */
  const trimmed = (aff: Affine): number => {
    for (let i = 0; i < m; i++) {
      const r = aff.scale * xs[i] + aff.shift - ys[i];
      res2[i] = r * r;
      order[i] = i;
    }
    order.sort((p, q) => res2[p] - res2[q]);
    let obj = 0;
    for (let k = 0; k < h; k++) obj += res2[order[k]];
    return obj;
  };
  const refine = (start: Affine): { aff: Affine; obj: number } => {
    let aff = start;
    let obj = trimmed(aff);
    for (let it = 0; it < 10; it++) {
      const next = fitLs(order, h);
      if (!next) break;
      const o = trimmed(next);
      if (o >= obj - 1e-15) break;
      aff = next;
      obj = o;
    }
    trimmed(aff); // leave `order` for this line
    return { aff, obj };
  };
  const starts: Affine[] = [{ scale: 1, shift: 0 }];
  const ls = fitLs(all, m);
  if (ls) starts.push(ls);
  const sx = [...xs].sort((p, q) => p - q);
  const sy = [...ys].sort((p, q) => p - q);
  const qx: number[] = [];
  const qy: number[] = [];
  for (let k = 1; k <= 9; k++) {
    qx.push(sx[Math.min(m - 1, Math.floor((k / 10) * m))]);
    qy.push(sy[Math.min(m - 1, Math.floor((k / 10) * m))]);
  }
  const qmx = qx.reduce((p, q) => p + q, 0) / 9;
  const qmy = qy.reduce((p, q) => p + q, 0) / 9;
  let qxx = 0;
  let qxy = 0;
  for (let k = 0; k < 9; k++) {
    qxx += (qx[k] - qmx) ** 2;
    qxy += (qx[k] - qmx) * (qy[k] - qmy);
  }
  if (qxx > 1e-12) {
    const sc = Math.max(0.05, qxy / qxx);
    starts.push({ scale: sc, shift: qmy - sc * qmx });
  }
  let best: { aff: Affine; obj: number } | null = null;
  for (const st of starts) {
    const r = refine(st);
    if (!best || r.obj < best.obj) best = r;
  }
  if (!best) return { scale: 1, shift: 0 };
  // flat picture: no slope can be found, only an offset
  const xr = sx[Math.floor(m * 0.98)] - sx[Math.floor(m * 0.02)];
  if (xr < 1e-9) return { scale: 1, shift: qmy - qmx };
  // last pass: least squares on everything within 3 robust sigmas of the best line
  trimmed(best.aff);
  const sigma = Math.max(1e-7, Math.sqrt(best.obj / h));
  let count = 0;
  const inl = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const r = best.aff.scale * xs[i] + best.aff.shift - ys[i];
    if (Math.abs(r) <= 3 * sigma + 1e-7) inl[count++] = i;
  }
  const fin = count >= 8 ? fitLs(inl, count) : null;
  return fin ?? best.aff;
}

/**
 * Puts a clip's raw model outputs in ONE consistent coordinate system. Frame 0 is scaled to its own robust range; every later frame is
 * fitted onto the one before it (`alignAffine`), so the per-frame scale / offset flicker of the model is removed while real changes stay
 * (a slow push-in keeps its change, because neighbouring frames still agree on the static pixels). Returns new arrays.
 */
export function alignChain(frames: readonly Float32Array[]): { frames: Float32Array[]; affines: Affine[] } {
  const out: Float32Array[] = [];
  const affines: Affine[] = [];
  frames.forEach((raw, i) => {
    let aff: Affine;
    if (i === 0) {
      const r = robustRange(raw);
      aff = { scale: 1 / (r.hi - r.lo), shift: -r.lo / (r.hi - r.lo) };
    } else {
      aff = alignAffine(out[i - 1], raw);
    }
    const a = new Float32Array(raw.length);
    for (let p = 0; p < raw.length; p++) a[p] = aff.scale * raw[p] + aff.shift;
    out.push(a);
    affines.push(aff);
  });
  return { frames: out, affines };
}

/** The clip-wide robust range of aligned frames: percentiles over a sample of EVERY frame together, so one range maps the whole clip. */
export function clipRange(frames: readonly Float32Array[], lowQ = 0.02, highQ = 0.98): DepthRange {
  const per = Math.max(512, Math.floor(65536 / Math.max(1, frames.length)));
  const pool: number[] = [];
  for (const f of frames) {
    const step = Math.max(1, Math.floor(f.length / per));
    for (let i = 0; i < f.length; i += step) if (Number.isFinite(f[i])) pool.push(f[i]);
  }
  return robustRange(pool, lowQ, highQ);
}

/** How far past the percentiles the output range reaches (a share of the span), so the extremes keep some detail instead of clipping hard. */
export const RANGE_HEADROOM = 0.06;

/** Raw model values to picture depth: 0..1, 1 = near. */
export function normaliseDepth(raw: ArrayLike<number>, range: DepthRange, out?: Float32Array): Float32Array {
  const res = out ?? new Float32Array(raw.length);
  const span = range.hi - range.lo;
  const lo = range.lo - span * RANGE_HEADROOM;
  const k = 1 / (span * (1 + 2 * RANGE_HEADROOM));
  for (let i = 0; i < raw.length; i++) {
    const v = (raw[i] - lo) * k;
    res[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return res;
}

/**
 * Zero-phase temporal blend of normalised frames (a forward and a backward exponential pass, averaged, so nothing lags behind
 * the picture). `amount` 0..1 (0 = untouched). Where a pixel changes a lot between frames (a moving edge) the blend backs off, so
 * moving objects do not leave trails; there is no motion compensation (the optical-flow code runs inside node renders, not in a
 * process job), so a fast-moving object is simply not smoothed. Works in place on `frames`.
 */
export function temporalBlend(frames: Float32Array[], amount: number, loop = false): void {
  const n = frames.length;
  if (n < 2 || amount <= 0) return;
  const a = Math.min(0.9, amount * 0.8);
  const px = frames[0].length;
  const fwd = frames.map((f) => Float32Array.from(f));
  const bwd = frames.map((f) => Float32Array.from(f));
  const sweep = (seq: Float32Array[], order: number[], seed: Float32Array | null) => {
    let prev = seed ?? seq[order[0]];
    for (const i of order) {
      const cur = seq[i];
      if (prev !== cur) {
        for (let p = 0; p < px; p++) {
          const d = cur[p] - prev[p];
          const w = a * Math.exp(-(d * d) / (2 * 0.1 * 0.1)); // a jump of 0.2 or more is motion, not noise
          cur[p] = prev[p] * w + cur[p] * (1 - w);
        }
      }
      prev = cur;
    }
  };
  const up = Array.from({ length: n }, (_, i) => i);
  const down = [...up].reverse();
  // a loop is warmed up with a pass over the whole clip first, so the seam is smooth too
  if (loop) {
    sweep(fwd, up, null);
    sweep(bwd, down, null);
  }
  sweep(fwd, up, loop ? Float32Array.from(fwd[n - 1]) : null);
  sweep(bwd, down, loop ? Float32Array.from(bwd[0]) : null);
  for (let i = 0; i < n; i++) {
    const out = frames[i];
    for (let p = 0; p < px; p++) out[p] = 0.5 * (fwd[i][p] + bwd[i][p]);
  }
}

/** Float 0..1 to unsigned 16 bit. */
export function toU16(src: Float32Array, out?: Uint16Array): Uint16Array {
  const r = out ?? new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) r[i] = Math.round(Math.min(1, Math.max(0, src[i])) * 65535);
  return r;
}

export function fromU16(src: Uint16Array, offset: number, length: number, out?: Float32Array): Float32Array {
  const r = out ?? new Float32Array(length);
  for (let i = 0; i < length; i++) r[i] = src[offset + i] / 65535;
  return r;
}

/** The project frames that are really processed when only every `every`-th frame is: 0, every, 2*every, ... */
export function processedFrames(total: number, every: number): number[] {
  const e = Math.max(1, Math.round(every));
  const out: number[] = [];
  for (let f = 0; f < total; f += e) out.push(f);
  return out.length ? out : [0];
}

/** Which two stored frames frame `f` is made from, and the weight of the second (0..1). */
export interface InterpPlan {
  a: number;
  b: number;
  t: number;
}

export function interpPlan(f: number, every: number, stored: number, total: number, loop: boolean): InterpPlan {
  const e = Math.max(1, Math.round(every));
  const frame = loop ? ((f % total) + total) % total : Math.min(total - 1, Math.max(0, f));
  const a = Math.min(stored - 1, Math.floor(frame / e));
  if (e === 1 || stored === 1) return { a, b: a, t: 0 };
  const t0 = (frame - a * e) / e;
  let b = a + 1;
  let t = t0;
  if (b >= stored) {
    if (loop) {
      // the frames after the last processed one fade towards the first (the next loop pass): the real distance is total - a * e frames
      b = 0;
      t = (frame - a * e) / Math.max(1, total - a * e);
    } else {
      b = a;
      t = 0;
    }
  }
  return { a, b, t };
}

/** Blend two depth frames (picture depth, 0..1). */
export function blendFrames(a: Float32Array, b: Float32Array, t: number, out: Float32Array): Float32Array {
  if (t <= 0) {
    out.set(a);
    return out;
  }
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** Half precision (IEEE 754 binary16) to float: some runtimes hand an fp16 output over as raw 16-bit words. */
export function halfToFloat(h: number): number {
  const e = (h >> 10) & 31;
  const m = h & 1023;
  const s = h >> 15 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
