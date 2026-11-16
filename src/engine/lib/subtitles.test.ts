import { describe, expect, it } from 'vitest';
import { buildTrack, cueIndexAt, distributeTimes, formatTimestamp, parseCueText, parseSubtitles, parseTimestamp, splitWords, wordTimings, writeSrt, writeVtt } from './subtitles';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello <i>world</i>
second line

2
00:00:04,000 --> 00:00:06,000
{\\an8}Top <b>cue</b>
`;

describe('SubRip', () => {
  it('parses cues, multi-line text and tags', () => {
    const r = parseSubtitles(SRT);
    expect(r.format).toBe('srt');
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ index: 1, start: 1, end: 3.5, text: 'Hello world\nsecond line', lines: ['Hello world', 'second line'] });
    expect(r.cues[1].text).toBe('Top cue');
    expect(r.cues[1].valign).toBe('top');
    expect(r.cues[0].words).toBeUndefined();
  });

  it('handles BOM, CRLF, CR and period milliseconds', () => {
    const crlf = `﻿${SRT.replace(/\n/g, '\r\n')}`;
    expect(parseSubtitles(crlf).cues.map((c) => c.text)).toEqual(['Hello world\nsecond line', 'Top cue']);
    expect(parseSubtitles(SRT.replace(/\n/g, '\r')).cues).toHaveLength(2);
    expect(parseSubtitles('1\n00:00:01.250 --> 00:00:02.5\nx\n').cues[0]).toMatchObject({ start: 1.25, end: 2.5 });
  });

  it('skips garbage and empty blocks, counts them, keeps the good ones', () => {
    const r = parseSubtitles(`garbage line\n\nnot a cue\nat all\n\n1\n00:00:01,000 --> 00:00:02,000\nok\n\n2\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n3\n00:00:06,000 --> 00:00:07,000\n\n\n4\n00:00:08,000 --> 00:00:09,000\nlast`);
    expect(r.cues.map((c) => c.text)).toEqual(['ok', 'last']);
    expect(r.skipped).toBe(2);
  });

  it('copes with a missing blank line between cues and keeps numbers as indices', () => {
    const r = parseSubtitles('7\n00:00:01,000 --> 00:00:02,000\nfirst\n8\n00:00:03,000 --> 00:00:04,000\nsecond');
    expect(r.cues.map((c) => [c.index, c.text])).toEqual([[7, 'first'], [8, 'second']]);
  });

  it('sorts out-of-order cues and keeps overlapping ones; lookup picks the latest start', () => {
    const r = parseSubtitles('2\n00:00:02,000 --> 00:00:06,000\nB\n\n1\n00:00:00,000 --> 00:00:10,000\nA\n\n3\n00:00:04,000 --> 00:00:05,000\nC\n');
    expect(r.cues.map((c) => c.text)).toEqual(['A', 'B', 'C']);
    const tr = buildTrack(r.cues);
    expect(r.cues[cueIndexAt(tr, 1)].text).toBe('A');
    expect(r.cues[cueIndexAt(tr, 3)].text).toBe('B');
    expect(r.cues[cueIndexAt(tr, 4.5)].text).toBe('C');
    expect(r.cues[cueIndexAt(tr, 5.5)].text).toBe('B'); // C ended, B (started later than A) still shows
    expect(r.cues[cueIndexAt(tr, 7)].text).toBe('A');
    expect(cueIndexAt(tr, 10)).toBe(-1);
    expect(cueIndexAt(tr, -1)).toBe(-1);
  });

  it('decodes entities and keeps a lone "<"', () => {
    expect(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nTom &amp; Jerry &lt;3 a < b').cues[0].text).toBe('Tom & Jerry <3 a < b');
  });

  it('round trips through the writer', () => {
    const r = parseSubtitles(SRT);
    const again = parseSubtitles(writeSrt(r.cues));
    expect(again.cues.map((c) => [c.start, c.end, c.text])).toEqual(r.cues.map((c) => [c.start, c.end, c.text]));
  });
});

describe('WebVTT', () => {
  const VTT = `WEBVTT - a header

NOTE this is a comment
with two lines

STYLE
::cue { color: red }

intro
00:00:01.000 --> 00:00:04.000 line:10% position:50%
<v Roger>Hello <c.yellow>big</c> world</v>

