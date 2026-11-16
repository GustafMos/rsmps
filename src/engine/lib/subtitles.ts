/**
 * Subtitle files as pure data: SubRip (.srt) and WebVTT (.vtt) parsers, a tiny writer (tests, round trips), word timing and
 * cue lookup. No imports, no DOM. Seconds throughout.
 *
 * Tolerant on purpose: BOM, CRLF / CR line ends, `,` or `.` milliseconds, missing hours, missing blank lines between cues,
 * garbage blocks (skipped and counted), overlapping cues (kept, looked up by the latest start), `<i> <b> <u> <font> <c.x> <v Name>`
 * tags (stripped), ASS-style `{\an8}` (mapped to a top / middle / bottom hint) and VTT word timestamps `<00:00:01.200>` (kept as
 * per-word times when present). Everything is a deterministic function of the file text.
 */

export interface SubWord {
  text: string;
  start: number;
  end: number;
}

export interface Cue {
  /** The number written in the file, or the 1-based order of appearance when there is none. */
  index: number;
  start: number;
  end: number;
  /** All lines joined by "\n". */
  text: string;
  lines: string[];
  /** Per-word times, ONLY when the file carried word timestamps (VTT). Otherwise use `wordTimings(cue)`. */
  words?: SubWord[];
  /** Position hint from `{\an8}` or a VTT `line:` setting. Absent = bottom (the default). */
  valign?: 'top' | 'middle' | 'bottom';
}

export interface ParseResult {
  cues: Cue[];
  format: 'srt' | 'vtt';
  /** Blocks that looked like cues but could not be used (no text, end before start, unreadable time). */
  skipped: number;
}

