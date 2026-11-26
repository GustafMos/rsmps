/**
 * Finds the square markers of lib/marker-code.ts in a small greyscale picture (pure, no GPU).
 *
 * Steps, each chosen to survive a hand-held phone picture:
 *  1. Local threshold: a pixel is "dark" when it is clearly darker than the average of its surroundings (an integral image makes
 *     that average cheap). A global threshold would fail under a lamp that lights one side of the table.
 *  2. Connected dark areas. The marker's black border and its black cells form one area.
 *  3. The convex outline of each area. The holes inside (white cells) do not matter to a convex outline, which is why this is used
 *     instead of following the contour. Its four extreme points are the first guess of the corners.
 *  4. Each side is then measured again in the grey picture, where the black-to-white step is located to a fraction of a pixel, and
 *     a straight line is fitted to it. The corners are where neighbouring lines cross. This is what makes the 3D pose calm.
 *  5. The 6 x 6 cells are read through the perspective mapping of the four corners. The border must be black, the paper around it
 *     white, and the 16 inner cells must be one of our codes (in any rotation, or mirrored). Anything else is not a marker.
 *
 * Coordinates: pixel (i, j) covers [i, i+1) x [j, j+1); its centre is (i + 0.5, j + 0.5). y points down.
 */
import { MARKER_CELLS, matchCode } from './marker-code';
import { homography, mapPoint, type Pt } from './marker-pose';

export interface MarkerDetection {
  id: number;
  /** Corners of the black square in picture pixels: the marker's own top-left, top-right, bottom-right, bottom-left (as printed). */
  corners: [Pt, Pt, Pt, Pt];
  /** The picture shows the marker as a mirror image (a mirrored front camera). */
  mirrored: boolean;
  /** 0..1: contrast, sharpness of the edges and how cleanly the code was read. Motion blur lowers it. */
  score: number;
  /** Wrongly read cells that were corrected. */
  errors: number;
  /** Brightness difference between paper and ink, 0..255. */
  contrast: number;
}

export interface DetectOptions {
  /** Only this marker (0-based). Undefined or negative = any. */
  id?: number;
  /** Accept mirror images (default true). */
  allowMirror?: boolean;
  /** Smallest brightness difference between paper and ink (0..255, default 24). */
  minContrast?: number;
}

/** Bilinear sample at continuous (x, y), clamped at the border. */
export function sampleGrey(g: Uint8Array, w: number, h: number, x: number, y: number): number {
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0;
  const ay = fy - y0;
  const a = g[y0 * w + x0] * (1 - ax) + g[y0 * w + x1] * ax;
  const b = g[y1 * w + x0] * (1 - ax) + g[y1 * w + x1] * ax;
  return a * (1 - ay) + b * ay;
}

/** 1 where the pixel is darker than the mean of the (2r+1) square around it by more than `c`. */
export function darkMask(g: Uint8Array, w: number, h: number, r: number, c: number, out?: Uint8Array): Uint8Array {
  const W = w + 1;
  // sums stay below 2^32 for any picture this is meant for (a megapixel of white is 2.6e8)
  const integral = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
    }
  }
  const mask = out ?? new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r + 1 > h ? h : y + r + 1;
    const a = y0 * W;
    const b = y1 * W;
    const rows = y1 - y0;
    for (let x = 0; x < w; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r + 1 > w ? w : x + r + 1;
      const sum = integral[b + x1] - integral[a + x1] - integral[b + x0] + integral[a + x0];
      mask[y * w + x] = (g[y * w + x] + c) * ((x1 - x0) * rows) < sum ? 1 : 0;
    }
  }
  return mask;
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (monotone chain) of points already sorted by x then y. */
function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** The four hull points that best describe a four-sided outline: the two furthest apart, then the furthest from that diagonal on each side. */
function quadOfHull(hull: Pt[]): [Pt, Pt, Pt, Pt] | null {
  if (hull.length < 4) return null;
  let cx = 0;
  let cy = 0;
  for (const p of hull) {
    cx += p[0];
    cy += p[1];
  }
  cx /= hull.length;
  cy /= hull.length;
  const far = (from: Pt): Pt => {
    let best = hull[0];
    let bd = -1;
    for (const p of hull) {
      const d = (p[0] - from[0]) ** 2 + (p[1] - from[1]) ** 2;
      if (d > bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  let a = far([cx, cy]);
  let b = far(a);
  a = far(b);
  let c: Pt | null = null;
  let d: Pt | null = null;
  let cm = 0;
  let dm = 0;
  for (const p of hull) {
    const s = cross(a, b, p);
    if (s > cm) {
      cm = s;
      c = p;
    } else if (s < dm) {
      dm = s;
      d = p;
    }
  }
  if (!c || !d) return null;
  // a, c, b, d go round the outline; make the order clockwise on screen (y down: positive shoelace area)
  const q: [Pt, Pt, Pt, Pt] = [a, c, b, d];
  return polygonArea(q) > 0 ? q : [a, d, b, c];
}

/** Total-least-squares line through points: a point on it and its unit direction. */
function fitLine(pts: Pt[]): { p: Pt; d: Pt } {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] };
}

function intersect(a: { p: Pt; d: Pt }, b: { p: Pt; d: Pt }): Pt | null {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t];
}

