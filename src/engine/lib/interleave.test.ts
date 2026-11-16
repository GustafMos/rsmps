import { describe, expect, it } from 'vitest';
import { cycleFrames, cycleHint, interleaveFrame, interleaveSeconds, parseOffsets, parsePattern, type InterleaveOpts } from './interleave';

/**
 * Hand-written expected tables. "v2f3" = source 2, its frame 3 (1-based, as the docs say; the code is 0-based). Each table is the first 12
 * output frames. These tables are the spec the owner reads (docs/RECIPES.md, "Weave several clips frame by frame").
 */
const base: InterleaveOpts = { mode: 'in-step', timing: 'longer', pattern: [], hold: 1, offsets: [], baseFrames: 0, loopSources: true };
const table = (count: number, o: Partial<InterleaveOpts>, frames = 12): string[] =>
  Array.from({ length: frames }, (_, n) => {
    const f = interleaveFrame(n, 24, count, { ...base, ...o });
    return `v${f.wire + 1}f${f.sourceFrame + 1}`;
  });
const inStep = { mode: 'in-step' } as const;
const longer = { mode: 'every-frame', timing: 'longer' } as const;
const same = { mode: 'every-frame', timing: 'same-length' } as const;

describe('interleaveFrame: N = 2', () => {
  it('in-step: v1 f1, v2 f2, v1 f3, v2 f4 ...', () => {
    expect(table(2, inStep)).toEqual(['v1f1', 'v2f2', 'v1f3', 'v2f4', 'v1f5', 'v2f6', 'v1f7', 'v2f8', 'v1f9', 'v2f10', 'v1f11', 'v2f12']);
  });
  it('every frame, longer: v1 f1, v2 f1, v1 f2, v2 f2 ...', () => {
    expect(table(2, longer)).toEqual(['v1f1', 'v2f1', 'v1f2', 'v2f2', 'v1f3', 'v2f3', 'v1f4', 'v2f4', 'v1f5', 'v2f5', 'v1f6', 'v2f6']);
  });
  it('every frame, same length: v1 f1, v2 f1, v1 f3, v2 f3 ...', () => {
    expect(table(2, same)).toEqual(['v1f1', 'v2f1', 'v1f3', 'v2f3', 'v1f5', 'v2f5', 'v1f7', 'v2f7', 'v1f9', 'v2f9', 'v1f11', 'v2f11']);
  });
  it('hold 2 (on twos)', () => {
    expect(table(2, { ...inStep, hold: 2 })).toEqual(['v1f1', 'v1f2', 'v2f3', 'v2f4', 'v1f5', 'v1f6', 'v2f7', 'v2f8', 'v1f9', 'v1f10', 'v2f11', 'v2f12']);
    expect(table(2, { ...longer, hold: 2 })).toEqual(['v1f1', 'v1f1', 'v2f1', 'v2f1', 'v1f2', 'v1f2', 'v2f2', 'v2f2', 'v1f3', 'v1f3', 'v2f3', 'v2f3']);
    expect(table(2, { ...same, hold: 2 })).toEqual(['v1f1', 'v1f1', 'v2f1', 'v2f1', 'v1f5', 'v1f5', 'v2f5', 'v2f5', 'v1f9', 'v1f9', 'v2f9', 'v2f9']);
  });
  it('pattern 2,1 (two frames of v1, then one of v2)', () => {
    expect(table(2, { ...inStep, pattern: [2, 1] })).toEqual(['v1f1', 'v1f2', 'v2f3', 'v1f4', 'v1f5', 'v2f6', 'v1f7', 'v1f8', 'v2f9', 'v1f10', 'v1f11', 'v2f12']);
    expect(table(2, { ...longer, pattern: [2, 1] })).toEqual(['v1f1', 'v1f2', 'v2f1', 'v1f3', 'v1f4', 'v2f2', 'v1f5', 'v1f6', 'v2f3', 'v1f7', 'v1f8', 'v2f4']);
    expect(table(2, { ...same, pattern: [2, 1] })).toEqual(['v1f1', 'v1f2', 'v2f1', 'v1f4', 'v1f5', 'v2f4', 'v1f7', 'v1f8', 'v2f7', 'v1f10', 'v1f11', 'v2f10']);
  });
  it('pattern 2,1 with hold 2', () => {
    expect(table(2, { ...longer, pattern: [2, 1], hold: 2 })).toEqual(['v1f1', 'v1f1', 'v1f2', 'v1f2', 'v2f1', 'v2f1', 'v1f3', 'v1f3', 'v1f4', 'v1f4', 'v2f2', 'v2f2']);
  });
  it('start offsets move a source in time', () => {
    expect(table(2, { ...inStep, offsets: [0, 2] })).toEqual(['v1f1', 'v2f4', 'v1f3', 'v2f6', 'v1f5', 'v2f8', 'v1f7', 'v2f10', 'v1f9', 'v2f12', 'v1f11', 'v2f14']);
    expect(table(2, { ...longer, offsets: [0, 3] })).toEqual(['v1f1', 'v2f4', 'v1f2', 'v2f5', 'v1f3', 'v2f6', 'v1f4', 'v2f7', 'v1f5', 'v2f8', 'v1f6', 'v2f9']);
  });
  it('sources wrap at their length (loop) or stay on the last frame', () => {
    expect(table(2, { ...inStep, baseFrames: 5 })).toEqual(['v1f1', 'v2f2', 'v1f3', 'v2f4', 'v1f5', 'v2f1', 'v1f2', 'v2f3', 'v1f4', 'v2f5', 'v1f1', 'v2f2']);
    expect(table(2, { ...longer, baseFrames: 5 })).toEqual(['v1f1', 'v2f1', 'v1f2', 'v2f2', 'v1f3', 'v2f3', 'v1f4', 'v2f4', 'v1f5', 'v2f5', 'v1f1', 'v2f1']);
    expect(table(2, { ...longer, baseFrames: 5, loopSources: false })).toEqual(['v1f1', 'v2f1', 'v1f2', 'v2f2', 'v1f3', 'v2f3', 'v1f4', 'v2f4', 'v1f5', 'v2f5', 'v1f5', 'v2f5']);
  });
  it('a negative offset never goes before the first frame', () => {
    expect(table(2, { ...inStep, offsets: [-5, 0] }, 4)).toEqual(['v1f1', 'v2f2', 'v1f1', 'v2f4']);
  });
});

