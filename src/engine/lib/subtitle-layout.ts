/**
 * Subtitles, the pure part: which words are on screen when, how they break into lines, where the block sits (safe areas for
 * vertical video) and how every word animates in and out. No GPU, no DOM, no state: every function is a function of its
 * arguments (and the cue time), so the node, the tests and a future exporter agree and playback is deterministic.
 */
import type { SubWord } from './subtitles';

/* ------------------------------------------------------------------------ */
/* Which words are on screen                                                 */
/* ------------------------------------------------------------------------ */

export type SubMode = 'lines' | 'chunks' | 'word' | 'karaoke' | 'typewriter' | 'build';

/** A group of words that appear and disappear together (a whole cue, a TikTok chunk, a single word). */
export interface Unit {
  words: SubWord[];
  /** Index in the cue of `words[0]`. */
  first: number;
  /** The interval the unit is on screen. Units of one cue tile it without gaps. */
  start: number;
  end: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

/**
 * Split a cue's words into the units the mode shows. `chunks` / `word`: groups of at most `perChunk` words, never across a sentence
 * end, evenly sized (7 words at 3 per chunk are 3 + 2 + 2, not 3 + 3 + 1). A unit lasts from its first word's start to the next
 * unit's first word start (the first unit starts with the cue, the last ends with it). Other modes: the whole cue is one unit.
 */
export function planUnits(words: readonly SubWord[], cueStart: number, cueEnd: number, mode: SubMode, perChunk: number): Unit[] {
  if (!words.length) return [];
  if (mode !== 'chunks' && mode !== 'word') return [{ words: words.slice(), first: 0, start: cueStart, end: cueEnd }];
  const n = mode === 'word' ? 1 : Math.max(1, Math.round(perChunk));
  const groups: [number, number][] = [];
  let from = 0;
  const closeSegment = (to: number) => {
    const len = to - from;
    const count = Math.ceil(len / n);
    const base = Math.floor(len / count);
    const extra = len % count;
    let a = from;
    for (let g = 0; g < count; g++) {
      const size = base + (g < extra ? 1 : 0);
      groups.push([a, a + size]);
      a += size;
    }
    from = to;
  };
  for (let i = 0; i < words.length; i++) if (SENTENCE_END.test(words[i].text) || i === words.length - 1) closeSegment(i + 1);
  return groups.map(([a, b], k) => ({
    words: words.slice(a, b),
    first: a,
    start: k === 0 ? cueStart : words[a].start,
    end: k === groups.length - 1 ? cueEnd : words[groups[k + 1][0]].start,
  }));
}

/** The unit showing at `t` (last one that started), or -1 before the first. */
export function unitIndexAt(units: readonly Unit[], t: number): number {
  let r = -1;
  for (let i = 0; i < units.length; i++) if (units[i].start <= t) r = i;
  return r;
}

/** Index (in the cue) of the word being spoken at `t`, or -1. */
export function activeWordAt(words: readonly SubWord[], first: number, t: number): number {
  for (let i = 0; i < words.length; i++) if (t >= words[i].start && t < words[i].end) return first + i;
  return -1;
}

/** How much of a word is typed at `t` (0..1): its letters appear over the first 80% of its own time. */
export function typedFraction(word: SubWord, t: number): number {
  const span = Math.max(1e-6, (word.end - word.start) * 0.8);
  return Math.min(1, Math.max(0, (t - word.start) / span));
}

/* ------------------------------------------------------------------------ */
/* Line breaking and layout                                                  */
/* ------------------------------------------------------------------------ */

const lineW = (w: readonly number[], space: number, a: number, b: number): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += w[i];
  return s + space * Math.max(0, b - a - 1);
};

/** Greedy line starts for a maximum width. A word wider than the width gets a line of its own. */
function greedy(w: readonly number[], space: number, maxW: number): number[] {
  const starts = [0];
  let cur = w[0];
  for (let i = 1; i < w.length; i++) {
    if (cur + space + w[i] > maxW) {
      starts.push(i);
      cur = w[i];
    } else cur += space + w[i];
  }
  return starts;
}

/**
 * Indices where lines start. Greedy first (fewest lines); with `balanced` the same number of lines is re-split so they come out
 * near-equal in width (minimum-width search, then least squared slack): "I think this is going to be great" breaks 3 + 3, not 5 + 1.
 */