const TS = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?`;
const TIMING_RE = new RegExp(String.raw`^\s*${TS}\s*-->\s*${TS}(.*)$`);
const WORD_TS_RE = new RegExp(String.raw`<${TS}>`, 'g');

function tsToSeconds(h: string | undefined, m: string, s: string, f: string | undefined): number {
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + (f ? Number(`0.${f}`) : 0);
}

/** "01:02:03,456" / "02:03.4" / "3:04" -> seconds, or null. */
export function parseTimestamp(text: string): number | null {
  const m = new RegExp(`^\\s*${TS}\\s*$`).exec(text);
  return m ? tsToSeconds(m[1], m[2], m[3], m[4]) : null;
}

/** Seconds -> "HH:MM:SS,mmm" (SubRip, sep ',') or "HH:MM:SS.mmm" (WebVTT, sep '.'). Rounds to the millisecond with carry. */
export function formatTimestamp(seconds: number, sep: ',' | '.' = ','): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

type Piece = { k: 'text'; s: string } | { k: 'time'; t: number } | { k: 'nl' };

/** Words of a text: whitespace separated, non-breaking spaces count as spaces. */
export function splitWords(text: string): string[] {
  return text.split(/[\s ]+/).filter(Boolean);
}

/** Relative time a word occupies: its letters plus a pause weight for trailing punctuation. Shared with `wordTimings`. */
export function wordWeight(word: string): number {
  const letters = word.replace(/[\p{P}\p{S}]/gu, '').length;
  let w = Math.max(1, letters);
  if (/[.!?…]["')\]]*$/.test(word)) w += 4;
  else if (/[,;:]["')\]]*$/.test(word)) w += 2;
  else if (/[-–—]$/.test(word)) w += 1;
  return w;
}

/** Spread [start, end] over words by `wordWeight`. Deterministic; the pieces tile the interval exactly. */
export function distributeTimes(words: string[], start: number, end: number): SubWord[] {
  const weights = words.map(wordWeight);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out: SubWord[] = [];
  let acc = 0;
  words.forEach((text, i) => {
    const a = start + ((end - start) * acc) / sum;
    acc += weights[i];
    const b = i === words.length - 1 ? end : start + ((end - start) * acc) / sum;
    out.push({ text, start: a, end: b });
  });
  return out;
}

/** Word times of a cue: the file's own when it had them, else spread over the cue by `wordWeight`. */
export function wordTimings(cue: Pick<Cue, 'text' | 'start' | 'end' | 'words'>): SubWord[] {
  if (cue.words && cue.words.length) return cue.words;
  return distributeTimes(splitWords(cue.text), cue.start, cue.end);
}

function buildCue(index: number, start: number, end: number, rawLines: string[], settings: string): Cue | null {
  let valign: Cue['valign'];
  const pieces: Piece[] = [];
  rawLines.forEach((raw, li) => {
    let line = raw.replace(/\\N/g, '\n').replace(/\\h/g, ' ');
    // ASS override blocks: keep only the alignment hint.
    line = line.replace(/\{[^}]*\}/g, (blk) => {
      const an = /\\an(\d)/.exec(blk);
      if (an) valign = Number(an[1]) >= 7 ? 'top' : Number(an[1]) >= 4 ? 'middle' : 'bottom';
      return '';
    });
    let last = 0;
    WORD_TS_RE.lastIndex = 0;
    for (let m = WORD_TS_RE.exec(line); m; m = WORD_TS_RE.exec(line)) {
      if (m.index > last) pieces.push({ k: 'text', s: line.slice(last, m.index) });
      pieces.push({ k: 'time', t: tsToSeconds(m[1], m[2], m[3], m[4]) });
      last = m.index + m[0].length;
    }
    if (last < line.length) pieces.push({ k: 'text', s: line.slice(last) });
    if (li < rawLines.length - 1) pieces.push({ k: 'nl' });
  });

  const lines: string[] = [''];
  const words: { text: string; t: number | null }[] = [];
  let cur: string | null = null;
  let curT: number | null = null;
  let pending: number | null = null;
  const flush = () => {
    if (cur) words.push({ text: cur, t: curT });
    cur = null;
  };
  for (const p of pieces) {
    if (p.k === 'time') pending = p.t;
    else if (p.k === 'nl') {
      flush();
      lines.push('');
    } else {
      // Tags are removed first (so `<c.yellow>word</c>` is the word), then entities. A '<' not followed by a letter is text.
      const txt = decodeEntities(p.s.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\r/g, ''));
      lines[lines.length - 1] += txt;
      for (const ch of txt) {
        if (/[\s ]/.test(ch)) flush();
        else {
          if (cur === null) {
            cur = '';
            curT = pending;
            pending = null;
          }
          cur += ch;
        }
      }
    }
  }
  flush();
  const cleaned = lines.map((l) => l.replace(/[\s ]+/g, ' ').trim()).filter((l) => l.length);
  if (!cleaned.length) return null;

  const cue: Cue = { index, start, end, text: cleaned.join('\n'), lines: cleaned };
  if (valign) cue.valign = valign;
  const lm = /(?:^|\s)line:(-?\d+(?:\.\d+)?)(%?)/.exec(settings);
  if (lm && !cue.valign) {
    const n = Number(lm[1]);
    if (lm[2]) cue.valign = n <= 33 ? 'top' : n <= 66 ? 'middle' : 'bottom';
    else if (n === 0) cue.valign = 'top';
  }
  if (words.some((w) => w.t !== null)) {
    // Fill the words that had no time of their own: the first starts with the cue, others share the gap to the next known time.
    const t: number[] = words.map((w) => (w.t === null ? NaN : Math.min(Math.max(w.t, start), end)));
    if (Number.isNaN(t[0])) t[0] = start;
    for (let i = 1; i < t.length; i++) if (!Number.isNaN(t[i]) && t[i] < t[i - 1]) t[i] = t[i - 1];
    let i = 0;
    while (i < t.length) {
      if (!Number.isNaN(t[i])) {
        i++;
        continue;
      }
      const from = i - 1;
      let to = i;
      while (to < t.length && Number.isNaN(t[to])) to++;
      const a = t[from];
      const b = to < t.length ? t[to] : end;
      const share = distributeTimes(words.slice(from, to).map((w) => w.text), a, b);
      for (let k = from + 1; k < to; k++) t[k] = share[k - from].start;
      i = to;
    }
    cue.words = words.map((w, k) => ({ text: w.text, start: t[k], end: k === words.length - 1 ? end : t[k + 1] }));
  }
  return cue;
}

/** Parse SRT or VTT text (the format is detected from a WEBVTT header unless `hint` says). */
export function parseSubtitles(source: string, hint?: 'srt' | 'vtt'): ParseResult {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const format: 'srt' | 'vtt' = hint ?? (/^\s*WEBVTT/.test(text) ? 'vtt' : 'srt');
  const lines = text.split('\n');
  const cues: Cue[] = [];
  let skipped = 0;
  let order = 0;

  let cur: { index: number | null; start: number; end: number; settings: string; body: string[] } | null = null;
  const finish = () => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (!(c.end > c.start) || !Number.isFinite(c.start) || !Number.isFinite(c.end)) {
      skipped++;
      return;
    }
    const cue = buildCue(c.index ?? order + 1, c.start, c.end, c.body, c.settings);
    if (!cue) skipped++;
    else {
      order++;
      cues.push(cue);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TIMING_RE.exec(line);
    if (m) {
      // A number line directly above the time line belongs to this cue, not to the previous one's text.
      let index: number | null = null;
      const prev = cur as { body: string[] } | null;
      if (prev && prev.body.length && /^\d+$/.test(prev.body[prev.body.length - 1].trim())) index = Number(prev.body.pop());
      else if (i > 0 && /^\s*\d+\s*$/.test(lines[i - 1])) index = Number(lines[i - 1]);
      finish();
      cur = { index, start: tsToSeconds(m[1], m[2], m[3], m[4]), end: tsToSeconds(m[5], m[6], m[7], m[8]), settings: m[9] ?? '', body: [] };
    } else if (line.trim() === '') finish();
    else if (cur) (cur as { body: string[] }).body.push(line);
    // else: header, NOTE / STYLE / REGION block, cue identifier or garbage between cues: ignored.
  }
  finish();

  // Stable sort by start (files are normally ordered already).
  const sorted = cues.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map((x) => x.c);
  return { cues: sorted, format, skipped };
}

/** SubRip text for cues (tests, round trips). Word timestamps are not written. */
export function writeSrt(cues: readonly Pick<Cue, 'start' | 'end' | 'text'>[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

/** WebVTT text for cues. When a cue has `words`, they are written as `<hh:mm:ss.mmm>` timestamps. */
export function writeVtt(cues: readonly Pick<Cue, 'start' | 'end' | 'text' | 'words'>[]): string {
  const body = cues.map((c, i) => {
    const t = c.words?.length ? c.words.map((w, k) => (k === 0 ? w.text : `<${formatTimestamp(w.start, '.')}>${w.text}`)).join(' ') : c.text;
    return `${i + 1}\n${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${t}\n`;
  });
  return `WEBVTT\n\n${body.join('\n')}`;
}

/* ------------------------------------------------------------------------ */
/* Cue lookup                                                                */
/* ------------------------------------------------------------------------ */

export interface SubTrack {
  cues: readonly Cue[];
  starts: Float64Array;
  /** Running maximum of `end`: lets the lookup stop walking back through overlapping cues. */
  maxEnd: Float64Array;
  /** End of the last cue (seconds). */
  length: number;
  /** Content signature, for cache keys. */
  key: string;
}

/** FNV-1a over the cue times and text. */
function trackKey(cues: readonly Cue[]): string {
  let h1 = 2166136261;
  let h2 = 0x811c9dc5 ^ cues.length;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
    }
  };
  for (const c of cues) mix(`${c.start}|${c.end}|${c.text}\u0001`);
  return `${cues.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** Index a list of cues for `cueIndexAt`. Cues must be sorted by start (`parseSubtitles` does). */
export function buildTrack(cues: readonly Cue[]): SubTrack {
  const starts = new Float64Array(cues.length);
  const maxEnd = new Float64Array(cues.length);
  let m = -Infinity;
  cues.forEach((c, i) => {
    starts[i] = c.start;
    m = Math.max(m, c.end);
    maxEnd[i] = m;
  });
  return { cues, starts, maxEnd, length: cues.length ? m : 0, key: trackKey(cues) };
}

/**
 * The cue showing at `t` (start <= t < end), or -1. When cues overlap, the one that started last wins. O(log n + overlap):
 * binary search for the last start <= t, then a short walk back that stops when no earlier cue can still be showing.
 */
export function cueIndexAt(track: SubTrack, t: number): number {
  let lo = 0;
  let hi = track.starts.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track.starts[mid] <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let j = i; j >= 0 && track.maxEnd[j] > t; j--) if (track.cues[j].end > t) return j;
  return -1;
}

/* ------------------------------------------------------------------------ */
/* The "text" parameter: one cue per line, optional [from-to] prefix        */
/* ------------------------------------------------------------------------ */

/** Time of a bracket prefix: "1.5", "0:01.5", "1:02:03". */
function bracketTime(s: string): number | null {
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/**
 * Cues from a plain multi-line text. Each non-empty line is a cue; `[1.0-2.5] Hello` gives it a time range (seconds or m:ss.s).
 * A literal `\n` in a line is a line break inside the cue. With NO times anywhere the cues share `duration` equally. A line without
 * times among timed ones starts when the previous cue ends and lasts 2 seconds.
 */
export function parseCueText(source: string, duration: number): Cue[] {
  const rows = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^\[\s*([^\]\-–]+?)\s*[-–]\s*([^\]]+?)\s*\]\s*(.*)$/.exec(l);
      const a = m ? bracketTime(m[1]) : null;
      const b = m ? bracketTime(m[2]) : null;
      if (m && a !== null && b !== null) return { start: a, end: b, text: m[3] };
      return { start: null as number | null, end: null as number | null, text: l };
    });
  const anyTimed = rows.some((r) => r.start !== null);
  const n = rows.length;
  const cues: Cue[] = [];
  let prevEnd = 0;
  rows.forEach((r, i) => {
    let start: number;
    let end: number;
    if (r.start !== null && r.end !== null) {
      start = r.start;
      end = r.end;
    } else if (!anyTimed) {
      start = (duration * i) / n;
      end = (duration * (i + 1)) / n;
    } else {
      start = prevEnd;
      end = prevEnd + 2;
    }
    if (!(end > start)) return;
    prevEnd = end;
    const cue = buildCue(cues.length + 1, start, end, r.text.split(/\\n/), '');
    if (cue) cues.push(cue);
  });
  return cues.sort((a, b) => a.start - b.start);
}