00:05.000 --> 00:07.000
<00:00:05.000>One <00:00:05.500>two <00:00:06.250>three
`;

  it('detects the format, skips NOTE / STYLE blocks and identifiers, strips voice and class tags', () => {
    const r = parseSubtitles(VTT);
    expect(r.format).toBe('vtt');
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0].text).toBe('Hello big world');
    expect(r.cues[0].valign).toBe('top');
    expect(r.cues[0].words).toBeUndefined();
  });

  it('keeps word timestamps, with hours optional', () => {
    const c = parseSubtitles(VTT).cues[1];
    expect(c.start).toBe(5);
    expect(c.words).toEqual([
      { text: 'One', start: 5, end: 5.5 },
      { text: 'two', start: 5.5, end: 6.25 },
      { text: 'three', start: 6.25, end: 7 },
    ]);
    expect(c.text).toBe('One two three');
    expect(wordTimings(c)).toBe(c.words);
  });

  it('fills words that have no timestamp between the ones that do, and a first word without one', () => {
    const c = parseSubtitles('WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nA bb <00:00:02.000>ccc dd\n').cues[0];
    expect(c.words![0].start).toBe(0);
    expect(c.words![1].start).toBeGreaterThan(0);
    expect(c.words![1].start).toBeLessThan(2);
    expect(c.words![2].start).toBe(2);
    expect(c.words![3].start).toBeGreaterThan(2);
    expect(c.words![3].end).toBe(4);
  });

  it('round trips word times through the VTT writer', () => {
    const c = parseSubtitles(VTT).cues[1];
    const again = parseSubtitles(writeVtt([c])).cues[0];
    expect(again.words).toEqual(c.words);
  });
});

describe('timestamps', () => {
  it('parses and formats', () => {
    expect(parseTimestamp('01:02:03,456')).toBeCloseTo(3723.456, 6);
    expect(parseTimestamp('02:03.4')).toBeCloseTo(123.4, 6);
    expect(parseTimestamp('nope')).toBeNull();
    expect(formatTimestamp(3723.456, ',')).toBe('01:02:03,456');
    expect(formatTimestamp(59.9996, '.')).toBe('00:01:00.000');
  });
});

describe('word timing', () => {
  it('splits proportionally to length, tiles the cue exactly and is deterministic', () => {
    const t = distributeTimes(['a', 'bbbbbbbbb'], 10, 12);
    expect(t[0].start).toBe(10);
    expect(t[1].end).toBe(12);
    expect(t[0].end).toBe(t[1].start);
    expect(t[1].end - t[1].start).toBeCloseTo(1.8, 6);
    expect(distributeTimes(['a', 'bbbbbbbbb'], 10, 12)).toEqual(t);
  });

  it('gives punctuation a pause weight', () => {
    const [plain, stop] = distributeTimes(['word', 'word.'], 0, 10).map((w) => w.end - w.start);
    expect(stop).toBeGreaterThan(plain);
    const [comma] = distributeTimes(['word,', 'word'], 0, 10).map((w) => w.end - w.start);
    expect(comma).toBeGreaterThan(5);
  });

  it('splitWords ignores runs of spaces and non-breaking spaces', () => {
    expect(splitWords('  a b   c\nd ')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('cue lookup on a long file', () => {
  it('finds cues among 5,000 in a few microseconds each', () => {
    const cues = Array.from({ length: 5000 }, (_, i) => ({ index: i + 1, start: i * 2, end: i * 2 + 1.5, text: `c${i}`, lines: [`c${i}`] }));
    const tr = buildTrack(cues);
    expect(cueIndexAt(tr, 4001)).toBe(2000);
    expect(cueIndexAt(tr, 4001.8)).toBe(-1);
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) cueIndexAt(tr, (i * 0.37) % 10000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('plain text source', () => {
  it('spreads untimed lines evenly over the project length', () => {
    const cues = parseCueText('one\n\ntwo\nthree', 6);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([[0, 2, 'one'], [2, 4, 'two'], [4, 6, 'three']]);
  });

  it('reads [from-to] prefixes in seconds and m:ss', () => {
    const cues = parseCueText('[0.5-1.5] hi there\n[0:02.0-0:03] second\\nline', 10);
    expect(cues[0]).toMatchObject({ start: 0.5, end: 1.5, text: 'hi there' });
    expect(cues[1]).toMatchObject({ start: 2, end: 3, lines: ['second', 'line'] });
  });

  it('puts an untimed line after the previous timed one when times are mixed', () => {
    const cues = parseCueText('[1-2] a\nb', 10);
    expect(cues[1]).toMatchObject({ start: 2, end: 4, text: 'b' });
  });
});
