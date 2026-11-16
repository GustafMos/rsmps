/**
 * Built-in bitmap font for the ASCII art node. All glyph data below was drawn for this project.
 * Printable ASCII 32..126 is stored as 5x7 pixel patterns (seven rows, five bits each, leftmost pixel = bit 4)
 * and placed into a 6x8 cell (one blank column and one blank row of spacing). Shade blocks, line pieces and
 * braille-style dot patterns are generated from rules, so they cost no data.
 */
export const GLYPH_W = 6;
export const GLYPH_H = 8;

const ROWS: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '"': [10, 10, 10, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10],
  $: [4, 15, 20, 14, 5, 30, 4],
  '%': [24, 25, 2, 4, 8, 19, 3],
  '&': [12, 18, 20, 8, 21, 18, 13],
  "'": [4, 4, 8, 0, 0, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '*': [0, 4, 21, 14, 21, 4, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ',': [0, 0, 0, 0, 12, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  '/': [1, 1, 2, 4, 8, 16, 16],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ':': [0, 12, 12, 0, 12, 12, 0],
  ';': [0, 12, 12, 0, 12, 4, 8],
  '<': [2, 4, 8, 16, 8, 4, 2],
  '=': [0, 0, 31, 0, 31, 0, 0],
  '>': [8, 4, 2, 1, 2, 4, 8],
  '?': [14, 17, 1, 2, 4, 0, 4],
  '@': [14, 17, 23, 21, 23, 16, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  '[': [14, 8, 8, 8, 8, 8, 14],
  '\\': [16, 16, 8, 4, 2, 1, 1],
  ']': [14, 2, 2, 2, 2, 2, 14],
  '^': [4, 10, 17, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  '`': [8, 4, 2, 0, 0, 0, 0],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 22, 25, 17, 17, 30],
  c: [0, 0, 14, 16, 16, 17, 14],
  d: [1, 1, 13, 19, 17, 17, 15],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 9, 8, 28, 8, 8, 8],
  g: [0, 15, 17, 17, 15, 1, 14],
  h: [16, 16, 22, 25, 17, 17, 17],
  i: [4, 0, 12, 4, 4, 4, 14],
  j: [2, 0, 6, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 18],
  l: [12, 4, 4, 4, 4, 4, 14],
  m: [0, 0, 26, 21, 21, 17, 17],
  n: [0, 0, 22, 25, 17, 17, 17],
  o: [0, 0, 14, 17, 17, 17, 14],
  p: [0, 30, 17, 17, 30, 16, 16],
  q: [0, 13, 19, 17, 15, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16],
  s: [0, 0, 15, 16, 14, 1, 30],
  t: [8, 8, 28, 8, 8, 9, 6],
  u: [0, 0, 17, 17, 17, 19, 13],
  v: [0, 0, 17, 17, 17, 10, 4],
  w: [0, 0, 17, 17, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 17, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
  '{': [2, 4, 4, 8, 4, 4, 2],
  '|': [4, 4, 4, 4, 4, 4, 4],
  '}': [8, 4, 4, 2, 4, 4, 8],
  '~': [0, 0, 8, 21, 2, 0, 0],
};

export const ASCII_PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

/** One glyph: GLYPH_W x GLYPH_H coverage values 0..1, row-major, row 0 at the top. */
export type Glyph = Float32Array;

function blank(): Glyph {
  return new Float32Array(GLYPH_W * GLYPH_H);
}

/** Shade blocks, box-drawing lines and braille-style dots drawn by rule. Returns null for characters the font lacks. */
function ruleGlyph(ch: string): Glyph | null {
  const g = blank();
  const set = (x: number, y: number, v = 1) => {
    if (x >= 0 && x < GLYPH_W && y >= 0 && y < GLYPH_H) g[y * GLYPH_W + x] = v;
  };
  const code = ch.codePointAt(0)!;
  if (code >= 0x2800 && code <= 0x28ff) {
    // braille: two columns of four dots, bit order 1,2,3,7 (left) and 4,5,6,8 (right)
    const bits = code - 0x2800;
    const left = [0, 1, 2, 6];
    const right = [3, 4, 5, 7];
    for (let r = 0; r < 4; r++) {
      if (bits & (1 << left[r])) { set(0, r * 2, 1); set(1, r * 2, 1); }
      if (bits & (1 << right[r])) { set(3, r * 2, 1); set(4, r * 2, 1); }
    }
    return g;
  }
  const midX = 2;
  const midY = 3;
  const hline = (x0: number, x1: number) => { for (let x = x0; x <= x1; x++) { set(x, midY); set(x, midY + 1); } };
  const vline = (y0: number, y1: number) => { for (let y = y0; y <= y1; y++) { set(midX, y); set(midX + 1, y); } };
  switch (ch) {
    case '░': for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) if ((x + 2 * y) % 4 === 0) set(x, y); return g;
    case '▒': for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) if ((x + y) % 2 === 0) set(x, y); return g;
    case '▓': for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) if ((x + 2 * y) % 4 !== 0) set(x, y); return g;
    case '█': g.fill(1); return g;
    case '▀': for (let y = 0; y < 4; y++) for (let x = 0; x < GLYPH_W; x++) set(x, y); return g;
    case '▄': for (let y = 4; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) set(x, y); return g;
    case '▌': for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < 3; x++) set(x, y); return g;
    case '▐': for (let y = 0; y < GLYPH_H; y++) for (let x = 3; x < GLYPH_W; x++) set(x, y); return g;
    case '─': hline(0, 5); return g;
    case '│': vline(0, 7); return g;
    case '┼': hline(0, 5); vline(0, 7); return g;
    case '┌': hline(2, 5); vline(3, 7); return g;
    case '┐': hline(0, 3); vline(3, 7); return g;
    case '└': hline(2, 5); vline(0, 4); return g;
    case '┘': hline(0, 3); vline(0, 4); return g;
    case '├': hline(2, 5); vline(0, 7); return g;
    case '┤': hline(0, 3); vline(0, 7); return g;
    case '┬': hline(0, 5); vline(3, 7); return g;
    case '┴': hline(0, 5); vline(0, 4); return g;
    default: return null;
  }
}

