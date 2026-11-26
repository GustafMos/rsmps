/**
 * Stabilize: the maths, pure (no GPU, no DOM). Two halves.
 *
 *  1. ANALYSE: the camera motion between two pictures as a similarity transform (shift, rotation, zoom). The pictures are small grey
 *     images (about 256 px on the long side). Corners are picked on a grid so they are spread out, each is followed into the next
 *     picture by matching a small patch (zero-mean correlation) coarse to fine over an image pyramid, started from a global shift
 *     found on the coarsest level, so the large jumps of a hyperlapse (a quarter of the frame) are still found. A similarity is then
 *     fitted with RANSAC, which throws away moving subjects and wrong matches. The share of matches that agree is the confidence.
 *  2. RENDER: the motions are added up to a camera path, the path is smoothed (or held), and for every frame the picture is moved by
 *     (smoothed path minus real path). Everything is a pure function of the stored track and the settings.
 *
 * Coordinates are "normalised": origin at the picture centre, x right, y down, and 1 = the LONG side of the picture, so one number
 * means the same on every picture size and rotation is not skewed by the aspect ratio.
 * A similarity is z' = exp(ls + i rot) * z + (x + i y) with z = x + i y (complex numbers).
 */

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small grey pictures                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Grey {
  w: number;
  h: number;
  /** Luma 0..255. */
  d: Float32Array;
}

/** Longest side of the pictures the motion is estimated on. */
export const ANALYSIS_SIDE = 256;

/** Straight RGBA8 to grey, shrunk (box average) so the longer side is at most `maxSide`. Never enlarges. */
export function toGrey(rgba: ArrayLike<number>, w: number, h: number, maxSide = ANALYSIS_SIDE): Grey {
  const s = Math.min(1, maxSide / Math.max(w, h, 1));
  const ow = Math.max(1, Math.round(w * s));
  const oh = Math.max(1, Math.round(h * s));
  const d = new Float32Array(ow * oh);
  const sx = w / ow;
  const sy = h / oh;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor(oy * sy);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((oy + 1) * sy)));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor(ox * sx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((ox + 1) * sx)));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      }
      d[oy * ow + ox] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return { w: ow, h: oh, d };
}

/** Half size by averaging 2x2. */
export function down2(g: Grey): Grey {
  const w = Math.max(1, g.w >> 1);
  const h = Math.max(1, g.h >> 1);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(g.h - 1, y * 2);
    const y1 = Math.min(g.h - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(g.w - 1, x * 2);
      const x1 = Math.min(g.w - 1, x * 2 + 1);
      d[y * w + x] = (g.d[y0 * g.w + x0] + g.d[y0 * g.w + x1] + g.d[y1 * g.w + x0] + g.d[y1 * g.w + x1]) * 0.25;
    }
  }
  return { w, h, d };
}

/** Level 0 is the picture, each next level half the size. The count follows the size (4 levels for 256 px). */
export function pyramid(g: Grey): Grey[] {
  const long = Math.max(g.w, g.h);
  const levels = Math.max(1, Math.min(4, Math.floor(Math.log2(Math.max(1, long) / 24)) + 1));
  const out = [g];
  for (let i = 1; i < levels; i++) out.push(down2(out[i - 1]));
  return out;
}

