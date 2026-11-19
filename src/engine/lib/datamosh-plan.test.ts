import { describe, expect, it } from 'vitest';
import {
  CUT_GRID,
  cutScore,
  cutThreshold,
  decodePlan,
  detectCuts,
  encodeSteps,
  frameSignature,
  isRefreshFrame,
  isRemovedFrame,
  moshBitrate,
  moshSize,
  parsePositions,
  resolveShown,
  type MoshChunk,
  type MoshSettings,
  type MoshStep,
} from './datamosh-plan';

const base: MoshSettings = { mode: 'keys', removeAt: 'cuts', positions: [], refreshEvery: 0, bloomWhere: 'frame', bloomAt: 0, bloomCount: 0 };
const S = (over: Partial<MoshSettings> = {}): MoshSettings => ({ ...base, ...over });

/** All steps of a project, with an encoder that does exactly what it is asked. */
function project(frames: number, cuts: number[], s: MoshSettings) {
  const steps: MoshStep[] = [];
  for (let f = 0; f < frames; f++) steps.push(...encodeSteps(f, cuts.includes(f), s));
  const chunks: MoshChunk[] = steps.map((st) => ({ key: st.key }));
  return { steps, chunks, plan: decodePlan(steps, chunks, s) };
}

/** The invariants every plan must keep, whatever the settings. */
function check(frames: number, steps: MoshStep[], chunks: MoshChunk[], plan: ReturnType<typeof decodePlan>) {
  expect(plan.show.length).toBe(frames);
  expect(chunks[plan.feed[0]]?.key).toBe(true); // never a delta before the first key frame
  for (const i of plan.feed) {
    expect(steps[i].drop).toBe(false); // a removed key frame is never fed
    expect(chunks[i]).not.toBeNull();
  }
  for (const i of plan.show) {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(plan.feed.length);
  }
  for (let f = 1; f < frames; f++) expect(plan.show[f]).toBeGreaterThanOrEqual(plan.show[f - 1]); // time never runs backwards
}