/**
 * Measure the four sides in the grey picture and return the crossing points of the fitted lines, plus how sharp the edges are
 * (brightness step per pixel, of the softest side: motion blur smears the sides across the movement). Null when a side cannot be measured.
 */
function refineQuad(g: Uint8Array, w: number, h: number, q: [Pt, Pt, Pt, Pt]): { corners: [Pt, Pt, Pt, Pt]; sharp: number } | null {
  let quad = q;
  let sharp = 0;
  // two rounds: the second starts from the already much better corners, so its samples lie along the true sides
  for (let round = 0; round < 3; round++) {
    const lines: { p: Pt; d: Pt }[] = [];
    let softest = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 6) return null;
      const dx = (b[0] - a[0]) / len;
      const dy = (b[1] - a[1]) / len;
      // clockwise on screen, so the outside is to the left of the direction of travel: (dy, -dx)
      const nx = dy;
      const ny = -dx;
      const reach = round === 0 ? Math.max(2.5, Math.min(6, len * 0.12)) : Math.max(2, Math.min(3.5, len * 0.06));
      const count = Math.max(6, Math.min(28, Math.round(len / 1.5)));
      const pts: Pt[] = [];
      let grad = 0;
      for (let k = 0; k < count; k++) {
        // stay away from the corners, where the neighbouring side disturbs the step
        const t = 0.12 + (0.76 * (k + 0.5)) / count;
        const px = a[0] + dx * len * t;
        const py = a[1] + dy * len * t;
        let best = -1;
        let bs = 0;
        const steps = Math.ceil(reach * 2);
        const vals: number[] = [];
        for (let s = -steps; s <= steps + 1; s++) vals.push(sampleGrey(g, w, h, px + nx * (s - 0.5) * 0.5, py + ny * (s - 0.5) * 0.5));
        // vals[j] is the grey at offset (j - steps - 0.5) / 2 px; the step between vals[j] and vals[j+1] sits at offset (j - steps) / 2
        const diffs: number[] = [];
        for (let j = 0; j + 1 < vals.length; j++) diffs.push(vals[j + 1] - vals[j]);
        for (let j = 0; j < diffs.length; j++)
          if (diffs[j] > bs) {
            bs = diffs[j];
            best = j;
          }
        if (best < 0 || bs < 1.5) continue;
        let off = (best - steps) * 0.5;
        if (best > 0 && best < diffs.length - 1) {
          const l = diffs[best - 1];
          const r = diffs[best + 1];
          const den = l - 2 * bs + r;
          if (den < -1e-6) off += (0.5 * (0.5 * (l - r))) / den;
        }
        pts.push([px + nx * off, py + ny * off]);
        grad += bs * 2;
      }
      if (pts.length < Math.max(4, count * 0.6)) return null;
      softest = Math.min(softest, grad / pts.length);
      let line = fitLine(pts);
      // drop the worst quarter (a finger, a fold, a neighbouring dark thing) and fit again
      const dist = pts.map((p) => Math.abs((p[0] - line.p[0]) * line.d[1] - (p[1] - line.p[1]) * line.d[0]));
      const sorted = [...dist].sort((x, y) => x - y);
      const cut = Math.max(0.35, sorted[Math.floor(sorted.length * 0.75)]);
      const kept = pts.filter((_, k) => dist[k] <= cut);
      if (kept.length >= 4) line = fitLine(kept);
      lines.push(line);
    }
    const out: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const c = intersect(lines[(i + 3) % 4], lines[i]);
      if (!c) return null;
      // a refined corner far from the first guess means the lines were fitted to something else
      if (Math.hypot(c[0] - q[i][0], c[1] - q[i][1]) > Math.max(4, 0.25 * Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]))) return null;
      out.push(c);
    }
    // settled already: a third round would only repeat the second
    const moved = Math.max(...out.map((c, i) => Math.hypot(c[0] - quad[i][0], c[1] - quad[i][1])));
    quad = out as [Pt, Pt, Pt, Pt];
    sharp = softest;
    if (round > 0 && moved < 0.05) break;
  }
  return { corners: quad, sharp };
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Brightness of the border cells and of the paper around a candidate square: the cheap test that throws out most dark shapes. */
function readFrame(g: Uint8Array, w: number, h: number, q: [Pt, Pt, Pt, Pt], o: DetectOptions, strict: boolean) {
  const N = MARKER_CELLS;
  const H = homography([[0, 0], [N, 0], [N, N], [0, N]], q);
  if (!H) return null;
  const cell = (cx: number, cy: number): number => {
    if (!strict) {
      const p = mapPoint(H, cx + 0.5, cy + 0.5);
      return sampleGrey(g, w, h, p[0], p[1]);
    }
    let s = 0;
    for (const [ox, oy] of [[0, 0], [-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]]) {
      const p = mapPoint(H, cx + 0.5 + ox, cy + 0.5 + oy);
      s += sampleGrey(g, w, h, p[0], p[1]);
    }
    return s / 5;
  };
  const border: number[] = [];
  const around: number[] = [];
  for (let i = 0; i < N; i++) {
    border.push(cell(i, 0), cell(i, N - 1));
    if (i > 0 && i < N - 1) border.push(cell(0, i), cell(N - 1, i));
    // the white paper half a cell outside each side
    for (const [x, y] of [[i + 0.5, -0.5], [i + 0.5, N + 0.5], [-0.5, i + 0.5], [N + 0.5, i + 0.5]]) {
      const p = mapPoint(H, x, y);
      if (p[0] < 0 || p[1] < 0 || p[0] > w || p[1] > h) continue;
      around.push(sampleGrey(g, w, h, p[0], p[1]));
    }
  }
  if (around.length < 12) return null;
  const black = median(border);
  const white = median(around);
  const contrast = white - black;
  if (contrast < (o.minContrast ?? 24) * (strict ? 1 : 0.7)) return null;
  const thr = (white + black) / 2;
  // the first look uses the rough corners, so it forgives more
  if (border.filter((v) => v > thr).length > (strict ? 2 : 5)) return null;
  if (around.filter((v) => v < thr).length > around.length * (strict ? 0.25 : 0.4)) return null;
  return { cell, contrast, thr };
}