/** A cheap fingerprint of a grey picture: identical pictures (a held still of a stop motion) give the same number. */
export function hashGrey(g: Grey): number {
  let h = 2166136261 >>> 0;
  const d = g.d;
  for (let i = 0; i < d.length; i++) {
    h ^= Math.round(d[i]) & 255;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h ^ (g.w * 31 + g.h)) >>> 0;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Corners                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Corner {
  x: number;
  y: number;
  score: number;
}

/**
 * Shi-Tomasi corners (smaller eigenvalue of the gradient structure over a 5x5 window), the best one in each grid cell so they are
 * spread over the whole picture. `border` keeps them clear of the edge so a patch fits around them.
 */
export function findCorners(g: Grey, opts: { cell?: number; border?: number; min?: number } = {}): Corner[] {
  const { w, h, d } = g;
  const long = Math.max(w, h);
  const cell = opts.cell ?? Math.max(10, Math.round(long / 14));
  const border = opts.border ?? Math.max(8, Math.round(long / 28));
  const min = opts.min ?? 20;
  if (w < 2 * border + 6 || h < 2 * border + 6) return [];
  const ixx = new Float32Array(w * h);
  const iyy = new Float32Array(w * h);
  const ixy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (d[y * w + x + 1] - d[y * w + x - 1]) * 0.5;
      const gy = (d[(y + 1) * w + x] - d[(y - 1) * w + x]) * 0.5;
      const i = y * w + x;
      ixx[i] = gx * gx;
      iyy[i] = gy * gy;
      ixy[i] = gx * gy;
    }
  }
  const r = 2;
  const area = (2 * r + 1) * (2 * r + 1);
  const best = new Map<number, Corner>();
  const cw = Math.ceil(w / cell);
  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let yy = y - r; yy <= y + r; yy++) {
        const row = yy * w;
        for (let xx = x - r; xx <= x + r; xx++) {
          a += ixx[row + xx];
          c += iyy[row + xx];
          b += ixy[row + xx];
        }
      }
      a /= area;
      b /= area;
      c /= area;
      const score = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) * 0.5;
      if (score < min) continue;
      const key = Math.floor(y / cell) * cw + Math.floor(x / cell);
      const cur = best.get(key);
      if (!cur || score > cur.score) best.set(key, { x, y, score });
    }
  }
  return [...best.values()].sort((p, q) => p.y * w + p.x - (q.y * w + q.x));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Matching                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

interface Template {
  v: Float32Array;
  norm: number;
  hs: number;
}

function makeTemplate(g: Grey, cx: number, cy: number, hs: number): Template | null {
  if (cx - hs < 0 || cy - hs < 0 || cx + hs >= g.w || cy + hs >= g.h) return null;
  const n = (2 * hs + 1) * (2 * hs + 1);
  const v = new Float32Array(n);
  let sum = 0;
  let k = 0;
  for (let y = cy - hs; y <= cy + hs; y++) for (let x = cx - hs; x <= cx + hs; x++) sum += v[k++] = g.d[y * g.w + x];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    v[i] -= mean;
    sq += v[i] * v[i];
  }
  const norm = Math.sqrt(sq);
  return norm < 1e-3 * n ? null : { v, norm, hs };
}

/** Zero-mean normalised correlation of the template with the patch of `g` centred at (cx, cy); -1 when the patch leaves the picture or is flat. */
function zncc(t: Template, g: Grey, cx: number, cy: number): number {
  const hs = t.hs;
  if (cx - hs < 0 || cy - hs < 0 || cx + hs >= g.w || cy + hs >= g.h) return -1;
  const n = (2 * hs + 1) * (2 * hs + 1);
  let sum = 0;
  let sq = 0;
  let dot = 0;
  let k = 0;
  for (let y = cy - hs; y <= cy + hs; y++) {
    let i = y * g.w + cx - hs;
    for (let x = cx - hs; x <= cx + hs; x++, i++) {
      const v = g.d[i];
      sum += v;
      sq += v * v;
      dot += v * t.v[k++];
    }
  }
  const varc = sq - (sum * sum) / n;
  if (varc < 1e-3 * n) return -1;
  return dot / (t.norm * Math.sqrt(varc));
}

/** The best integer position within `r` of (gx, gy), and its score. */
function searchBest(t: Template, g: Grey, gx: number, gy: number, r: number): { x: number; y: number; s: number } {
  let bx = gx;
  let by = gy;
  let bs = -2;
  for (let y = gy - r; y <= gy + r; y++) {
    for (let x = gx - r; x <= gx + r; x++) {
      const s = zncc(t, g, x, y);
      if (s > bs) {
        bs = s;
        bx = x;
        by = y;
      }
    }
  }
  return { x: bx, y: by, s: bs };
}