describe('interleaveFrame: N = 3', () => {
  it('in-step', () => {
    expect(table(3, inStep)).toEqual(['v1f1', 'v2f2', 'v3f3', 'v1f4', 'v2f5', 'v3f6', 'v1f7', 'v2f8', 'v3f9', 'v1f10', 'v2f11', 'v3f12']);
  });
  it('every frame, longer', () => {
    expect(table(3, longer)).toEqual(['v1f1', 'v2f1', 'v3f1', 'v1f2', 'v2f2', 'v3f2', 'v1f3', 'v2f3', 'v3f3', 'v1f4', 'v2f4', 'v3f4']);
  });
  it('every frame, same length', () => {
    expect(table(3, same)).toEqual(['v1f1', 'v2f1', 'v3f1', 'v1f4', 'v2f4', 'v3f4', 'v1f7', 'v2f7', 'v3f7', 'v1f10', 'v2f10', 'v3f10']);
  });
  it('hold 3', () => {
    expect(table(3, { ...longer, hold: 3 })).toEqual(['v1f1', 'v1f1', 'v1f1', 'v2f1', 'v2f1', 'v2f1', 'v3f1', 'v3f1', 'v3f1', 'v1f2', 'v1f2', 'v1f2']);
  });
  it('pattern 1,1,3', () => {
    expect(table(3, { ...inStep, pattern: [1, 1, 3] })).toEqual(['v1f1', 'v2f2', 'v3f3', 'v3f4', 'v3f5', 'v1f6', 'v2f7', 'v3f8', 'v3f9', 'v3f10', 'v1f11', 'v2f12']);
    expect(table(3, { ...longer, pattern: [1, 1, 3] })).toEqual(['v1f1', 'v2f1', 'v3f1', 'v3f2', 'v3f3', 'v1f2', 'v2f2', 'v3f4', 'v3f5', 'v3f6', 'v1f3', 'v2f3']);
    expect(table(3, { ...same, pattern: [1, 1, 3] })).toEqual(['v1f1', 'v2f1', 'v3f1', 'v3f2', 'v3f3', 'v1f6', 'v2f6', 'v3f6', 'v3f7', 'v3f8', 'v1f11', 'v2f11']);
  });
});

describe('interleaveFrame: N = 5', () => {
  it('in-step', () => {
    expect(table(5, inStep)).toEqual(['v1f1', 'v2f2', 'v3f3', 'v4f4', 'v5f5', 'v1f6', 'v2f7', 'v3f8', 'v4f9', 'v5f10', 'v1f11', 'v2f12']);
  });
  it('every frame, longer', () => {
    expect(table(5, longer)).toEqual(['v1f1', 'v2f1', 'v3f1', 'v4f1', 'v5f1', 'v1f2', 'v2f2', 'v3f2', 'v4f2', 'v5f2', 'v1f3', 'v2f3']);
  });
  it('every frame, same length', () => {
    expect(table(5, same)).toEqual(['v1f1', 'v2f1', 'v3f1', 'v4f1', 'v5f1', 'v1f6', 'v2f6', 'v3f6', 'v4f6', 'v5f6', 'v1f11', 'v2f11']);
  });
  it('hold 2, offsets, pattern together (longer)', () => {
    // pattern 1,2,1,1,1 (cycle 6 steps), hold 2, source 3 starts 10 frames in
    expect(table(5, { ...longer, pattern: [1, 2, 1, 1, 1], hold: 2, offsets: [0, 0, 10, 0, 0] })).toEqual(['v1f1', 'v1f1', 'v2f1', 'v2f1', 'v2f2', 'v2f2', 'v3f11', 'v3f11', 'v4f1', 'v4f1', 'v5f1', 'v5f1']);
  });
});