/** Read the cells of a candidate square (corners clockwise on screen). Null when it is not one of our markers. */
function decodeQuad(g: Uint8Array, w: number, h: number, q: [Pt, Pt, Pt, Pt], sharp: number, o: DetectOptions): MarkerDetection | null {
  const N = MARKER_CELLS;
  const frame = readFrame(g, w, h, q, o, true);
  if (!frame) return null;
  const { cell, contrast, thr } = frame;
  // Every side must show its black-to-white step along (nearly) its whole length. A side that is partly covered (a finger, a cable)
  // would still give corners, but extrapolated ones that can be many pixels off: better to say "not found" for that frame.
  const side = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
  const reach = Math.max(1, Math.min(2.5, (side / N) * 0.6));
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = ((b[1] - a[1]) / len) * reach;
    const ny = (-(b[0] - a[0]) / len) * reach;
    let good = 0;
    const count = 16;
    for (let k = 0; k < count; k++) {
      const t = 0.05 + (0.9 * k) / (count - 1);
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      if (sampleGrey(g, w, h, px + nx, py + ny) - sampleGrey(g, w, h, px - nx, py - ny) > contrast * 0.3) good++;
    }
    if (good < count - 2) return null;
  }
  let read = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (cell(x + 1, y + 1) > thr) read |= 1 << (15 - (y * 4 + x));
  const m = matchCode(read, o.allowMirror !== false);
  if (!m) return null;
  if (o.id !== undefined && o.id >= 0 && m.id !== o.id) return null;
  // which of the four picture corners is the marker's own top-left (see marker-code.ts: turned clockwise `turns` times, mirror first)
  const k = m.turns;
  const at = (i: number): Pt => q[(i + 4) % 4];
  const corners: [Pt, Pt, Pt, Pt] = m.mirrored ? [at(1 + k), at(k), at(3 + k), at(2 + k)] : [at(k), at(1 + k), at(2 + k), at(3 + k)];
  // a perfectly sharp edge has the whole step within about one pixel; blur spreads it. Smeared over more than a dozen pixels the
  // corners are guesses several pixels off, and a wrong pose is worse than none: refuse it (the node then holds the last pose).
  if (sharp < contrast * 0.075) return null;
  const sharpness = Math.max(0, Math.min(1, (sharp / Math.max(1, contrast)) * 1.6));
  const score = Math.max(0.05, Math.min(1, Math.min(1, contrast / 90) * (0.35 + 0.65 * sharpness) * (1 - 0.3 * m.errors)));
  return { id: m.id, corners, mirrored: m.mirrored, score, errors: m.errors, contrast };
}

