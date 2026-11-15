/**
 * Corner finder-pattern detection on greyscale photos: adaptive threshold, run-length 1:1:3:1:1 scan lines
 * with vertical/horizontal cross-checks (like QR finders), candidate merging and selection of the four
 * page corners. Pure.
 */
import type { Pt } from '../geometry';

export interface Finder {
  x: number;
  y: number;
  /** Module size in pixels (finder width / 7). */
  module: number;
  hits: number;
}

/** Integer box-average downscale of a greyscale image. */
export function downscaleGray(gray: Uint8Array, w: number, h: number, f: number): { data: Uint8Array; width: number; height: number } {
  if (f <= 1) return { data: gray, width: w, height: h };
  const nw = Math.floor(w / f);
  const nh = Math.floor(h / f);
  const out = new Uint8Array(nw * nh);
  const area = f * f;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) {
        const row = (y * f + j) * w + x * f;
        for (let i = 0; i < f; i++) s += gray[row + i];
      }
      out[y * nw + x] = (s / area + 0.5) | 0;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** Local-mean threshold. Returns 1 for "ink" (darker than ratio * local mean). */
export function adaptiveBinarize(gray: Uint8Array, w: number, h: number, radius: number, ratio = 0.82): Uint8Array {
  const W = w + 1;
  const integral = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      out[y * w + x] = gray[y * w + x] < mean * ratio - 2 ? 1 : 0;
    }
  }
  return out;
}

const TOL = 0.65;

/** Does a 5-run sequence look like 1:1:3:1:1? Returns the module size or 0. */
function ratioUnit(c: number[]): number {
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (total < 7) return 0;
  const u = total / 7;
  for (let i = 0; i < 5; i++) {
    if (c[i] === 0) return 0;
    const want = i === 2 ? 3 * u : u;
    if (Math.abs(c[i] - want) > want * TOL) return 0;
  }
  return u;
}

/**
 * Walk from pixel (x, y) (which must be ink) along (dx, dy) in both directions and read the five runs
 * ink-paper-INK-paper-ink. Returns the centre offset along the axis (continuous) and the total span.
 */
function crossCheck(bin: Uint8Array, w: number, h: number, x: number, y: number, dx: number, dy: number, maxTotal: number): { centre: number; total: number; unit: number } | null {
  if (x < 0 || y < 0 || x >= w || y >= h || !bin[y * w + x]) return null;
  const at = (k: number) => {
    const px = x + dx * k;
    const py = y + dy * k;
    return px < 0 || py < 0 || px >= w || py >= h ? -1 : bin[py * w + px];
  };
  const c = [0, 0, 0, 0, 0];
  let k = 0;
  while (at(k) === 1) {
    c[2]++;
    k--;
  }
  const lo = k + 1; // first ink pixel of the centre run (negative direction)
  while (at(k) === 0) {
    c[1]++;
    k--;
  }
  while (at(k) === 1) {
    c[0]++;
    k--;
  }
  if (c[1] === 0 || c[0] === 0) return null;
  k = 1;
  let hiCount = 0;
  while (at(k) === 1) {
    c[2]++;
    hiCount++;
    k++;
  }
  while (at(k) === 0) {
    c[3]++;
    k++;
  }
  while (at(k) === 1) {
    c[4]++;
    k++;
  }
  if (c[3] === 0 || c[4] === 0) return null;
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (total > maxTotal) return null;
  const unit = ratioUnit(c);
  if (!unit) return null;
  const hi = hiCount; // ink pixels after the start pixel
  const centre = (lo + hi + 1) / 2; // run covers [lo, hi+1) relative to the start pixel
  return { centre, total, unit };
}

export function findFinders(bin: Uint8Array, w: number, h: number): Finder[] {
  const cands: Finder[] = [];
  const maxTotal = Math.max(w, h) / 2;
  const starts: number[] = [];
  const lens: number[] = [];
  const cols: number[] = [];
  for (let y = 0; y < h; y++) {
    starts.length = 0;
    lens.length = 0;
    cols.length = 0;
    let runStart = 0;
    let cur = bin[y * w];
    for (let x = 1; x <= w; x++) {
      const v = x < w ? bin[y * w + x] : -1;
      if (v !== cur) {
        starts.push(runStart);
        lens.push(x - runStart);
        cols.push(cur);
        runStart = x;
        cur = v;
      }
    }
    for (let i = 0; i + 4 < lens.length; i++) {
      if (cols[i] !== 1) continue;
      const c = [lens[i], lens[i + 1], lens[i + 2], lens[i + 3], lens[i + 4]];
      const unit = ratioUnit(c);
      if (!unit) continue;
      const cx = starts[i + 2] + lens[i + 2] / 2;
      const px = Math.min(w - 1, Math.floor(cx));
      const v = crossCheck(bin, w, h, px, y, 0, 1, maxTotal);
      if (!v) continue;
      const cy = y + v.centre;
      const py = Math.min(h - 1, Math.max(0, Math.floor(cy)));
      const hz = crossCheck(bin, w, h, px, py, 1, 0, maxTotal);
      if (!hz) continue;
      const fx = px + hz.centre;
      const module = (hz.total / 7 + v.total / 7) / 2;
      if (Math.abs(hz.total - v.total) > 0.5 * Math.max(hz.total, v.total)) continue;
      // merge
      let merged = false;
      for (const f of cands) {
        if (Math.hypot(f.x - fx, f.y - cy) < Math.max(f.module, module) * 2.5) {
          const n = f.hits;
          f.x = (f.x * n + fx) / (n + 1);
          f.y = (f.y * n + cy) / (n + 1);
          f.module = (f.module * n + module) / (n + 1);
          f.hits = n + 1;
          merged = true;
          break;
        }
      }
      if (!merged) cands.push({ x: fx, y: cy, module, hits: 1 });
    }
  }
  return cands.filter((f) => f.hits >= 2);
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Order four points clockwise (on a y-down screen), starting from the one with the smallest angle. */
export function orderClockwise<T extends Pt>(pts: T[]): T[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

/** Choose the four candidates forming the largest convex quadrilateral with consistent module sizes. */
export function selectQuad(cands: Finder[]): Finder[] | null {
  const list = [...cands].sort((a, b) => b.hits - a.hits).slice(0, 14);
  if (list.length < 4) return null;
  let best: Finder[] | null = null;
  let bestScore = 0;
  for (let a = 0; a < list.length; a++)
    for (let b = a + 1; b < list.length; b++)
      for (let c = b + 1; c < list.length; c++)
        for (let d = c + 1; d < list.length; d++) {
          const q = orderClockwise([list[a], list[b], list[c], list[d]]);
          const mods = q.map((f) => f.module);
          if (Math.max(...mods) / Math.min(...mods) > 2.2) continue;
          let convex = true;
          for (let i = 0; i < 4; i++) if (cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) <= 0) convex = false;
          if (!convex) continue;
          const avg = mods.reduce((s, m) => s + m, 0) / 4;
          let minSide = Infinity;
          for (let i = 0; i < 4; i++) minSide = Math.min(minSide, Math.hypot(q[i].x - q[(i + 1) % 4].x, q[i].y - q[(i + 1) % 4].y));
          if (minSide < avg * 12) continue;
          const score = polygonArea(q);
          if (score > bestScore) {
            bestScore = score;
            best = q;
          }
        }
  return best;
}