/** Parabola through three scores: where the peak really is, in -0.5..0.5. */
function peak(m: number, c: number, p: number): number {
  const den = m - 2 * c + p;
  if (den >= -1e-9) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / den));
}

/**
 * The shift of the whole picture from `a` to `b` on the coarsest level, by trying every shift up to `range` (share of the picture)
 * and keeping the best correlation of the overlap. A small pull toward no shift settles ties on repeating textures.
 */
export function globalShift(a: Grey, b: Grey, range = 0.3): { sx: number; sy: number; score: number } {
  const rx = Math.max(2, Math.round(a.w * range));
  const ry = Math.max(2, Math.round(a.h * range));
  let best = { sx: 0, sy: 0, score: -2 };
  let bestAdj = -9;
  for (let sy = -ry; sy <= ry; sy++) {
    for (let sx = -rx; sx <= rx; sx++) {
      const x0 = Math.max(0, -sx);
      const x1 = Math.min(a.w, b.w - sx);
      const y0 = Math.max(0, -sy);
      const y1 = Math.min(a.h, b.h - sy);
      const n = (x1 - x0) * (y1 - y0);
      if (n < a.w * a.h * 0.3) continue;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = y0; y < y1; y++) {
        let ia = y * a.w + x0;
        let ib = (y + sy) * b.w + x0 + sx;
        for (let x = x0; x < x1; x++, ia++, ib++) {
          const u = a.d[ia];
          const v = b.d[ib];
          sa += u;
          sb += v;
          saa += u * u;
          sbb += v * v;
          sab += u * v;
        }
      }
      const va = saa - (sa * sa) / n;
      const vb = sbb - (sb * sb) / n;
      if (va < 1e-3 * n || vb < 1e-3 * n) continue;
      const score = (sab - (sa * sb) / n) / Math.sqrt(va * vb);
      const adj = score - 0.04 * ((sx / rx) * (sx / rx) + (sy / ry) * (sy / ry));
      if (adj > bestAdj) {
        bestAdj = adj;
        best = { sx, sy, score };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Similarity transforms                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** z' = exp(ls + i rot) z + (x + i y). */
export interface Sim {
  ls: number;
  rot: number;
  x: number;
  y: number;
}

export const IDENTITY: Sim = { ls: 0, rot: 0, x: 0, y: 0 };

/** `outer` after `inner`: outer(inner(z)). */
export function compose(outer: Sim, inner: Sim): Sim {
  const s = Math.exp(outer.ls);
  const c = Math.cos(outer.rot) * s;
  const n = Math.sin(outer.rot) * s;
  return { ls: outer.ls + inner.ls, rot: outer.rot + inner.rot, x: c * inner.x - n * inner.y + outer.x, y: n * inner.x + c * inner.y + outer.y };
}

export function invert(t: Sim): Sim {
  const s = Math.exp(-t.ls);
  const c = Math.cos(-t.rot) * s;
  const n = Math.sin(-t.rot) * s;
  return { ls: -t.ls, rot: -t.rot, x: -(c * t.x - n * t.y), y: -(n * t.x + c * t.y) };
}

export function applySim(t: Sim, x: number, y: number): [number, number] {
  const s = Math.exp(t.ls);
  const c = Math.cos(t.rot) * s;
  const n = Math.sin(t.rot) * s;
  return [c * x - n * y + t.x, n * x + c * y + t.y];
}

/** Similarity through two point pairs. */
function fit2(p0x: number, p0y: number, p1x: number, p1y: number, q0x: number, q0y: number, q1x: number, q1y: number): Sim | null {
  const dpx = p1x - p0x;
  const dpy = p1y - p0y;
  const dqx = q1x - q0x;
  const dqy = q1y - q0y;
  const den = dpx * dpx + dpy * dpy;
  if (den < 1e-12) return null;
  const re = (dqx * dpx + dqy * dpy) / den;
  const im = (dqy * dpx - dqx * dpy) / den;
  const mag = Math.hypot(re, im);
  if (mag < 1e-6) return null;
  const rot = Math.atan2(im, re);
  const ls = Math.log(mag);
  return { ls, rot, x: q0x - (re * p0x - im * p0y), y: q0y - (im * p0x + re * p0y) };
}

/** Least squares similarity over the pairs `idx` (closed form on complex numbers). */
function fitAll(px: Float64Array, py: Float64Array, qx: Float64Array, qy: Float64Array, idx: number[]): Sim | null {
  const n = idx.length;
  if (n < 2) return null;
  let pcx = 0;
  let pcy = 0;
  let qcx = 0;
  let qcy = 0;
  for (const i of idx) {
    pcx += px[i];
    pcy += py[i];
    qcx += qx[i];
    qcy += qy[i];
  }
  pcx /= n;
  pcy /= n;
  qcx /= n;
  qcy /= n;
  let num_re = 0;
  let num_im = 0;
  let den = 0;
  for (const i of idx) {
    const ax = px[i] - pcx;
    const ay = py[i] - pcy;
    const bx = qx[i] - qcx;
    const by = qy[i] - qcy;
    num_re += ax * bx + ay * by;
    num_im += ax * by - ay * bx;
    den += ax * ax + ay * ay;
  }
  if (den < 1e-12) return null;
  const re = num_re / den;
  const im = num_im / den;
  const mag = Math.hypot(re, im);
  if (mag < 1e-6) return null;
  return { ls: Math.log(mag), rot: Math.atan2(im, re), x: qcx - (re * pcx - im * pcy), y: qcy - (im * pcx + re * pcy) };
}

export interface Fit {
  sim: Sim;
  inliers: number;
  /** One flag per input pair. */
  mask: Uint8Array;
}

/**
 * RANSAC: a similarity from two pairs at a time (a fixed pseudo-random sequence, so the same input gives the same answer), keep the
 * one most pairs agree with (within `tol`), refit on those, repeat once. Pairs of moving subjects or wrong matches stay outside.
 */
export function ransacSimilarity(px: Float64Array, py: Float64Array, qx: Float64Array, qy: Float64Array, tol: number, iterations = 160): Fit | null {
  const n = px.length;
  if (n < 3) return null;
  let seed = 0x9e3779b9;
  const rnd = (m: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % m;
  };
  const score = (t: Sim): [number, number] => {
    let cnt = 0;
    let err = 0;
    const s = Math.exp(t.ls);
    const c = Math.cos(t.rot) * s;
    const m = Math.sin(t.rot) * s;
    for (let i = 0; i < n; i++) {
      const ex = c * px[i] - m * py[i] + t.x - qx[i];
      const ey = m * px[i] + c * py[i] + t.y - qy[i];
      const e = Math.hypot(ex, ey);
      if (e < tol) {
        cnt++;
        err += e;
      }
    }
    return [cnt, err];
  };
  let best: Sim | null = null;
  let bestCnt = 0;
  let bestErr = Infinity;
  for (let it = 0; it < iterations; it++) {
    const i = rnd(n);
    let j = rnd(n);
    if (j === i) j = (j + 1) % n;
    if (Math.hypot(px[i] - px[j], py[i] - py[j]) < 0.08) continue;
    const t = fit2(px[i], py[i], px[j], py[j], qx[i], qy[i], qx[j], qy[j]);
    if (!t || Math.abs(t.ls) > 0.5) continue;
    const [cnt, err] = score(t);
    if (cnt > bestCnt || (cnt === bestCnt && err < bestErr)) {
      best = t;
      bestCnt = cnt;
      bestErr = err;
    }
  }
  if (!best) return null;
  for (let round = 0; round < 3; round++) {
    const idx: number[] = [];
    const s = Math.exp(best.ls);
    const c = Math.cos(best.rot) * s;
    const m = Math.sin(best.rot) * s;
    for (let i = 0; i < n; i++) {
      const ex = c * px[i] - m * py[i] + best.x - qx[i];
      const ey = m * px[i] + c * py[i] + best.y - qy[i];
      if (Math.hypot(ex, ey) < tol) idx.push(i);
    }
    const t = fitAll(px, py, qx, qy, idx);
    if (!t) break;
    best = t;
  }
  const mask = new Uint8Array(n);
  const s = Math.exp(best.ls);
  const c = Math.cos(best.rot) * s;
  const m = Math.sin(best.rot) * s;
  let inliers = 0;
  for (let i = 0; i < n; i++) {
    const ex = c * px[i] - m * py[i] + best.x - qx[i];
    const ey = m * px[i] + c * py[i] + best.y - qy[i];
    if (Math.hypot(ex, ey) < tol) {
      mask[i] = 1;
      inliers++;
    }
  }
  return { sim: best, inliers, mask };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Motion between two pictures                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface MotionEstimate {
  /** Where things of the first picture are in the second (normalised coordinates, see the top of the file). */
  sim: Sim;
  /** 0..1: how much of the evidence agrees. Below `UNCERTAIN` the motion should not be trusted. */
  confidence: number;
  inliers: number;
  matches: number;
  corners: number;
}

/** A frame whose confidence is below this counts as uncertain. */
export const UNCERTAIN = 0.4;

const NONE: MotionEstimate = { sim: IDENTITY, confidence: 0, inliers: 0, matches: 0, corners: 0 };

/** The motion from picture `a` to picture `b` (pyramids from `pyramid()`). */
export function estimateMotion(pa: Grey[], pb: Grey[]): MotionEstimate {
  const K = Math.min(pa.length, pb.length);
  const g0 = pa[0];
  const b0 = pb[0];
  if (g0.w !== b0.w || g0.h !== b0.h) return NONE;
  // shift of the whole picture on the coarsest level, as the starting guess for every corner
  let gx = 0;
  let gy = 0;
  if (K >= 2) {
    const gs = globalShift(pa[K - 1], pb[K - 1]);
    if (gs.score > 0.25) {
      gx = gs.sx;
      gy = gs.sy;
    }
  }
  const corners = findCorners(g0);
  const startLevel = Math.max(0, K - 2);
  // the guess of level K-1 in the pixels of the start level
  const scaleUp = 2 ** (K - 1 - startLevel);
  const L = Math.max(g0.w, g0.h);
  const px: number[] = [];
  const py: number[] = [];
  const qx: number[] = [];
  const qy: number[] = [];
  for (const c of corners) {
    let dx = gx * scaleUp;
    let dy = gy * scaleUp;
    let ok = true;
    for (let lv = startLevel; lv >= 0; lv--) {
      const f = 2 ** lv;
      const ga = pa[lv];
      const gb = pb[lv];
      const hs = lv === 0 ? 5 : lv === 1 ? 4 : 3;
      const tx = Math.round(c.x / f);
      const ty = Math.round(c.y / f);
      const t = makeTemplate(ga, tx, ty, hs);
      if (!t) {
        ok = false;
        break;
      }
      const r = lv === startLevel ? 4 : 2;
      const m = searchBest(t, gb, Math.round(tx + dx), Math.round(ty + dy), r);
      if (m.s < (lv === 0 ? 0.75 : 0.35)) {
        ok = false;
        break;
      }
      dx = m.x - tx;
      dy = m.y - ty;
      if (lv === 0) {
        // sub-pixel by a parabola through the neighbouring scores
        const sx = peak(zncc(t, gb, m.x - 1, m.y), m.s, zncc(t, gb, m.x + 1, m.y));
        const sy = peak(zncc(t, gb, m.x, m.y - 1), m.s, zncc(t, gb, m.x, m.y + 1));
        dx += sx;
        dy += sy;
      } else {
        dx *= 2;
        dy *= 2;
      }
    }
    if (!ok) continue;
    px.push((c.x + 0.5 - g0.w / 2) / L);
    py.push((c.y + 0.5 - g0.h / 2) / L);
    qx.push((c.x + dx + 0.5 - g0.w / 2) / L);
    qy.push((c.y + dy + 0.5 - g0.h / 2) / L);
  }
  const matches = px.length;
  if (matches < 4) return { ...NONE, matches, corners: corners.length };
  const fit = ransacSimilarity(Float64Array.from(px), Float64Array.from(py), Float64Array.from(qx), Float64Array.from(qy), 2.0 / L);
  if (!fit) return { ...NONE, matches, corners: corners.length };
  const ratio = fit.inliers / matches;
  // few agreeing points is weak evidence even if they are all the matches there are
  const amount = Math.min(1, fit.inliers / 10);
  let confidence = ratio * amount;
  if (fit.inliers < 6) confidence = Math.min(confidence, 0.2);
  return { sim: fit.sim, confidence, inliers: fit.inliers, matches, corners: corners.length };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The tracker the analysis job runs over the clip                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Floats per frame in the stored track: x, y, rotation, log scale, confidence. */
export const TRACK_STRIDE = 5;

export interface TrackStats {
  frames: number;
  uncertain: number;
  /** Frames identical to the one before (a stop motion shot held for several frames): not analysed again. */
  repeated: number;
  /** CPU milliseconds spent estimating, in total. */
  cpuMs: number;
}

/**
 * Feed it the grey pictures of the clip in order. A picture identical to the one before costs nothing and means no motion. A frame
 * that cannot be trusted (low confidence) is stored as "no motion" with its low confidence, and counted.
 */
export class MotionTracker {
  readonly track: number[] = [];
  readonly stats: TrackStats = { frames: 0, uncertain: 0, repeated: 0, cpuMs: 0 };
  private prev: Grey[] | null = null;
  private prevHash = 0;

  push(g: Grey, now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())): MotionEstimate {
    const t0 = now();
    this.stats.frames++;
    const h = hashGrey(g);
    let est: MotionEstimate;
    if (!this.prev) {
      est = { sim: IDENTITY, confidence: 1, inliers: 0, matches: 0, corners: 0 };
      this.prev = pyramid(g);
    } else if (h === this.prevHash) {
      this.stats.repeated++;
      est = { sim: IDENTITY, confidence: 1, inliers: 0, matches: 0, corners: 0 };
    } else {
      const next = pyramid(g);
      est = estimateMotion(this.prev, next);
      this.prev = next;
    }
    this.prevHash = h;
    const trusted = est.confidence >= UNCERTAIN;
    if (!trusted) this.stats.uncertain++;
    const s = trusted ? est.sim : IDENTITY;
    this.track.push(s.x, s.y, s.rot, s.ls, est.confidence);
    this.stats.cpuMs += now() - t0;
    return est;
  }

  result(): Float32Array {
    return Float32Array.from(this.track);
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Camera path                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The camera POSE of every frame in the coordinates of frame 0: where its centre is (x, y), how far it is turned (rot) and zoomed
 * (ls, log scale). It is the inverse of "where the scene of frame 0 is in frame i", which is what the motions add up to. Smoothing
 * the pose (not the other direction) is what makes a turning camera smooth as a camera.
 */
export interface CameraPath {
  n: number;
  x: Float64Array;
  y: Float64Array;
  rot: Float64Array;
  ls: Float64Array;
}

export function trackFrames(track: ArrayLike<number>): number {
  return Math.floor(track.length / TRACK_STRIDE);
}

export function cameraPath(track: ArrayLike<number>): CameraPath {
  const n = trackFrames(track);
  const path: CameraPath = { n, x: new Float64Array(n), y: new Float64Array(n), rot: new Float64Array(n), ls: new Float64Array(n) };
  let c: Sim = IDENTITY; // where the scene of frame 0 is in frame i
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const o = i * TRACK_STRIDE;
      c = compose({ x: track[o], y: track[o + 1], rot: track[o + 2], ls: track[o + 3] }, c);
    }
    const p = invert(c);
    path.x[i] = p.x;
    path.y[i] = p.y;
    path.rot[i] = p.rot;
    path.ls[i] = p.ls;
  }
  return path;
}

export const poseOf = (p: CameraPath, i: number): Sim => ({ ls: p.ls[i], rot: p.rot[i], x: p.x[i], y: p.y[i] });

/** Gaussian smoothing of one channel. Linear: the window shrinks at the ends (weights renormalised). Circular: it wraps. */
export function gaussian(v: Float64Array, sigma: number, circular: boolean): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  if (sigma < 1e-3 || n < 2) {
    out.set(v);
    return out;
  }
  const rad = Math.min(Math.ceil(sigma * 3), circular ? Math.floor((n - 1) / 2) : n - 1);
  const w = new Float64Array(rad + 1);
  for (let k = 0; k <= rad; k++) w[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    if (circular) {
      let sum = v[i];
      let wsum = 1;
      for (let k = 1; k <= rad; k++) {
        const a = (((i - k) % n) + n) % n;
        const b = (i + k) % n;
        sum += w[k] * (v[a] + v[b]);
        wsum += 2 * w[k];
      }
      out[i] = sum / wsum;
      continue;
    }
    // Weighted LINE fit over the window (not a weighted mean): next to the ends the window is lopsided, and a mean would pull the
    // value toward the middle of the clip, so a steady pan would bend at both ends. A line fit keeps a straight pan straight.
    let sw = 1;
    let sk = 0;
    let skk = 0;
    let sv = v[i];
    let skv = 0;
    for (let k = 1; k <= rad; k++) {
      const a = i - k;
      const b = i + k;
      if (a >= 0) {
        sw += w[k];
        sk -= w[k] * k;
        skk += w[k] * k * k;
        sv += w[k] * v[a];
        skv -= w[k] * k * v[a];
      }
      if (b < n) {
        sw += w[k];
        sk += w[k] * k;
        skk += w[k] * k * k;
        sv += w[k] * v[b];
        skv += w[k] * k * v[b];
      }
    }
    const det = sw * skk - sk * sk;
    out[i] = det > 1e-9 * sw * sw ? (skk * sv - sk * skv) / det : sv / sw;
  }
  return out;
}

export interface SmoothOptions {
  mode: 'smooth' | 'locked';
  /** Width of the smoothing in frames (the standard deviation of the Gaussian). */
  sigma: number;
  /** Smooth round the loop: the correction at the last frame continues into the first. */
  loop: boolean;
  fixRotation: boolean;
  fixZoom: boolean;
  /** 0 = the picture as shot, 1 = fully stabilised. */
  strength: number;
}

/**
 * The pose the camera SHOULD have had. Smooth camera: the real path with its quick movement taken out. Locked off: the first
 * framing for ever. A channel that is not fixed keeps the real pose, so nothing corrects it. With a loop the straight-line drift from
 * the first frame to the last is taken out before smoothing and put back after, so the correction (smoothed minus real) is periodic
 * and does not jump where the loop starts again.
 */
export function smoothPath(real: CameraPath, o: SmoothOptions): CameraPath {
  const n = real.n;
  const out: CameraPath = { n, x: new Float64Array(n), y: new Float64Array(n), rot: new Float64Array(n), ls: new Float64Array(n) };
  const ch = ['x', 'y', 'rot', 'ls'] as const;
  for (const c of ch) {
    const v = real[c];
    let target: Float64Array;
    if (o.mode === 'locked') {
      target = new Float64Array(n).fill(v[0]);
    } else if (o.loop && n > 2) {
      const slope = (v[n - 1] - v[0]) / (n - 1);
      const flat = new Float64Array(n);
      for (let i = 0; i < n; i++) flat[i] = v[i] - slope * i;
      const sm = gaussian(flat, o.sigma, true);
      target = new Float64Array(n);
      for (let i = 0; i < n; i++) target[i] = sm[i] + slope * i;
    } else {
      target = gaussian(v, o.sigma, false);
    }
    const keep = (c === 'rot' && !o.fixRotation) || (c === 'ls' && !o.fixZoom);
    const k = keep ? 0 : Math.min(1, Math.max(0, o.strength));
    for (let i = 0; i < n; i++) out[c][i] = v[i] + k * (target[i] - v[i]);
  }
  return out;
}

/**
 * Per frame, where to READ the original for an output position: source = A * q + b with A = (re, -im; im, re), in normalised
 * coordinates. Four numbers per frame: re, im, bx, by. It is "real path after smoothed pose inverted", identity when they agree.
 */
export function correctionMaps(real: CameraPath, smooth: CameraPath): Float64Array {
  const out = new Float64Array(real.n * 4);
  for (let i = 0; i < real.n; i++) {
    const m = correctionAt(real, smooth, i);
    const s = Math.exp(m.ls);
    out[i * 4] = Math.cos(m.rot) * s;
    out[i * 4 + 1] = Math.sin(m.rot) * s;
    out[i * 4 + 2] = m.x;
    out[i * 4 + 3] = m.y;
  }
  return out;
}

export function correctionAt(real: CameraPath, smooth: CameraPath, i: number): Sim {
  // read position = (scene of frame 0 in frame i) after (smoothed pose): the smoothed pose is where the output wants the camera
  return compose(invert(poseOf(real, i)), poseOf(smooth, i));
}

/**
 * The smallest zoom (>= 1) at which the corrected picture never shows beyond the edge of the original, in any frame. `aspect` is
 * width / height. The corrected picture reads source = A * (q / zoom) + b for output corners q.
 */
export function neededZoom(maps: Float64Array, aspect: number): number {
  const n = maps.length / 4;
  const hx = aspect >= 1 ? 0.5 : 0.5 * aspect;
  const hy = aspect >= 1 ? 0.5 / aspect : 0.5;
  let tmin = 1;
  for (let i = 0; i < n; i++) {
    const re = maps[i * 4];
    const im = maps[i * 4 + 1];
    const bx = maps[i * 4 + 2];
    const by = maps[i * 4 + 3];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const qx = sx * hx;
        const qy = sy * hy;
        const ux = re * qx - im * qy;
        const uy = im * qx + re * qy;
        for (const [u, b, h] of [
          [ux, bx, hx],
          [uy, by, hy],
        ] as const) {
          if (Math.abs(u) < 1e-9) continue;
          const room = h - Math.sign(u) * b;
          tmin = Math.min(tmin, Math.max(0, room / Math.abs(u)));
        }
      }
    }
  }
  return tmin <= 1e-3 ? 1000 : 1 / tmin;
}

/** The look of the stabilised clip for a track and settings: the per-frame maps and the zoom needed to hide the borders. */
export interface StabilizePlan {
  maps: Float64Array;
  zoom: number;
  frames: number;
  /** The real and the smoothed camera pose (for drawing the track). */
  real: CameraPath;
  smooth: CameraPath;
}

export function planStabilize(track: ArrayLike<number>, o: SmoothOptions, aspect: number): StabilizePlan {
  const real = cameraPath(track);
  const smooth = smoothPath(real, o);
  const maps = correctionMaps(real, smooth);
  return { maps, zoom: neededZoom(maps, aspect), frames: real.n, real, smooth };
}

/** Smoothing width in frames from the "Smoothness" setting in seconds (the window is about two standard deviations each side). */
export const sigmaFrames = (seconds: number, fps: number): number => Math.max(0, (seconds * fps) / 2);
