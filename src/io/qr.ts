/**
 * Dependency-free QR code encoder: byte mode, versions 1-10, error correction level M, automatic mask selection.
 * `qrMatrix(text)` gives the modules; `qrSvg(text)` an inline SVG with the required quiet zone.
 * Verified in tests by decoding the result with an independent decoder (jsQR).
 */

/** Per version (index = version): EC codewords per block and the block groups [count, data codewords]. Level M. */
const BLOCKS_M: { ec: number; groups: [number, number][] }[] = [
  { ec: 0, groups: [] },
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const MAX_BYTES = 213;

/* ----------------------------------- Reed-Solomon over GF(256) ----------------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function generator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data: number[], ecLen: number): number[] {
  const g = generator(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(g[i + 1], factor);
  }
  return rem;
}

/* ---------------------------------------- codewords ---------------------------------------------- */

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function versionFor(len: number): number {
  for (let v = 1; v <= 10; v++) {
    const data = BLOCKS_M[v].groups.reduce((s, [n, k]) => s + n * k, 0);
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + len * 8 <= data * 8) return v;
  }
  throw new Error(`Text too long for the QR encoder (${len} bytes, max ${MAX_BYTES}).`);
}

function dataCodewords(bytes: number[], version: number): number[] {
  const total = BLOCKS_M[version].groups.reduce((s, [n, k]) => s + n * k, 0);
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; out.length < total; pad++) out.push(pad % 2 ? 0x11 : 0xec);
  return out;
}

function interleave(data: number[], version: number): number[] {
  const { ec, groups } = BLOCKS_M[version];
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + size));
      at += size;
    }
  }
  const ecs = blocks.map((b) => rsRemainder(b, ec));
  const out: number[] = [];
  const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

/* ------------------------------------------ matrix ----------------------------------------------- */

interface Grid {
  size: number;
  dark: boolean[][];
  /** True for function-pattern modules (never masked, never data). */
  fixed: boolean[][];
}

function emptyGrid(size: number): Grid {
  return {
    size,
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFixed(g: Grid, r: number, c: number, dark: boolean): void {
  if (r < 0 || c < 0 || r >= g.size || c >= g.size) return;
  g.dark[r][c] = dark;
  g.fixed[r][c] = true;
}

function finder(g: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      setFixed(g, row + r, col + c, dark);
    }
  }
}

function alignment(g: Grid, cr: number, cc: number): void {
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) setFixed(g, cr + r, cc + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
}

function bchBits(value: number, poly: number): number {
  const len = (n: number) => 32 - Math.clz32(n);
  let d = value;
  while (len(d) >= len(poly)) d ^= poly << (len(d) - len(poly));
  return d;
}

function placeFormat(g: Grid, mask: number): void {
  const data = (0b00 << 3) | mask; // level M = 00
  const bits = ((data << 10) | bchBits(data << 10, 0x537)) ^ 0x5412;
  const n = g.size;
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) setFixed(g, i, 8, dark);
    else if (i < 8) setFixed(g, i + 1, 8, dark);
    else setFixed(g, n - 15 + i, 8, dark);
    if (i < 8) setFixed(g, 8, n - i - 1, dark);
    else if (i < 9) setFixed(g, 8, 15 - i - 1 + 1, dark);
    else setFixed(g, 8, 15 - i - 1, dark);
  }
  setFixed(g, n - 8, 8, true); // the always-dark module
}

function placeVersion(g: Grid, version: number): void {
  if (version < 7) return;
  const bits = (version << 12) | bchBits(version << 12, 0x1f25);
  const n = g.size;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    setFixed(g, Math.floor(i / 3), (i % 3) + n - 11, dark);
    setFixed(g, (i % 3) + n - 11, Math.floor(i / 3), dark);
  }
}

function baseGrid(version: number): Grid {
  const n = 17 + 4 * version;
  const g = emptyGrid(n);
  finder(g, 0, 0);
  finder(g, 0, n - 7);
  finder(g, n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    setFixed(g, 6, i, i % 2 === 0);
    setFixed(g, i, 6, i % 2 === 0);
  }
  const pos = ALIGN[version];
  for (const r of pos) {
    for (const c of pos) {
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (c === 6 && r === pos[pos.length - 1]);
      if (!onFinder) alignment(g, r, c);
    }
  }
  placeVersion(g, version);
  placeFormat(g, 0); // reserves the format areas; rewritten per mask
  return g;
}

function placeData(g: Grid, codewords: number[]): void {
  const bits: boolean[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push(((cw >> i) & 1) === 1);
  let k = 0;
  let up = true;
  for (let col = g.size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the vertical timing pattern column is skipped
    for (let i = 0; i < g.size; i++) {
      const row = up ? g.size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (g.fixed[row][c]) continue;
        g.dark[row][c] = k < bits.length ? bits[k] : false; // remainder bits are 0
        k++;
      }
    }
    up = !up;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): Grid {
  const out: Grid = { size: g.size, dark: g.dark.map((row) => row.slice()), fixed: g.fixed.map((row) => row.slice()) };
  for (let r = 0; r < g.size; r++) for (let c = 0; c < g.size; c++) if (!g.fixed[r][c] && MASKS[mask](r, c)) out.dark[r][c] = !out.dark[r][c];
  placeFormat(out, mask);
  return out;
}

/** The four standard penalty rules. Lower is better. */
export function penalty(dark: boolean[][]): number {
  const n = dark.length;
  let score = 0;
  // N1: runs of 5+ in rows and columns
  for (let a = 0; a < n; a++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const same = (horizontal ? dark[a][b] === dark[a][b - 1] : dark[b][a] === dark[b - 1][a]);
        if (same) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // N2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (dark[r][c] === dark[r][c + 1] && dark[r][c] === dark[r + 1][c] && dark[r][c] === dark[r + 1][c + 1]) score += 3;
  // N3: finder-like 1011101 with 4 light modules on one side
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b + 11 <= n; b++) {
      for (const horizontal of [true, false]) {
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = (horizontal ? dark[a][b + k] : dark[b + k][a]) ? 1 : 0;
          if (v !== p1[k]) m1 = false;
          if (v !== p2[k]) m2 = false;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    }
  }
  // N4: balance of dark modules
  let darkCount = 0;
  for (const row of dark) for (const d of row) if (d) darkCount++;
  const pct = (darkCount * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export interface QrCode {
  version: number;
  mask: number;
  size: number;
  /** modules[row][col], true = dark. No quiet zone. */
  modules: boolean[][];
}

export function qrEncode(text: string): QrCode {
  const bytes = utf8(text);
  const version = versionFor(bytes.length);
  const codewords = interleave(dataCodewords(bytes, version), version);
  const base = baseGrid(version);
  placeData(base, codewords);
  let best: { g: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = applyMask(base, mask);
    const score = penalty(g.dark);
    if (!best || score < best.score) best = { g, mask, score };
  }
  return { version, mask: best!.mask, size: base.size, modules: best!.g.dark };
}

export function qrMatrix(text: string): boolean[][] {
  return qrEncode(text).modules;
}

/** Inline SVG (black on white, 4-module quiet zone). Scales to any width; give it a CSS width. */
export function qrSvg(text: string, opts: { quiet?: number } = {}): string {
  const m = qrMatrix(text);
  const q = opts.quiet ?? 4;
  const n = m.length + q * 2;
  let d = '';
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) {
        c++;
        continue;
      }
      let end = c;
      while (end < m.length && m[r][end]) end++;
      d += `M${c + q} ${r + q}h${end - c}v1h${c - end}z`;
      c = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