export function breakLines(widths: readonly number[], space: number, maxW: number, balanced = true): number[] {
  const n = widths.length;
  if (n === 0) return [];
  const base = greedy(widths, space, maxW);
  const N = base.length;
  if (!balanced || N === 1 || n > 120) return base;
  // The narrowest width that still fits in N lines.
  let lo = Math.max(...widths);
  let hi = maxW;
  for (let it = 0; it < 24 && hi - lo > 0.25; it++) {
    const mid = (lo + hi) / 2;
    if (greedy(widths, space, mid).length <= N) hi = mid;
    else lo = mid;
  }
  const W = Math.max(hi, Math.max(...widths));
  // DP: split into exactly N lines (each <= W) minimising the squared slack.
  const INF = 1e30;
  const cost: number[][] = Array.from({ length: N + 1 }, () => new Array<number>(n + 1).fill(INF));
  const from: number[][] = Array.from({ length: N + 1 }, () => new Array<number>(n + 1).fill(0));
  cost[0][0] = 0;
  for (let j = 1; j <= N; j++) {
    for (let i = j; i <= n; i++) {
      for (let k = j - 1; k < i; k++) {
        if (cost[j - 1][k] >= INF) continue;
        const lw = lineW(widths, space, k, i);
        if (lw > W + 1e-6 && i - k > 1) continue;
        const c = cost[j - 1][k] + (W - lw) * (W - lw);
        if (c < cost[j][i]) {
          cost[j][i] = c;
          from[j][i] = k;
        }
      }
    }
  }
  if (cost[N][n] >= INF) return base;
  const starts: number[] = [];
  let i = n;
  for (let j = N; j >= 1; j--) {
    const k = from[j][i];
    starts.unshift(k);
    i = k;
  }
  return starts;
}

export interface LayoutOpts {
  /** Width of a space, in the same units as the word widths. */
  space: number;
  /** Widest a line may be. */
  maxW: number;
  /** Most lines allowed before the block is shrunk. */
  maxLines: number;
  /** Distance between line centres. */
  lineH: number;
  align: 'left' | 'center' | 'right';
  balanced: boolean;
  /** Smallest shrink factor tried (default 0.4). */
  minScale?: number;
  /** Line starts the cue already has (its own breaks); used as they are when they fit. */
  keepBreaks?: readonly number[] | null;
}

export interface Placed {
  /** Left edge of the word's advance box, block-local. */
  x: number;
  /** Vertical centre of the word's line, block-local. */
  y: number;
  w: number;
  line: number;
}

export interface UnitLayout {
  words: Placed[];
  lines: { x: number; y: number; w: number; first: number; last: number }[];
  /** Block size (after scale). */
  w: number;
  h: number;
  /** 1 = nominal size; < 1 when the block was shrunk to fit (`auto-shrink`). Positions and widths are already multiplied by it. */
  scale: number;
}

const startsFits = (widths: readonly number[], o: LayoutOpts, starts: readonly number[], s: number): boolean => {
  if (starts.length > o.maxLines) return false;
  for (let li = 0; li < starts.length; li++) if (lineW(widths, o.space, starts[li], li + 1 < starts.length ? starts[li + 1] : widths.length) * s > o.maxW + 1e-6) return false;
  return true;
};

/** Break words into lines, shrinking the whole block (never below `minScale`) when it needs more lines than allowed or is too wide. */
export function layoutWords(widths: readonly number[], o: LayoutOpts): UnitLayout {
  const n = widths.length;
  if (!n) return { words: [], lines: [], w: 0, h: 0, scale: 1 };
  const pick = (s: number): number[] => {
    if (o.keepBreaks && o.keepBreaks.length && o.keepBreaks[0] === 0 && startsFits(widths, o, o.keepBreaks, s)) return o.keepBreaks.slice();
    return breakLines(widths, o.space, o.maxW / s, o.balanced);
  };
  const fits = (s: number) => startsFits(widths, o, pick(s), s);
  let scale = 1;
  if (!fits(1)) {
    const minS = o.minScale ?? 0.4;
    if (!fits(minS)) scale = minS;
    else {
      let lo = minS;
      let hi = 1;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      scale = lo;
    }
  }
  const starts = pick(scale);
  const lines: UnitLayout['lines'] = [];
  let blockW = 0;
  starts.forEach((a, li) => {
    const b = li + 1 < starts.length ? starts[li + 1] : n;
    const w = lineW(widths, o.space, a, b) * scale;
    blockW = Math.max(blockW, w);
    lines.push({ x: 0, y: (li + 0.5) * o.lineH * scale, w, first: a, last: b - 1 });
  });
  const words: Placed[] = new Array(n);
  lines.forEach((l, li) => {
    l.x = o.align === 'left' ? 0 : o.align === 'right' ? blockW - l.w : (blockW - l.w) / 2;
    let x = l.x;
    for (let i = l.first; i <= l.last; i++) {
      words[i] = { x, y: l.y, w: widths[i] * scale, line: li };
      x += (widths[i] + o.space) * scale;
    }
  });
  return { words, lines, w: blockW, h: lines.length * o.lineH * scale, scale };
}

