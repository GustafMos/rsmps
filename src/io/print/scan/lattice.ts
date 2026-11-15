/**
 * Locating the "+" registration marks on a rectified page without assuming where they are exactly: a matched
 * filter for the cross finds candidate peaks anywhere, a smooth polynomial warp is fitted from the expected
 * lattice to the peaks (so a curled sheet that moves marks by several mm is followed), and, when the data strip
 * is unreadable, the lattice itself (columns, rows, pitch) is inferred from the peaks. Pure.
 */
import { markTemplate, matchTemplate } from './refine';

export interface Peak {
  x: number;
  y: number;
  score: number;
}

/**
 * Candidate "+" centres on a greyscale image (rect px). A cross scores high when both bars are darker than the four
 * quadrants around them; candidates are refined to sub-pixel by correlation with the rendered mark.
 */
export function findPlusPeaks(
  gray: Float32Array,
  w: number,
  h: number,
  ppm: number,
  halfMm: number,
  thickMm: number,
  region?: { x0: number; y0: number; x1: number; y1: number },
): Peak[] {
  const W = w + 1;
  const I = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row;
    }
  }
  const box = (x0: number, y0: number, x1: number, y1: number) => (I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
  const a = Math.max(4, Math.round(halfMm * ppm));
  const bt = Math.max(1, Math.round((thickMm * ppm) / 2));
  const gap = bt + 1;
  const rx0 = Math.max(a + 1, Math.floor(region?.x0 ?? 0));
  const ry0 = Math.max(a + 1, Math.floor(region?.y0 ?? 0));
  const rx1 = Math.min(w - a - 2, Math.ceil(region?.x1 ?? w));
  const ry1 = Math.min(h - a - 2, Math.ceil(region?.y1 ?? h));
  const cands: Peak[] = [];
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const bh = box(x - a, y - bt, x + a, y + bt);
      const bv = box(x - bt, y - a, x + bt, y + a);
      const q =
        (box(x + gap, y + gap, x + a, y + a) + box(x - a, y + gap, x - gap, y + a) + box(x + gap, y - a, x + a, y - gap) + box(x - a, y - a, x - gap, y - gap)) / 4;
      const bar = Math.max(bh, bv);
      if (q < 40) continue;
      const s = (q - bar) / q;
      if (s > 0.12) cands.push({ x: x + 0.5, y: y + 0.5, score: s });
    }
  }
  cands.sort((p, q) => q.score - p.score);
  const kept: Peak[] = [];
  const sup = Math.max(3, 1.2 * ppm);
  for (const c of cands) {
    if (kept.length > 1500) break;
    if (kept.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < sup)) continue;
    kept.push(c);
  }
  const tpl = markTemplate(ppm, halfMm, thickMm);
  const out: Peak[] = [];
  for (const k of kept) {
    const m = matchTemplate(gray, w, h, tpl, k.x, k.y, 3);
    if (m && m.score >= 0.55 && !out.some((o) => Math.hypot(o.x - m.x, o.y - m.y) < sup)) out.push({ x: m.x, y: m.y, score: m.score });
  }
  return out;
}

/** Polynomial displacement model d(x, y) = sum c_k * u^i v^j (i + j <= degree), per component. */
export interface Warp {
  degree: number;
  cx: number;
  cy: number;
  scale: number;
  coefX: number[];
  coefY: number[];
}

function terms(degree: number): [number, number][] {
  const t: [number, number][] = [];
  for (let n = 0; n <= degree; n++) for (let i = 0; i <= n; i++) t.push([i, n - i]);
  return t;
}

export function warpAt(wp: Warp, x: number, y: number): { dx: number; dy: number } {
  const u = (x - wp.cx) / wp.scale;
  const v = (y - wp.cy) / wp.scale;
  let dx = 0;
  let dy = 0;
  terms(wp.degree).forEach(([i, j], k) => {
    const b = u ** i * v ** j;
    dx += wp.coefX[k] * b;
    dy += wp.coefY[k] * b;
  });
  return { dx, dy };
}

function solveLS(rows: number[][], rhs: number[], n: number): number[] | null {
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      b[i] += r[i] * rhs[k];
      for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j];
    }
  });
  for (let i = 0; i < n; i++) A[i][i] += 1e-6;
  // gaussian elimination
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

export function fitWarp(exp: { x: number; y: number }[], got: { x: number; y: number }[], degree: number, cx: number, cy: number, scale: number): Warp | null {
  const t = terms(degree);
  const rows = exp.map((p) => {
    const u = (p.x - cx) / scale;
    const v = (p.y - cy) / scale;
    return t.map(([i, j]) => u ** i * v ** j);
  });
  const cxs = solveLS(rows, got.map((g, k) => g.x - exp[k].x), t.length);
  const cys = solveLS(rows, got.map((g, k) => g.y - exp[k].y), t.length);
  if (!cxs || !cys) return null;
  return { degree, cx, cy, scale, coefX: cxs, coefY: cys };
}

export interface TrackedNode {
  /** Index into the expected list. */
  node: number;
  /** Matched peak (null when the position comes from the warp only). */
  peak: Peak | null;
  /** Final position in rect px. */
  x: number;
  y: number;
}