/** The built-in glyph for a character (null when there is none). */
export function builtinGlyph(ch: string): Glyph | null {
  const rows = ROWS[ch];
  if (rows) {
    const g = blank();
    for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (rows[y] & (1 << (4 - x))) g[y * GLYPH_W + x] = 1;
    return g;
  }
  return ruleGlyph(ch);
}

/** Ink fraction of a glyph, 0..1. */
export function coverage(g: Glyph): number {
  let s = 0;
  for (const v of g) s += v;
  return s / g.length;
}

/** Mean coverage of an n x n grid of sub-blocks (row-major), the "structure" used for shape matching. */
export function descriptor(g: Glyph, w: number, h: number, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let by = 0; by < n; by++)
    for (let bx = 0; bx < n; bx++) {
      const x0 = Math.floor((bx * w) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * w) / n));
      const y0 = Math.floor((by * h) / n);
      const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * h) / n));
      let s = 0;
      let c = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += g[y * w + x]; c++; }
      out[by * n + bx] = s / c;
    }
  return out;
}

export const BRAILLE = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x2800 + i)).join('');

export const CHARSETS: Record<string, string> = {
  classic: ' .:-=+*#%@',
  long: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  blocks: ' ░▒▓█',
  binary: '01',
  digits: '0123456789',
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  braille: BRAILLE,
  all: ASCII_PRINTABLE,
  lines: ' -_|/\\+=#',
};

/** Unique characters of a string, in order. Characters the built-in font cannot draw are dropped (a space is always kept). */
export function uniqueChars(s: string, available: (ch: string) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of Array.from(s)) {
    if (seen.has(ch) || !available(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}