describe('interleaveFrame: invariants', () => {
  it('every frame / longer shows each source frame in order, none skipped, none repeated (hold 1)', () => {
    for (const [count, pattern] of [[1, [1]], [2, [1, 1]], [3, [1, 1, 1]], [5, [1, 1, 1, 1, 1]], [2, [2, 1]], [3, [1, 1, 3]], [4, [3, 1, 2, 2]]] as [number, number[]][]) {
      const next = Array.from({ length: count }, () => 0);
      const C = pattern.reduce((a, b) => a + b, 0);
      for (let n = 0; n < C * 20; n++) {
        const f = interleaveFrame(n, 24, count, { ...base, ...longer, pattern });
        expect(f.sourceFrame).toBe(next[f.wire]++);
      }
    }
  });
  it('N equal sources, N times the frames: every source frame appears exactly once in N * base frames', () => {
    for (const N of [2, 3, 5]) {
      const seen = new Set<string>();
      for (let n = 0; n < N * 8; n++) {
        const f = interleaveFrame(n, 24, N, { ...base, ...longer });
        seen.add(`${f.wire}:${f.sourceFrame}`);
      }
      expect(seen.size).toBe(N * 8);
    }
  });
  it('in-step always shows source (step mod N) at the output frame number', () => {
    for (const N of [1, 2, 3, 5, 7]) for (const hold of [1, 2, 4]) for (let n = 0; n < 60; n++) {
      const f = interleaveFrame(n, 24, N, { ...base, ...inStep, hold });
      expect(f.sourceFrame).toBe(n);
      expect(f.wire).toBe(Math.floor(n / hold) % N);
    }
  });
  it('same length runs at normal speed: a source advances C frames per cycle of C frames, differing from in-step', () => {
    const a = table(2, same, 8);
    const b = table(2, inStep, 8);
    expect(a).not.toEqual(b);
    const f = (n: number) => interleaveFrame(n, 24, 3, { ...base, ...same });
    expect(f(30).sourceFrame - f(0).sourceFrame).toBe(30);
  });
  it('seconds follow the frame and the project fps', () => {
    const f = interleaveFrame(7, 25, 2, { ...base, ...inStep });
    expect(f.sourceSeconds).toBeCloseTo(7 / 25, 12);
    expect(f.wire).toBe(1);
  });
  it('a pattern of the wrong length behaves as 1 each; one source is the identity; garbage input is safe', () => {
    expect(table(3, { ...longer, pattern: [2, 1] })).toEqual(table(3, longer));
    expect(table(1, longer, 4)).toEqual(['v1f1', 'v1f2', 'v1f3', 'v1f4']);
    const g = interleaveFrame(-3, 24, 0, { ...base, hold: 0, pattern: [0, -1] as number[] });
    expect(g).toMatchObject({ wire: 0, sourceFrame: 0, step: 0 });
  });
});

describe('parsing and lengths', () => {
  it('parsePattern', () => {
    expect(parsePattern('', 3)).toEqual({ pattern: [1, 1, 1], valid: true, message: '' });
    expect(parsePattern('2,1', 2).pattern).toEqual([2, 1]);
    expect(parsePattern(' 1 ; 1, 3 ', 3).pattern).toEqual([1, 1, 3]);
    const bad = parsePattern('2,1', 3);
    expect(bad).toMatchObject({ pattern: [1, 1, 1], valid: false });
    expect(bad.message).toBe('pattern needs 3 numbers, has 2');
    expect(parsePattern('a,b', 2).valid).toBe(false);
    expect(parsePattern('0,1', 2).valid).toBe(false);
    expect(parsePattern('1.5,1', 2).valid).toBe(false);
    expect(parsePattern('999,1', 2).valid).toBe(false);
    expect(parsePattern(null, 2).pattern).toEqual([1, 1]);
  });
  it('parseOffsets', () => {
    expect(parseOffsets('0,12')).toEqual([0, 12]);
    expect(parseOffsets('')).toEqual([]);
    expect(parseOffsets('3, x, -2')).toEqual([3, 0, -2]);
  });
  it('cycle length, project length and the loop hint', () => {
    expect(cycleFrames([1, 1, 1], 1)).toBe(3);
    expect(cycleFrames([2, 1], 2)).toBe(6);
    expect(interleaveSeconds(4, [1, 1, 1], 1)).toBe(12);
    expect(interleaveSeconds(4, [2, 1], 1)).toBe(12);
    expect(interleaveSeconds(4, [1, 1], 2)).toBe(16);
    expect(interleaveSeconds(0, [1, 1], 1)).toBe(0);
    expect(cycleHint(3, 96)).toBe('');
    expect(cycleHint(5, 96)).toBe('cycle of 5 does not divide 96 frames');
    expect(cycleHint(3, 0)).toBe('');
    expect(cycleHint(1, 7)).toBe('');
  });
});
