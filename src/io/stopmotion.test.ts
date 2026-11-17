import { describe, expect, it } from 'vitest';
import {
  FrameTransfer,
  MAX_FRAMES,
  addFrame,
  deleteFrame,
  duplicateFrame,
  emptyStrip,
  frameAtTime,
  frameName,
  moveFrame,
  nextTakeName,
  normalizePlan,
  onionFrames,
  onionWeights,
  runtime,
  setHold,
  setShootOn,
  timelapseDue,
  timelineIds,
} from './stopmotion';

const strip3 = () => {
  let s = emptyStrip();
  for (const id of ['a', 'b', 'c']) s = addFrame(s, id);
  return s;
};

describe('filmstrip model', () => {
  it('adds at the end or after a frame, deletes, moves, duplicates', () => {
    let s = strip3();
    s = addFrame(s, 'x', 'a');
    expect(s.frames.map((f) => f.id)).toEqual(['a', 'x', 'b', 'c']);
    s = deleteFrame(s, 'x');
    s = moveFrame(s, 0, 2);
    expect(s.frames.map((f) => f.id)).toEqual(['b', 'c', 'a']);
    s = moveFrame(s, 2, -5);
    expect(s.frames.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(moveFrame(s, 9, 0)).toBe(s);
    s = duplicateFrame(s, 'b', 'b2');
    expect(s.frames.map((f) => f.id)).toEqual(['a', 'b', 'b2', 'c']);
    expect(duplicateFrame(s, 'nope', 'z')).toBe(s);
  });
  it('is immutable', () => {
    const s = strip3();
    addFrame(s, 'q');
    deleteFrame(s, 'a');
    expect(s.frames).toHaveLength(3);
  });
  it('caps the take', () => {
    let s = emptyStrip();
    for (let i = 0; i < MAX_FRAMES; i++) s = addFrame(s, `f${i}`);
    expect(() => addFrame(s, 'more')).toThrow(/at most/);
  });
});

describe('exposure timing (ones, twos, threes, holds)', () => {
  it('on twos doubles every drawing; a hold overrides it for one drawing', () => {
    let s = setShootOn(strip3(), 2);
    expect(timelineIds(s)).toEqual(['a', 'a', 'b', 'b', 'c', 'c']);
    s = setHold(s, 'b', 5);
    expect(timelineIds(s)).toEqual(['a', 'a', 'b', 'b', 'b', 'b', 'b', 'c', 'c']);
    s = setHold(s, 'b', null);
    expect(runtime(s, 12)).toEqual({ frames: 6, seconds: 0.5 });
    expect(setShootOn(s, 9).shootOn).toBe(3);
    expect(setShootOn(s, 0).shootOn).toBe(1);
  });
  it('a duplicate keeps the hold', () => {
    const s = duplicateFrame(setHold(strip3(), 'a', 3), 'a', 'a2');
    expect(s.frames[1].hold).toBe(3);
  });
  it('playback picks the right drawing and loops', () => {
    const s = setShootOn(strip3(), 2); // 6 timeline frames at 12 fps
    expect(frameAtTime(s, 12, 0)).toBe(0);
    expect(frameAtTime(s, 12, 1 / 12)).toBe(0);
    expect(frameAtTime(s, 12, 2 / 12)).toBe(1);
    expect(frameAtTime(s, 12, 5 / 12)).toBe(2);
    expect(frameAtTime(s, 12, 6 / 12)).toBe(0); // looped
    expect(frameAtTime(s, 12, 99, false)).toBe(2);
    expect(frameAtTime(emptyStrip(), 12, 1)).toBe(-1);
  });
});

describe('onion skin', () => {
  it('weights fade from the opacity and stay in range', () => {
    expect(onionWeights(1, 0.5)).toEqual([0.5]);
    expect(onionWeights(3, 0.6).map((w) => Math.round(w * 100) / 100)).toEqual([0.6, 0.4, 0.2]);
    expect(onionWeights(0, 1)).toEqual([]);
    expect(onionWeights(9, 2)).toHaveLength(3);
    expect(Math.max(...onionWeights(3, 2))).toBe(1);
    expect(onionWeights(2, -1)).toEqual([0, 0]);
  });
  it('picks the frames before the current position, nearest first', () => {
    expect(onionFrames(10, 10, 3)).toEqual([9, 8, 7]);
    expect(onionFrames(10, 1, 3)).toEqual([0]);
    expect(onionFrames(0, 0, 3)).toEqual([]);
  });
});

describe('names', () => {
  it('are padded, sortable and safe', () => {
    expect(frameName('take', 1)).toBe('take_0001');
    expect(frameName('my take/../x', 12)).toBe('my_take_x_0012');
    expect(frameName('', 3)).toBe('take_0003');
    expect(frameName('t', 123456)).toBe('t_123456');
    expect(nextTakeName(['Stop-motion 1', 'Stop-motion 3'])).toBe('Stop-motion 2');
    expect(nextTakeName([])).toBe('Stop-motion 1');
  });
});

describe('timelapse', () => {
  it('shoots on a fixed grid and stops after the maximum', () => {
    const plan = { interval: 2, maxShots: 3 };
    expect(timelapseDue(plan, 1000, 0, 1000)).toMatchObject({ due: true, done: false });
    expect(timelapseDue(plan, 1000, 1, 2500)).toMatchObject({ due: false, nextInMs: 500 });
    expect(timelapseDue(plan, 1000, 1, 3000).due).toBe(true);
    expect(timelapseDue(plan, 1000, 3, 99999)).toMatchObject({ due: false, done: true });
    expect(timelapseDue({ interval: 1, maxShots: 0 }, 0, 100000, 1e9).done).toBe(false);
  });
  it('limits the interval', () => {
    expect(normalizePlan({ interval: 0, maxShots: -3 })).toEqual({ interval: 0.5, maxShots: 0 });
    expect(normalizePlan({ interval: 1e9, maxShots: 5 }).interval).toBe(3600);
    expect(normalizePlan({ interval: NaN, maxShots: 5 }).interval).toBe(5);
  });
});

describe('chunked still transfer (simulated phone)', () => {
  const picture = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
  const chunks = (size: number) => Array.from({ length: Math.ceil(picture.length / size) }, (_, i) => picture.subarray(i * size, (i + 1) * size));

  it('assembles chunks that arrive out of order and twice, acknowledging each', () => {
    const parts = chunks(300);
    const t = new FrameTransfer('shot1', parts.length, picture.length);
    const order = [2, 0, 0, 3, 1];
    const acks = order.map((i) => t.accept(i, parts[i]));
    expect(acks).toEqual(order);
    expect(t.status).toBe('complete');
    expect(Array.from(t.result()!)).toEqual(Array.from(picture));
    expect(t.progress).toBe(1);
  });
  it('reports what is missing and hands out nothing until complete', () => {
    const parts = chunks(300);
    const t = new FrameTransfer('s', parts.length, picture.length);
    t.accept(0, parts[0]);
    t.accept(2, parts[2]);
    expect(t.missing()).toEqual([1, 3]);
    expect(t.result()).toBeNull();
    expect(t.progress).toBe(0.5);
  });
  it('refuses bad indexes, too much data, wrong sizes and absurd announcements', () => {
    const parts = chunks(300);
    const t = new FrameTransfer('s', parts.length, picture.length);
    expect(t.accept(-1, parts[0])).toBeNull();
    expect(t.accept(99, parts[0])).toBeNull();
    expect(t.accept(1.5, parts[0])).toBeNull();
    const big = new FrameTransfer('s', 2, 100);
    expect(big.accept(0, new Uint8Array(200))).toBeNull();
    expect(big.status).toBe('failed');
    const short = new FrameTransfer('s', 2, 100);
    short.accept(0, new Uint8Array(40));
    short.accept(1, new Uint8Array(40));
    expect(short.status).toBe('failed');
    expect(short.error).toMatch(/80 bytes instead of 100/);
    expect(new FrameTransfer('s', 0, 10).status).toBe('failed');
    expect(new FrameTransfer('s', 1, 10 ** 12).status).toBe('failed');
    expect(new FrameTransfer('s', 1, 10 ** 12).accept(0, new Uint8Array(1))).toBeNull();
  });
});