function detectAt(g: Uint8Array, w: number, h: number, radius: number, o: DetectOptions, work: { mask: Uint8Array; queue: Int32Array; rowMin: Int32Array; rowMax: Int32Array }): MarkerDetection[] {
  const mask = darkMask(g, w, h, radius, 10, work.mask);
  const { queue, rowMin, rowMax } = work;
  const found: MarkerDetection[] = [];
  const minSide = 10;
  const near = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  for (let start = 0; start < w * h; start++) {
    if (mask[start] !== 1) continue;
    // flood fill (8 neighbours, so a thin far-away border stays one piece); 2 marks "seen"
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    mask[start] = 2;
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        // the common case, away from the picture's edge: the eight neighbours by plain offsets
        for (let n = 0; n < 8; n++) {
          const j = i + near[n];
          if (mask[j] === 1) {
            mask[j] = 2;
            queue[tail++] = j;
          }
        }
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] === 1) {
            mask[j] = 2;
            queue[tail++] = j;
          }
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw < minSide || bh < minSide) continue;
    // touching the edge of the picture: part of it is out of view, the corners cannot be trusted
    if (x0 <= 0 || y0 <= 0 || x1 >= w - 1 || y1 >= h - 1) continue;
    if (tail < bw * bh * 0.12) continue;
    for (let y = y0; y <= y1; y++) {
      rowMin[y] = w;
      rowMax[y] = -1;
    }
    for (let k = 0; k < tail; k++) {
      const i = queue[k];
      const x = i % w;
      const y = (i - x) / w;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
    }
    const pts: Pt[] = [];
    for (let y = y0; y <= y1; y++) {
      if (rowMax[y] < 0) continue;
      // both ends of the row, as the corners of the pixel squares, so the outline encloses the pixels
      pts.push([rowMin[y], y], [rowMax[y] + 1, y], [rowMin[y], y + 1], [rowMax[y] + 1, y + 1]);
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const hull = convexHull(pts);
    const quad = quadOfHull(hull);
    if (!quad) continue;
    const qa = Math.abs(polygonArea(quad));
    const ha = Math.abs(polygonArea(hull));
    // the outline must really be four-sided, and the dark area must fill a fair part of it (the border alone is over half)
    if (qa < minSide * minSide * 0.8 || qa < ha * 0.82 || tail < qa * 0.3) continue;
    // most dark shapes are thrown out here, before the costly measuring of the sides
    if (!readFrame(g, w, h, quad, o, false)) continue;
    const refined = refineQuad(g, w, h, quad);
    if (!refined) continue;
    const det = decodeQuad(g, w, h, refined.corners, refined.sharp, o);
    if (det) found.push(det);
  }
  return found;
}

/**
 * All markers in a greyscale picture, largest first. Works on any size; 320 to 640 pixels on the long side is the intended range
 * (a marker should be at least about 20 pixels wide there).
 */
export function detectMarkers(g: Uint8Array, w: number, h: number, o: DetectOptions = {}): MarkerDetection[] {
  if (w < 16 || h < 16) return [];
  const short = Math.min(w, h);
  const work = { mask: new Uint8Array(w * h), queue: new Int32Array(w * h), rowMin: new Int32Array(h), rowMax: new Int32Array(h) };
  // The neighbourhood must be wider than two cells of the largest marker (or the middle of its border is not "darker than its
  // surroundings"). That wide window is tried first; a small one follows only when nothing was found, for uneven light.
  let found = detectAt(g, w, h, Math.max(4, Math.round(short / 6)), o, work);
  if (!found.length) found = detectAt(g, w, h, Math.max(3, Math.round(short / 20)), o, work);
  const size = (d: MarkerDetection): number => Math.abs(polygonArea(d.corners));
  return found.sort((a, b) => size(b) - size(a));
}

/** RGBA bytes (as read back from the GPU) to grey, using the red channel of an already grey picture or Rec. 709 luma otherwise. */
export function greyFromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, alreadyGrey = false): Uint8Array {
  const out = new Uint8Array(w * h);
  if (alreadyGrey) for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = rgba[j];
  else for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 54 + rgba[j + 1] * 183 + rgba[j + 2] * 19 + 128) >> 8;
  return out;
}
