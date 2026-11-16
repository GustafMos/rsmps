import { describe, expect, it } from 'vitest';
import { activeWordAt, animate, breakLines, ease, layoutWords, planUnits, placeBlock, safeRect, transitionProgress, typedFraction, unitIndexAt, type AnimKind } from './subtitle-layout';
import { distributeTimes } from './subtitles';

const words = (s: string, start = 0, end = 6) => distributeTimes(s.split(' '), start, end);

describe('units', () => {
  it('lines / karaoke / typewriter / build: one unit for the cue', () => {
    for (const mode of ['lines', 'karaoke', 'typewriter', 'build'] as const) {
      const u = planUnits(words('a b c d'), 0, 6, mode, 3);
      expect(u).toHaveLength(1);
      expect(u[0]).toMatchObject({ first: 0, start: 0, end: 6 });
    }
  });

  it('chunks are evenly sized and never cross a sentence end', () => {
    const sizes = (s: string, n: number) => planUnits(words(s), 0, 6, 'chunks', n).map((u) => u.words.length);
    expect(sizes('a b c d e f g', 3)).toEqual([3, 2, 2]);
    expect(sizes('a b c d e f', 3)).toEqual([3, 3]);
    expect(sizes('one two. three four five', 3)).toEqual([2, 3]);
    expect(sizes('a b c', 1)).toEqual([1, 1, 1]);
  });

  it('chunks tile the cue and word mode is one word per unit', () => {
    const w = words('a b c d e f', 10, 16);
    const u = planUnits(w, 10, 16, 'chunks', 2);
    expect(u[0].start).toBe(10);
    expect(u[u.length - 1].end).toBe(16);
    for (let i = 1; i < u.length; i++) expect(u[i].start).toBe(u[i - 1].end);
    expect(planUnits(w, 10, 16, 'word', 5)).toHaveLength(6);
    expect(unitIndexAt(u, 13.5)).toBe(1);
    expect(unitIndexAt(u, 9)).toBe(-1);
  });

  it('active word and typed fraction', () => {
    const w = words('aa bb cc', 0, 3);
    expect(activeWordAt(w, 0, 1.5)).toBe(1);
    expect(activeWordAt(w, 0, 3.5)).toBe(-1);
    expect(typedFraction(w[0], 0)).toBe(0);
    expect(typedFraction(w[0], 0.4)).toBeGreaterThan(0.2);
    expect(typedFraction(w[0], 1)).toBe(1);
  });
});

describe('line breaking', () => {
  it('breaks greedily, then balances the lines', () => {
    const w = [60, 40, 50, 30, 70, 50];
    const greedy = breakLines(w, 10, 200, false);
    expect(greedy).toEqual([0, 3]); // 60+40+50 + 2 gaps = 170; adding the 4th word (30 + gap) would be 210 > 200
  });

  it('balanced lines are closer in width than greedy ones', () => {
    const w = [50, 50, 50, 50, 50, 50];
    const greedy = breakLines(w, 10, 190, false);
    const balanced = breakLines(w, 10, 190, true);
    expect(greedy).toEqual([0, 3]);
    expect(balanced).toEqual([0, 3]);
    const w2 = [40, 40, 40, 40, 40, 40, 40];
    const g2 = breakLines(w2, 10, 200, false); // 4 + 3
    const b2 = breakLines(w2, 10, 200, true);
    expect(g2).toEqual([0, 4]);
    expect(b2.length).toBe(2);
    const widthOf = (s: number[], k: number) => {
      const a = s[k];
      const b = k + 1 < s.length ? s[k + 1] : w2.length;
      return (b - a) * 40 + (b - a - 1) * 10;
    };
    expect(Math.abs(widthOf(b2, 0) - widthOf(b2, 1))).toBeLessThanOrEqual(Math.abs(widthOf(g2, 0) - widthOf(g2, 1)));
  });

  it('a word wider than the line gets its own line', () => {
    expect(breakLines([30, 500, 30], 10, 100, false)).toEqual([0, 1, 2]);
  });
});

describe('layout', () => {
  const opts = { space: 10, maxW: 200, maxLines: 2, lineH: 50, align: 'center' as const, balanced: true };

  it('centres lines inside the block and stacks them by line height', () => {
    const l = layoutWords([80, 60, 100], opts);
    expect(l.scale).toBe(1);
    expect(l.lines).toHaveLength(2);
    expect(l.h).toBe(100);
    expect(l.lines[0].y).toBe(25);
    expect(l.lines[1].y).toBe(75);
    for (const line of l.lines) expect(line.x + line.w / 2).toBeCloseTo(l.w / 2, 6);
    expect(l.words.every((w) => w.x >= 0 && w.x + w.w <= l.w + 1e-6)).toBe(true);
  });

  it('left and right alignment', () => {
    const left = layoutWords([80, 60, 100], { ...opts, align: 'left' });
    expect(left.lines.every((x) => x.x === 0)).toBe(true);
    const right = layoutWords([80, 60, 100], { ...opts, align: 'right' });
    expect(right.lines.every((x) => Math.abs(x.x + x.w - right.w) < 1e-6)).toBe(true);
  });

  it('shrinks the block when it needs more lines than allowed, never below the minimum', () => {
    const w = [90, 90, 90, 90]; // 390 wide in one line: needs scale 0.51
    const l = layoutWords(w, { ...opts, maxLines: 1 });
    expect(l.lines).toHaveLength(1);
    expect(l.scale).toBeGreaterThan(0.45);
    expect(l.scale).toBeLessThan(0.52);
    expect(l.w).toBeLessThanOrEqual(200 + 1e-6);
    const wide = layoutWords([400], { ...opts, maxLines: 1 });
    expect(wide.w).toBeLessThanOrEqual(200 + 1e-6);
    expect(wide.scale).toBeCloseTo(0.5, 2);
    const floor = layoutWords([9000], { ...opts, maxLines: 1 });
    expect(floor.scale).toBe(0.4); // gives up shrinking at the floor
  });

  it('keeps the cue\'s own line breaks when they fit', () => {
    const l = layoutWords([40, 40, 40, 40], { ...opts, keepBreaks: [0, 1] });
    expect(l.lines.map((x) => [x.first, x.last])).toEqual([[0, 0], [1, 3]]);
    const tooMany = layoutWords([40, 40, 40, 40], { ...opts, keepBreaks: [0, 1, 2, 3] });
    expect(tooMany.lines.length).toBeLessThanOrEqual(2);
  });
});