/* ------------------------------------------------------------------------ */
/* Position and safe areas                                                   */
/* ------------------------------------------------------------------------ */

export type SafeArea = 'none' | 'tiktok' | 'reels' | 'shorts';

/**
 * Margins (fractions of the frame) that keep captions clear of each platform's interface in a 9:16 frame. APPROXIMATE guides from
 * the platforms' published safe-zone templates as commonly quoted (their apps change): use them as a starting point, not a promise.
 */
export const SAFE_AREAS: Record<SafeArea, { top: number; bottom: number; left: number; right: number }> = {
  none: { top: 0, bottom: 0, left: 0, right: 0 },
  tiktok: { top: 0.07, bottom: 0.22, left: 0.06, right: 0.13 },
  reels: { top: 0.13, bottom: 0.2, left: 0.06, right: 0.12 },
  shorts: { top: 0.07, bottom: 0.17, left: 0.05, right: 0.14 },
};

export interface Area {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** The rectangle the block may use: platform margins (only for portrait frames, where the guides make sense) plus a plain margin. */
export function safeRect(width: number, height: number, safe: SafeArea, margin: number): Area {
  const portrait = height >= width * 1.2;
  const m = portrait ? SAFE_AREAS[safe] : SAFE_AREAS.none;
  return {
    l: width * m.left + margin,
    t: height * m.top + margin,
    r: width - width * m.right - margin,
    b: height - height * m.bottom - margin,
  };
}

export type Position = 'bottom' | 'lower' | 'center' | 'top' | 'free';

/** Top-left of a block of size (w, h): bottom edge on the bottom of the area, etc. `free` puts the block's centre at (fx, fy) of the frame. */
export function placeBlock(w: number, h: number, area: Area, pos: Position, free: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  if (pos === 'free') return { x: free.x * free.width - w / 2, y: free.y * free.height - h / 2 };
  const x = (area.l + area.r) / 2 - w / 2;
  if (pos === 'top') return { x, y: area.t };
  if (pos === 'center') return { x, y: (area.t + area.b) / 2 - h / 2 };
  if (pos === 'lower') return { x, y: Math.min(area.b - h, area.t + (area.b - area.t) * 0.72 - h / 2) };
  return { x, y: area.b - h };
}

/* ------------------------------------------------------------------------ */
/* Animation                                                                 */
/* ------------------------------------------------------------------------ */

export type Ease = 'linear' | 'smooth' | 'out' | 'back' | 'bounce' | 'elastic';
export type AnimKind = 'none' | 'fade' | 'pop' | 'slide' | 'bounce' | 'blur' | 'wipe' | 'shake' | 'wave' | 'jitter' | 'flicker';
export type Dir = 'up' | 'down' | 'left' | 'right';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const easeOutBounce = (x: number): number => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

/** Easing curves on 0..1 (back, bounce and elastic overshoot 1 on the way, and end exactly at 1). */
export function ease(kind: Ease, x: number): number {
  const p = clamp01(x);
  switch (kind) {
    case 'smooth':
      return p * p * (3 - 2 * p);
    case 'out':
      return 1 - (1 - p) ** 3;
    case 'back': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
    }
    case 'bounce':
      return easeOutBounce(p);
    case 'elastic':
      return p === 0 || p === 1 ? p : 2 ** (-10 * p) * Math.sin(((p * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
    default:
      return p;
  }
}

/** Deterministic noise in [0, 1) from two integers. */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** One word's look at one moment. Distances are in em (multiples of the font size). */
export interface AnimState {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  /** Edge blur, em. */
  blur: number;
  /** Fraction of the word revealed from the left (1 = all). */
  wipe: number;
  /** Wave amplitude, em. */
  wave: number;
}

export const IDENTITY: Readonly<AnimState> = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, wipe: 1, wave: 0 };

export interface AnimOpts {
  ease: Ease;
  /** Direction for `slide`. */
  dir: Dir;
  /** Cue time in seconds (drives shake / jitter / flicker steps). */
  t: number;
  /** Per-word number so neighbours do not move in lockstep. */
  seed: number;
  /** Leaving: offsets point the way the word is going instead of where it came from. */
  out: boolean;
}

/**
 * The look of a word whose transition is at progress `p` (0 = not there yet / gone, 1 = fully shown). p = 1 is always the
 * identity, and every kind except `none` is invisible at p = 0 (alpha 0, or nothing revealed). Loop safe: nothing here reads a clock.
 */
export function animate(kind: AnimKind, p: number, o: AnimOpts): AnimState {
  if (kind === 'none' || p >= 1) return { ...IDENTITY };
  const q = clamp01(p);
  const e = ease(o.ease, q);
  const sign = o.out ? -1 : 1;
  const s: AnimState = { ...IDENTITY };
  switch (kind) {
    case 'fade':
      s.alpha = q;
      break;
    case 'pop': {
      s.scale = 0.4 + 0.6 * ease('back', q);
      s.alpha = clamp01(q * 5);
      break;
    }
    case 'slide': {
      const d = (1 - e) * sign;
      if (o.dir === 'up') s.dy = d * 0.5;
      else if (o.dir === 'down') s.dy = -d * 0.5;
      else if (o.dir === 'left') s.dx = d * 0.8;
      else s.dx = -d * 0.8;
      s.alpha = clamp01(q * 3);
      break;
    }
    case 'bounce':
      s.dy = -(1 - easeOutBounce(q)) * 0.9 * sign;
      s.alpha = clamp01(q * 6);
      break;
    case 'blur':
      s.blur = (1 - e) * 0.3;
      s.alpha = q;
      break;
    case 'wipe':
      s.wipe = e;
      break;
    case 'shake': {
      const step = Math.floor(o.t * 30);
      s.dx = (hash01(step, o.seed) - 0.5) * 0.24 * (1 - q);
      s.dy = (hash01(step, o.seed + 77) - 0.5) * 0.12 * (1 - q);
      s.alpha = clamp01(q * 4);
      break;
    }
    case 'wave':
      s.wave = (1 - q) * 0.35;
      s.alpha = clamp01(q * 3);
      break;
    case 'jitter': {
      const step = Math.floor(o.t * 12);
      s.dx = (hash01(step, o.seed * 3 + 1) - 0.5) * 0.4 * (1 - q);
      s.dy = (hash01(step, o.seed * 3 + 2) - 0.5) * 0.4 * (1 - q);
      s.alpha = clamp01(q * 4);
      break;
    }
    case 'flicker':
      s.alpha = hash01(Math.floor(o.t * 24), o.seed) < q * 1.2 ? 1 : 0;
      break;
  }
  return s;
}

export type Motion = 'none' | 'wave' | 'jitter' | 'shake' | 'flicker' | 'float';

/** Continuous motion while a word is shown (added to the in / out state). `amount` in em, `speed` in cycles per second. */
export function motion(kind: Motion, t: number, seed: number, amount: number, speed: number): Pick<AnimState, 'dx' | 'dy' | 'wave' | 'alpha'> {
  const r = { dx: 0, dy: 0, wave: 0, alpha: 1 };
  switch (kind) {
    case 'wave':
      r.wave = amount;
      break;
    case 'float':
      r.dy = Math.sin(2 * Math.PI * speed * t + seed * 0.7) * amount;
      break;
    case 'jitter': {
      const step = Math.floor(t * 12);
      r.dx = (hash01(step, seed * 3 + 1) - 0.5) * amount;
      r.dy = (hash01(step, seed * 3 + 2) - 0.5) * amount;
      break;
    }
    case 'shake': {
      const step = Math.floor(t * 30);
      r.dx = (hash01(step, 5) - 0.5) * amount * 2;
      r.dy = (hash01(step, 6) - 0.5) * amount;
      break;
    }
    case 'flicker':
      r.alpha = hash01(Math.floor(t * 20), seed) > 0.12 ? 1 : 0.35;
      break;
  }
  return r;
}

/** Progress (0..1) of a unit's / word's transition in and out at `t`. `stagger` delays word `i` of `count` by seconds. */
export function transitionProgress(t: number, start: number, end: number, dIn: number, dOut: number, i: number, count: number, stagger: number): { pIn: number; pOut: number } {
  const len = Math.max(1e-6, end - start);
  // Keep in + out inside the unit (and the stagger spread too), shrinking both together when it is short.
  const spread = stagger * Math.max(0, count - 1);
  const room = Math.max(1e-6, len);
  const k = Math.min(1, (room * 0.9) / Math.max(1e-6, dIn + dOut + spread));
  const din = dIn * k;
  const dout = dOut * k;
  const st = stagger * k;
  const pIn = din <= 1e-6 ? (t >= start + st * i ? 1 : 0) : clamp01((t - start - st * i) / din);
  const pOut = dout <= 1e-6 ? (t < end ? 1 : 0) : clamp01((end - t - st * (count - 1 - i)) / dout);
  return { pIn, pOut };
}