describe('datamosh plan: what is asked of the encoder', () => {
  it('only the first frame is a key frame when nothing is removed and nothing refreshes', () => {
    const { steps } = project(10, [], S());
    expect(steps.length).toBe(10);
    expect(steps.map((s) => s.key)).toEqual([true, false, false, false, false, false, false, false, false, false]);
    expect(steps.every((s) => !s.drop)).toBe(true);
    expect(steps.map((s) => s.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('at a cut: a key frame that will be dropped, then a delta of the same frame', () => {
    expect(encodeSteps(5, true, S())).toEqual([
      { frame: 5, key: true, drop: true },
      { frame: 5, key: false, drop: false },
    ]);
    expect(encodeSteps(5, false, S())).toEqual([{ frame: 5, key: false, drop: false }]);
  });

  it('"Key frame every" makes kept key frames, and a kept key frame wins over a removal on the same frame', () => {
    const s = S({ refreshEvery: 4 });
    expect(isRefreshFrame(0, s)).toBe(true);
    expect(isRefreshFrame(4, s)).toBe(true);
    expect(isRefreshFrame(5, s)).toBe(false);
    expect(isRefreshFrame(8, S())).toBe(false);
    expect(encodeSteps(8, true, s)).toEqual([{ frame: 8, key: true, drop: false }]);
    expect(isRemovedFrame(8, true, s)).toBe(false);
  });

  it('the first frame is never removed', () => {
    expect(encodeSteps(0, true, S({ removeAt: 'both', positions: [0] }))).toEqual([{ frame: 0, key: true, drop: false }]);
  });

  it('where key frames are removed follows the choice: cuts, listed frames or both', () => {
    expect(isRemovedFrame(3, true, S({ removeAt: 'cuts', positions: [7] }))).toBe(true);
    expect(isRemovedFrame(7, false, S({ removeAt: 'cuts', positions: [7] }))).toBe(false);
    expect(isRemovedFrame(3, true, S({ removeAt: 'list', positions: [7] }))).toBe(false);
    expect(isRemovedFrame(7, false, S({ removeAt: 'list', positions: [7] }))).toBe(true);
    expect(isRemovedFrame(3, true, S({ removeAt: 'both', positions: [7] }))).toBe(true);
    expect(isRemovedFrame(7, false, S({ removeAt: 'both', positions: [7] }))).toBe(true);
  });

  it('Bloom alone removes no key frame, even at a cut', () => {
    expect(encodeSteps(5, true, S({ mode: 'bloom', bloomCount: 4 }))).toEqual([{ frame: 5, key: false, drop: false }]);
  });
});

describe('datamosh plan: what the decoder is given', () => {
  it('untouched: every chunk once, in order', () => {
    const { steps, chunks, plan } = project(8, [], S());
    check(8, steps, chunks, plan);
    expect(plan.feed).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.show).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.removed).toEqual([]);
  });

  it('key frame removal: the key frame at the cut is left out, the length stays the project length', () => {
    const { steps, chunks, plan } = project(8, [3], S());
    check(8, steps, chunks, plan);
    // steps: 0 1 2 [3 = key of frame 3, dropped] 4 = "nothing moved" of frame 3, 5.. = frames 4..
    expect(steps[3]).toEqual({ frame: 3, key: true, drop: true });
    expect(plan.feed).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
    expect(plan.feed.length).toBe(8);
    expect(plan.removed).toEqual([3]);
    // no key frame is fed after the first: nothing lets the picture snap to the new shot
    expect(plan.feed.slice(1).some((i) => chunks[i]!.key)).toBe(false);
    // the frame of the cut shows the delta made right after the removed key frame
    expect(steps[plan.feed[plan.show[3]]]).toEqual({ frame: 3, key: false, drop: false });
  });

  it('several cuts, listed frames and refreshes together keep every rule', () => {
    const s = S({ removeAt: 'both', positions: [5, 20], refreshEvery: 16 });
    const { steps, chunks, plan } = project(40, [9, 16, 30], s);
    check(40, steps, chunks, plan);
    expect(plan.removed).toEqual([5, 9, 20, 30]); // 16 is a refresh: kept
    const fedKeys = plan.feed.filter((i) => chunks[i]!.key).map((i) => steps[i].frame);
    expect(fedKeys).toEqual([0, 16, 32]);
  });

  it('bloom: the frame is repeated in place of the frames after it and the stream goes on afterwards', () => {
    const s = S({ mode: 'bloom', bloomAt: 3, bloomCount: 4 });
    const { steps, chunks, plan } = project(12, [], s);
    check(12, steps, chunks, plan);
    expect(plan.feed).toEqual([0, 1, 2, 3, 3, 3, 3, 3, 8, 9, 10, 11]);
    expect(plan.bloomStarts).toEqual([3]);
    expect(plan.feed.length).toBe(12);
  });

  it('bloom: zero repeats, or a bloom past the end, change nothing or are cut at the end', () => {
    expect(project(6, [], S({ mode: 'bloom', bloomAt: 2, bloomCount: 0 })).plan.feed).toEqual([0, 1, 2, 3, 4, 5]);
    const long = project(6, [], S({ mode: 'bloom', bloomAt: 4, bloomCount: 50 }));
    check(6, long.steps, long.chunks, long.plan);
    expect(long.plan.feed).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it('bloom never starts on a key frame: it moves to the next delta frame', () => {
    const { plan } = project(8, [], S({ mode: 'bloom', bloomAt: 0, bloomCount: 2 }));
    expect(plan.bloomStarts).toEqual([1]);
    expect(plan.feed).toEqual([0, 1, 1, 1, 4, 5, 6, 7]);
  });

  it('bloom: a kept key frame inside the repeats is still fed and ends the bloom', () => {
    const s = S({ mode: 'bloom', bloomAt: 2, bloomCount: 10, refreshEvery: 5 });
    const { steps, chunks, plan } = project(10, [], s);
    check(10, steps, chunks, plan);
    expect(plan.feed).toEqual([0, 1, 2, 2, 2, 5, 6, 7, 8, 9]);
  });

  it('both: the bloom starts on the first moving frame after every removed key frame', () => {
    const s = S({ mode: 'both', bloomWhere: 'cuts', bloomCount: 3 });
    const { steps, chunks, plan } = project(16, [4, 11], s);
    check(16, steps, chunks, plan);
    expect(plan.removed).toEqual([4, 11]);
    expect(plan.bloomStarts).toEqual([5, 12]);
    // frame 4 -> step 5 ("nothing moved"), frame 5 -> step 6, repeated for frames 6, 7, 8
    expect(plan.feed.slice(0, 10)).toEqual([0, 1, 2, 3, 5, 6, 6, 6, 6, 10]);
    expect(steps[6]).toEqual({ frame: 5, key: false, drop: false });
  });

  it('both with a bloom at one chosen frame does not bloom after cuts', () => {
    const { plan } = project(12, [4], S({ mode: 'both', bloomWhere: 'frame', bloomAt: 8, bloomCount: 2 }));
    expect(plan.bloomStarts).toEqual([8]);
  });

  it('a leaf frame (nothing is predicted from it) is never the one repeated: the bloom starts on the next frame that is not', () => {
    const s = S({ mode: 'bloom', bloomAt: 3, bloomCount: 3 });
    const steps: MoshStep[] = [];
    for (let f = 0; f < 10; f++) steps.push(...encodeSteps(f, false, s));
    const chunks: MoshChunk[] = steps.map((st, i) => ({ key: st.key, leaf: i % 2 === 1 }));
    const plan = decodePlan(steps, chunks, s);
    check(10, steps, chunks, plan);
    expect(plan.bloomStarts).toEqual([4]);
    expect(plan.feed).toEqual([0, 1, 2, 3, 4, 4, 4, 4, 8, 9]);
  });

  it('a key frame the encoder made without being asked is fed (it cannot be removed afterwards) and is not counted as removed', () => {
    const s = S();
    const steps: MoshStep[] = [];
    for (let f = 0; f < 6; f++) steps.push(...encodeSteps(f, false, s));
    const chunks: MoshChunk[] = steps.map((st, i) => ({ key: st.key || i === 3 }));
    const plan = decodePlan(steps, chunks, s);
    check(6, steps, chunks, plan);
    expect(plan.feed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.removed).toEqual([]);
  });

  it('an encoder that ignored the request for a key frame at a cut: nothing was removed there', () => {
    const s = S();
    const steps: MoshStep[] = [];
    for (let f = 0; f < 6; f++) steps.push(...encodeSteps(f, f === 3, s));
    const chunks: MoshChunk[] = steps.map((st) => ({ key: st.key && st.frame === 0 }));
    const plan = decodePlan(steps, chunks, s);
    check(6, steps, chunks, plan);
    expect(plan.removed).toEqual([]);
    expect(plan.feed).toEqual([0, 1, 2, 4, 5, 6]); // the dropped step is still never fed
  });

  it('a frame the encoder skipped shows the picture before it', () => {
    const s = S();
    const steps: MoshStep[] = [];
    for (let f = 0; f < 6; f++) steps.push(...encodeSteps(f, false, s));
    const chunks: MoshChunk[] = steps.map((st, i) => (i === 2 ? null : { key: st.key }));
    const plan = decodePlan(steps, chunks, s);
    check(6, steps, chunks, plan);
    expect(plan.feed).toEqual([0, 1, 3, 4, 5]);
    expect(plan.show).toEqual([0, 1, 1, 2, 3, 4]);
  });

  it('refuses a stream that does not start with a key frame, and an empty project gives an empty plan', () => {
    const steps = [...encodeSteps(0, false, S()), ...encodeSteps(1, false, S())];
    expect(() => decodePlan(steps, [{ key: false }, { key: false }], S())).toThrow(/key frame/);
    expect(() => decodePlan(steps, [null, { key: false }], S())).toThrow(/key frame/);
    expect(decodePlan([], [], S())).toEqual({ feed: [], show: [], removed: [], bloomStarts: [] });
  });

  it('random settings never break the rules', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const frames = 1 + Math.floor(rnd() * 60);
      const s = S({
        mode: (['keys', 'bloom', 'both'] as const)[Math.floor(rnd() * 3)],
        removeAt: (['cuts', 'list', 'both'] as const)[Math.floor(rnd() * 3)],
        positions: [Math.floor(rnd() * frames), Math.floor(rnd() * frames)],
        refreshEvery: rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 12),
        bloomWhere: rnd() < 0.5 ? 'frame' : 'cuts',
        bloomAt: Math.floor(rnd() * frames),
        bloomCount: Math.floor(rnd() * 20),
      });
      const cuts = [Math.floor(rnd() * frames), Math.floor(rnd() * frames), Math.floor(rnd() * frames)];
      const { steps, chunks, plan } = project(frames, cuts, s);
      check(frames, steps, chunks, plan);
      expect(plan.feed.length).toBe(frames); // a well-behaved encoder: exactly one fed chunk per project frame
      // every kept key frame is fed
      steps.forEach((st, i) => {
        if (st.key && !st.drop) expect(plan.feed.includes(i)).toBe(true);
      });
    }
  });
});

describe('datamosh plan: which decoded picture a frame shows', () => {
  it('every picture there: as planned', () => {
    expect(resolveShown([0, 1, 2, 3], [true, true, true, true])).toEqual([0, 1, 2, 3]);
  });
  it('a missing picture shows the one before it; a missing first one shows the first that exists', () => {
    expect(resolveShown([0, 1, 2, 3], [true, false, false, true])).toEqual([0, 0, 0, 3]);
    expect(resolveShown([0, 1, 2], [false, true, true])).toEqual([1, 1, 2]);
  });
  it('no picture at all: null', () => {
    expect(resolveShown([0, 1], [false, false])).toBeNull();
    expect(resolveShown([], [])).toBeNull();
  });
});

describe('datamosh plan: listed frames', () => {
  it('reads numbers separated by commas, spaces or anything else, sorted and without repeats', () => {
    expect(parsePositions('12, 48 96;12', 200)).toEqual([12, 48, 96]);
    expect(parsePositions('', 200)).toEqual([]);
    expect(parsePositions('abc', 200)).toEqual([]);
  });
  it('the transport counts from 1: base 1 turns "25" into frame 24', () => {
    expect(parsePositions('1, 25', 100, 1)).toEqual([0, 24]);
  });
  it('wraps into the project', () => {
    expect(parsePositions('130, -1', 120)).toEqual([10, 119]);
    expect(parsePositions('5', 0)).toEqual([]);
  });
});

describe('cut detection', () => {
  const flat = (w: number, h: number, r: number, g: number, b: number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
    return px;
  };
  /** A grey picture with a brighter square at `x`. */
  const square = (w: number, h: number, x: number) => {
    const px = flat(w, h, 60, 60, 60);
    for (let y = 10; y < 26; y++) for (let xx = x; xx < x + 16; xx++) px.fill(220, (y * w + xx) * 4, (y * w + xx) * 4 + 3);
    return px;
  };

  it('a signature is a small brightness picture, the same for any picture size', () => {
    const a = frameSignature(flat(64, 36, 255, 255, 255), 64, 36);
    expect(a.length).toBe(CUT_GRID * CUT_GRID);
    expect([...a].every((v) => v === 255)).toBe(true);
    expect([...frameSignature(flat(7, 5, 0, 0, 0), 7, 5)].every((v) => v === 0)).toBe(true);
    expect(frameSignature(new Uint8ClampedArray(0), 0, 0).length).toBe(CUT_GRID * CUT_GRID);
    // the same picture at two sizes gives about the same signature
    const big = frameSignature(square(128, 72, 40), 128, 72);
    const half = new Uint8ClampedArray(64 * 36 * 4);
    const src = square(128, 72, 40);
    for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) for (let c = 0; c < 4; c++) half[(y * 64 + x) * 4 + c] = src[(y * 2 * 128 + x * 2) * 4 + c];
    expect(cutScore(big, frameSignature(half, 64, 36))).toBeLessThan(0.02);
  });

  it('the score is 0 for the same picture, 1 for black against white, small for motion, large for another shot', () => {
    const black = frameSignature(flat(32, 32, 0, 0, 0), 32, 32);
    const white = frameSignature(flat(32, 32, 255, 255, 255), 32, 32);
    expect(cutScore(black, black)).toBe(0);
    expect(cutScore(black, white)).toBe(1);
    const move = cutScore(frameSignature(square(96, 48, 20), 96, 48), frameSignature(square(96, 48, 26), 96, 48));
    const shot = cutScore(frameSignature(square(96, 48, 20), 96, 48), frameSignature(flat(96, 48, 200, 180, 40), 96, 48));
    expect(move).toBeLessThan(cutThreshold(0.5));
    expect(shot).toBeGreaterThan(cutThreshold(0.5));
    expect(cutScore([], [])).toBe(0);
  });

  it('sensitivity lowers the threshold, and stays in range for nonsense', () => {
    expect(cutThreshold(0)).toBeCloseTo(0.32, 5);
    expect(cutThreshold(1)).toBeCloseTo(0.02, 5);
    expect(cutThreshold(0.5)).toBeGreaterThan(cutThreshold(0.8));
    expect(cutThreshold(Number.NaN)).toBe(cutThreshold(0.5));
    expect(cutThreshold(9)).toBe(cutThreshold(1));
  });

  it('finds the frames that start a shot, never frame 0 and never two in a row', () => {
    const scores = [0.9, 0.01, 0.02, 0.4, 0.5, 0.01, 0.01, 0.3, 0.02];
    expect(detectCuts(scores, 0.5)).toEqual([3, 7]);
    expect(detectCuts([0, 0.01, 0.02], 0.5)).toEqual([]);
    expect(detectCuts(scores, 0)).toEqual([3]); // only the hardest
    expect(detectCuts([], 0.5)).toEqual([]);
  });
});

describe('codec settings', () => {
  it('more compression = fewer bits, in even steps, never below a floor', () => {
    const a = moshBitrate(1280, 720, 30, 0);
    const b = moshBitrate(1280, 720, 30, 0.5);
    const c = moshBitrate(1280, 720, 30, 1);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(a / b).toBeCloseTo(b / c, 1);
    expect(a).toBe(Math.round(1280 * 720 * 30 * 0.3));
    expect(moshBitrate(16, 16, 1, 1)).toBe(20000);
    expect(moshBitrate(1280, 720, 30, Number.NaN)).toBe(b);
  });

  it('the encoded size is capped on the longer side and even', () => {
    expect(moshSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(moshSize(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 });
    expect(moshSize(641, 361, 1280)).toEqual({ width: 640, height: 360 });
    expect(moshSize(640, 360, 0)).toEqual({ width: 640, height: 360 });
    expect(moshSize(4, 4, 1280)).toEqual({ width: 16, height: 16 });
  });
});
