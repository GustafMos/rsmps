/** Homographies and small linear-algebra helpers. Pure. */

export interface Pt {
  x: number;
  y: number;
}

/** 3x3 row-major matrix. */
export type Mat3 = number[];

/** Solve A x = b by Gaussian elimination with partial pivoting. Returns null when singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
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

export function mul3(A: Mat3, B: Mat3): Mat3 {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return o;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) return null;
  const r = 1 / det;
  return [A * r, -(b * i - c * h) * r, (b * f - c * e) * r, B * r, (a * i - c * g) * r, -(a * f - c * d) * r, C * r, -(a * h - b * g) * r, (a * e - b * d) * r];
}

export function applyH(H: Mat3, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

function normalisation(pts: Pt[]): Mat3 {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/**
 * Homography mapping `src[i]` to `dst[i]` (8 DOF, h33 = 1). Four points give the exact solution,
 * more points the least-squares (normalised DLT) solution. Returns null for degenerate input.
 */
export function fitHomography(src: Pt[], dst: Pt[]): Mat3 | null {
  const n = Math.min(src.length, dst.length);
  if (n < 4) return null;
  const Ts = normalisation(src);
  const Td = normalisation(dst);
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const acc = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < n; k++) {
    const s = applyH(Ts, src[k].x, src[k].y);
    const d = applyH(Td, dst[k].x, dst[k].y);
    acc([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x], d.x);
    acc([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y], d.y);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const TdInv = invert3(Td);
  if (!TdInv) return null;
  const H = mul3(mul3(TdInv, Hn), Ts);
  const k = H[8];
  if (!Number.isFinite(k) || Math.abs(k) < 1e-300) return null;
  return H.map((v) => v / k);
}

/** Bilinear interpolation of four corner points: p00 (u=0,v=0), p10, p01, p11. */
export function bilerp(p00: Pt, p10: Pt, p01: Pt, p11: Pt, u: number, v: number): Pt {
  const a = (1 - u) * (1 - v);
  const b = u * (1 - v);
  const c = (1 - u) * v;
  const d = u * v;
  return { x: p00.x * a + p10.x * b + p01.x * c + p11.x * d, y: p00.y * a + p10.y * b + p01.y * c + p11.y * d };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