describe('position and safe areas', () => {
  it('portrait frames get the platform margins, landscape ones do not', () => {
    const tt = safeRect(1080, 1920, 'tiktok', 0);
    expect(tt.b).toBeCloseTo(1920 * 0.78, 6);
    expect(tt.t).toBeCloseTo(1920 * 0.07, 6);
    expect(tt.r).toBeLessThan(1080 * 0.9);
    const land = safeRect(1920, 1080, 'tiktok', 0);
    expect(land).toEqual({ l: 0, t: 0, r: 1920, b: 1080 });
    expect(safeRect(1080, 1920, 'none', 20)).toEqual({ l: 20, t: 20, r: 1060, b: 1900 });
  });

  it('places blocks', () => {
    const area = { l: 0, t: 100, r: 1000, b: 900 };
    const free = { x: 0.5, y: 0.5, width: 1000, height: 1000 };
    expect(placeBlock(200, 100, area, 'bottom', free)).toEqual({ x: 400, y: 800 });
    expect(placeBlock(200, 100, area, 'top', free)).toEqual({ x: 400, y: 100 });
    expect(placeBlock(200, 100, area, 'center', free)).toEqual({ x: 400, y: 450 });
    const lower = placeBlock(200, 100, area, 'lower', free);
    expect(lower.y).toBeGreaterThan(450);
    expect(lower.y + 100).toBeLessThanOrEqual(900);
    expect(placeBlock(200, 100, area, 'free', { x: 0.25, y: 0.75, width: 1000, height: 1000 })).toEqual({ x: 150, y: 700 });
  });
});

describe('animation', () => {
  const kinds: AnimKind[] = ['fade', 'pop', 'slide', 'bounce', 'blur', 'wipe', 'shake', 'wave', 'jitter', 'flicker'];
  const o = { ease: 'out' as const, dir: 'up' as const, t: 0.3, seed: 3, out: false };

  it('is the identity when finished and invisible when it has not started', () => {
    for (const k of kinds) {
      expect(animate(k, 1, o), k).toEqual({ alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, wipe: 1, wave: 0 });
      const s = animate(k, 0, o);
      expect(s.alpha === 0 || s.wipe === 0, k).toBe(true);
    }
    expect(animate('none', 0, o).alpha).toBe(1);
  });

  it('is deterministic: the same time gives the same state', () => {
    for (const k of kinds) expect(animate(k, 0.4, o)).toEqual(animate(k, 0.4, { ...o }));
    expect(animate('jitter', 0.4, { ...o, t: 0.31 })).not.toEqual(animate('jitter', 0.4, { ...o, t: 0.6 }));
  });

  it('pop overshoots, slide moves from the chosen side', () => {
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => animate('pop', i / 50, o).scale));
    expect(peak).toBeGreaterThan(1.02);
    expect(animate('slide', 0.2, { ...o, dir: 'up' }).dy).toBeGreaterThan(0);
    expect(animate('slide', 0.2, { ...o, dir: 'down' }).dy).toBeLessThan(0);
    expect(animate('slide', 0.2, { ...o, dir: 'left' }).dx).toBeGreaterThan(0);
    expect(animate('slide', 0.2, { ...o, dir: 'up', out: true }).dy).toBeLessThan(0);
  });

  it('easings start at 0 and end at 1', () => {
    for (const e of ['linear', 'smooth', 'out', 'back', 'bounce', 'elastic'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0, 6);
      expect(ease(e, 1)).toBeCloseTo(1, 6);
    }
  });

  it('transition progress: in and out stay inside the unit and stagger delays later words', () => {
    expect(transitionProgress(0, 0, 4, 0.5, 0.5, 0, 1, 0)).toEqual({ pIn: 0, pOut: 1 });
    expect(transitionProgress(2, 0, 4, 0.5, 0.5, 0, 1, 0)).toEqual({ pIn: 1, pOut: 1 });
    expect(transitionProgress(4, 0, 4, 0.5, 0.5, 0, 1, 0).pOut).toBe(0);
    const a = transitionProgress(0.3, 0, 4, 0.5, 0.5, 0, 3, 0.2);
    const c = transitionProgress(0.3, 0, 4, 0.5, 0.5, 2, 3, 0.2);
    expect(c.pIn).toBeLessThan(a.pIn);
    // a very short unit squeezes the transitions, so it is never "in" and "out" at once beyond the middle
    const short = transitionProgress(0.05, 0, 0.1, 0.5, 0.5, 0, 1, 0);
    expect(short.pIn).toBeGreaterThan(0.5);
    expect(short.pOut).toBeGreaterThan(0.5);
  });
});