/**
 * Match expected lattice nodes (rect px) to peaks, refining a polynomial warp with a shrinking search radius.
 * `radiusPx` is the first (generous) radius; `finalPx` the radius within which a peak counts as the mark.
 */
export function trackLattice(expected: { x: number; y: number }[], peaks: Peak[], radiusPx: number, finalPx: number): { nodes: TrackedNode[]; warp: Warp | null; matched: number } {
  let cx = 0;
  let cy = 0;
  for (const e of expected) {
    cx += e.x;
    cy += e.y;
  }
  cx /= expected.length;
  cy /= expected.length;
  let scale = 1;
  for (const e of expected) scale = Math.max(scale, Math.abs(e.x - cx), Math.abs(e.y - cy));
  let warp: Warp | null = null;
  const predict = (e: { x: number; y: number }) => {
    if (!warp) return e;
    const d = warpAt(warp, e.x, e.y);
    return { x: e.x + d.dx, y: e.y + d.dy };
  };
  const assign = (radius: number): { node: number; peak: Peak }[] => {
    const pairs: { n: number; p: number; d: number }[] = [];
    expected.forEach((e, n) => {
      const pr = predict(e);
      peaks.forEach((pk, p) => {
        const d = Math.hypot(pk.x - pr.x, pk.y - pr.y);
        if (d <= radius) pairs.push({ n, p, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedN = new Set<number>();
    const usedP = new Set<number>();
    const out: { node: number; peak: Peak }[] = [];
    for (const pr of pairs) {
      if (usedN.has(pr.n) || usedP.has(pr.p)) continue;
      usedN.add(pr.n);
      usedP.add(pr.p);
      out.push({ node: pr.n, peak: peaks[pr.p] });
    }
    return out;
  };
  const schedule: [number, number][] = [
    [radiusPx, 1],
    [radiusPx * 0.7, 2],
    [radiusPx * 0.5, 3],
    [Math.max(finalPx * 1.6, radiusPx * 0.3), 3],
    [finalPx * 1.2, 3],
  ];
  for (const [radius, degMax] of schedule) {
    const m = assign(radius);
    if (m.length < 3) continue;
    let deg = degMax;
    while (deg > 0 && terms(deg).length * 2 > m.length) deg--;
    const w = fitWarp(
      m.map((a) => expected[a.node]),
      m.map((a) => a.peak),
      deg,
      cx,
      cy,
      scale,
    );
    if (w) warp = w;
  }
  const final = assign(finalPx);
  const byNode = new Map(final.map((f) => [f.node, f.peak]));
  const nodes = expected.map((e, node): TrackedNode => {
    const pk = byNode.get(node) ?? null;
    if (pk) return { node, peak: pk, x: pk.x, y: pk.y };
    const p = predict(e);
    return { node, peak: null, x: p.x, y: p.y };
  });
  return { nodes, warp, matched: final.length };
}

function clusters(values: number[], gap: number): number[] {
  const v = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const x of v) {
    const last = out[out.length - 1];
    if (last && x - last[last.length - 1] <= gap) last.push(x);
    else out.push([x]);
  }
  return out.filter((c) => c.length >= 2).map((c) => c.reduce((s, x) => s + x, 0) / c.length);
}

function lattice1D(values: number[], gap: number): { origin: number; pitch: number; count: number } | null {
  const c = clusters(values, gap);
  if (c.length < 2) return null;
  const diffs: number[] = [];
  for (let i = 1; i < c.length; i++) diffs.push(c[i] - c[i - 1]);
  const sorted = [...diffs].sort((a, b) => a - b);
  const pitch = sorted[Math.floor(sorted.length / 2)];
  if (pitch < 8) return null;
  // Fill missing columns: a gap of ~k * pitch counts k steps.
  let count = 1;
  for (const d of diffs) {
    const steps = Math.round(d / pitch);
    if (steps < 1 || Math.abs(d - steps * pitch) > 0.3 * pitch) return null;
    count += steps;
  }
  // Refit pitch over the whole span.
  const span = c[c.length - 1] - c[0];
  return { origin: c[0], pitch: span / (count - 1), count };
}

/**
 * Infer the mark lattice from peaks (mm coordinates): number of mark columns/rows, pitch and origin. Peaks near
 * the page furniture (finders, strip, caption) must already be excluded by the caller.
 */
export function inferLattice(peaksMm: { x: number; y: number }[], gapMm = 5): { x: { origin: number; pitch: number; count: number }; y: { origin: number; pitch: number; count: number } } | null {
  const x = lattice1D(peaksMm.map((p) => p.x), gapMm);
  const y = lattice1D(peaksMm.map((p) => p.y), gapMm);
  if (!x || !y || x.count < 2 || y.count < 2) return null;
  // Most peaks must sit on the lattice.
  let on = 0;
  for (const p of peaksMm) {
    const ex = Math.abs(((p.x - x.origin) / x.pitch) - Math.round((p.x - x.origin) / x.pitch)) * x.pitch;
    const ey = Math.abs(((p.y - y.origin) / y.pitch) - Math.round((p.y - y.origin) / y.pitch)) * y.pitch;
    if (ex < 4 && ey < 4) on++;
  }
  if (on < 0.6 * x.count * y.count) return null;
  return { x, y };
}
