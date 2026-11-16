import { describe, expect, it } from 'vitest';
import { qAxisAngle, qConj, qMul, type Quat } from './motion-math';
import {
  ALL_CHANNELS, bakeSmoothing, buildTake, neutralFrame, rdp, resetToRaw, sampleTake, smoothQuatSeries, smoothSeries, takeDense, takeRawDense, withDerived, type MotionFrame, type RawSample,
} from './motion-take';

const FPS = 30;
function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
}
/** A phone move: yaw sweeping, with optional jitter, sampled at 100 Hz (irregular enough to need resampling). */
function samples(opts: { jitter?: number; yawAt: (t: number) => number; seconds: number; tap?: (t: number) => number }): RawSample[] {
  const r = lcg(7);
  const out: RawSample[] = [];
  for (let t = 0; t <= opts.seconds + 1e-9; t += 0.01) {
    const yaw = opts.yawAt(t) + (opts.jitter ?? 0) * r();
    const q = qAxisAngle('y', yaw); // a turn about scene up is a yaw
    const v: MotionFrame = { ...neutralFrame(), qx: q[0], qy: q[1], qz: q[2], qw: q[3], aqx: q[0], aqy: q[1], aqz: q[2], aqw: q[3], ax: 0.01 * r(), tap: opts.tap?.(t) ?? 0 };
    out.push({ t, v });
  }
  return out;
}
const yawOf = (f: MotionFrame) => f.yaw;
const variance = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length;
};

describe('building a take', () => {
  it('resamples to the project fps and simplifies a straight move to a few keys', () => {
    const take = buildTake(samples({ yawAt: (t) => 40 * t, seconds: 2 }), { fps: FPS })!;
    expect(take.frames).toBe(2 * FPS + 1);
    expect(take.raw.qy.length / 2).toBeLessThan(20);
    expect(ALL_CHANNELS.length).toBeGreaterThan(30);
    const d = takeRawDense(take);
    for (const t of [0, 0.5, 1.37, 2]) expect(Math.abs(yawOf(sampleTake(d, t)) - 2 * 40 * t / 2 * 1)).toBeLessThan(0.3); // yaw = rotation about y by 2*half-angle: 40 t degrees
  });
  it('needs at least two samples', () => {
    expect(buildTake([], { fps: FPS })).toBeNull();
  });
  it('holds the ends outside the take and loops when asked', () => {
    const take = buildTake(samples({ yawAt: (t) => 20 * t, seconds: 1 }), { fps: FPS })!;
    const d = takeRawDense(take);
    expect(sampleTake(d, 5).yaw).toBeCloseTo(sampleTake(d, 1).yaw, 6);
    expect(sampleTake(d, -3).yaw).toBeCloseTo(0, 1);
    for (const t of [0.1, 0.5, 0.9]) expect(sampleTake(d, t + take.frames / FPS, true).yaw).toBeCloseTo(sampleTake(d, t, true).yaw, 6);
  });
  it('a pulse channel keeps its edges (tap)', () => {
    const take = buildTake(samples({ yawAt: () => 0, seconds: 2, tap: (t) => (t > 0.5 && t < 0.7 ? 1 : 0) }), { fps: FPS })!;
    const d = takeRawDense(take);
    expect(sampleTake(d, 0.6).tap).toBe(1);
    expect(sampleTake(d, 0.2).tap).toBe(0);
    expect(sampleTake(d, 1.2).tap).toBe(0);
  });
  it('quaternions stay unit length through simplification and sampling', () => {
    const take = buildTake(samples({ jitter: 2, yawAt: (t) => 90 * Math.sin(t * 3), seconds: 3 }), { fps: FPS })!;
    const d = takeRawDense(take);
    for (let t = 0; t < 3; t += 0.123) {
      const f = sampleTake(d, t);
      expect(Math.hypot(f.qx, f.qy, f.qz, f.qw)).toBeCloseTo(1, 6);
    }
  });
  it('yaw stays continuous when the phone turns past 180 degrees', () => {
    const take = buildTake(samples({ yawAt: (t) => 100 * t, seconds: 3 }), { fps: FPS })!;
    const d = takeRawDense(take);
    let prev = sampleTake(d, 0).yaw;
    for (let i = 1; i <= 3 * FPS; i++) {
      const y = sampleTake(d, i / FPS).yaw;
      expect(Math.abs(y - prev)).toBeLessThan(10);
      prev = y;
    }
    expect(prev).toBeGreaterThan(290);
  });
  it('loop blend makes the end meet the start', () => {
    // a move that does NOT return: yaw 0 -> 30 over 2 s
    const s = samples({ yawAt: (t) => 15 * t, seconds: 2 });
    const plain = buildTake(s, { fps: FPS, loop: true })!;
    const blended = buildTake(s, { fps: FPS, loop: true, loopBlend: 15 })!;
    const seam = (t: typeof plain) => {
      const d = takeRawDense(t);
      return Math.abs(sampleTake(d, (t.frames - 1) / FPS).yaw - sampleTake(d, t.frames / FPS, true).yaw);
    };
    expect(blended.frames).toBe(plain.frames - 15);
    expect(seam(blended)).toBeLessThan(seam(plain) * 0.2);
    expect(seam(blended)).toBeLessThan(0.8);
  });
  it('JSON round trip keeps the take readable', () => {
    const take = buildTake(samples({ yawAt: (t) => 30 * t, seconds: 1 }), { fps: FPS })!;
    const copy = JSON.parse(JSON.stringify(take));
    expect(sampleTake(takeDense(copy), 0.5).yaw).toBeCloseTo(sampleTake(takeDense(take), 0.5).yaw, 6);
  });
});

describe('smoothing a take (zero phase)', () => {
  it('constant input is unchanged', () => {
    const out = smoothSeries(new Float64Array(50).fill(3.25), 5, false);
    for (const v of out) expect(v).toBeCloseTo(3.25, 12);
    const out2 = smoothSeries(new Float64Array(50).fill(3.25), 5, true, 1);
    for (const v of out2) expect(v).toBeCloseTo(3.25, 12);
  });
  it('removes jitter: the variance of the difference to the clean move drops', () => {
    const clean = (t: number) => 20 * Math.sin(t);
    const take = buildTake(samples({ jitter: 4, yawAt: clean, seconds: 4 }), { fps: FPS })!;
    const err = (amount: number) => {
      const d = takeDense(take, { amount });
      const e: number[] = [];
      for (let t = 0.3; t < 3.7; t += 1 / FPS) e.push(sampleTake(d, t).yaw - clean(t));
      return variance(e);
    };
    expect(err(0.3)).toBeLessThan(err(0) * 0.35);
  });
  it('does not shift a peak or a step in time', () => {
    const peak = samples({ yawAt: (t) => 60 * Math.exp(-((t - 2) ** 2) / 0.1), seconds: 4 });
    const take = buildTake(peak, { fps: FPS })!;
    const argmax = (amount: number) => {
      const d = takeDense(take, { amount });
      let best = -1;
      let at = 0;
      for (let i = 0; i < take.frames; i++) {
        const y = d.ch.yaw[i];
        if (y > best) {
          best = y;
          at = i;
        }
      }
      return at;
    };
    expect(Math.abs(argmax(0.4) - argmax(0))).toBeLessThanOrEqual(1);
    // a step: the 50% crossing stays put
    const step = new Float64Array(200).map((_, i) => (i < 100 ? 0 : 1));
    const sm = smoothSeries(step, 6, false);
    let cross = 0;
    while (sm[cross] < 0.5) cross++;
    expect(Math.abs(cross - 100)).toBeLessThanOrEqual(1);
  });
  it('keep fast moves: a deliberate step stays sharper than with plain smoothing, jitter is still reduced', () => {
    const r = lcg(3);
    const x = new Float64Array(200).map((_, i) => (i < 100 ? 0 : 60) + 1.5 * r());
    const plain = smoothSeries(x, 6, false);
    const edge = smoothSeries(x, 6, false, 90 * 0.04);
    const width = (a: Float64Array) => {
      let lo = 0;
      while (a[lo] < 6) lo++;
      let hi = lo;
      while (a[hi] < 54) hi++;
      return hi - lo;
    };
    expect(width(edge)).toBeLessThan(width(plain));
    const flat = (a: Float64Array) => variance(Array.from(a.slice(10, 80)));
    expect(flat(edge)).toBeLessThan(variance(Array.from(x.slice(10, 80))) * 0.5);
  });
  it('a looping take is smoothed circularly: the seam stays continuous', () => {
    const n = 120;
    const r = lcg(11);
    const x = new Float64Array(n).map((_, i) => 30 * Math.sin((i / n) * 2 * Math.PI) + 3 * r());
    const sm = smoothSeries(x, 5, true);
    const jumpAcrossSeam = Math.abs(sm[0] - sm[n - 1]);
    const typical = Math.abs(sm[n / 2 + 1] - sm[n / 2]);
    expect(jumpAcrossSeam).toBeLessThan(typical * 4 + 1);
    // non-loop smoothing of a loop-shaped signal keeps the ends away from each other no more than the loop does
  });
  it('quaternion smoothing stays unit length, reduces jitter, does not lag a turn', () => {
    const r = lcg(5);
    const qs: Quat[] = [];
    for (let i = 0; i < 200; i++) qs.push(qMul(qAxisAngle('y', i * 0.5), qAxisAngle('x', 3 * r())));
    const sm = smoothQuatSeries(qs, 6, false);
    for (const q of sm) expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    const ang = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(qMul(qConj(a), b)[3]))) * (180 / Math.PI);
    const truth = (i: number) => qAxisAngle('y', i * 0.5);
    let before = 0;
    let after = 0;
    for (let i = 20; i < 180; i++) {
      before += ang(qs[i], truth(i)) ** 2;
      after += ang(sm[i], truth(i)) ** 2;
    }
    expect(after).toBeLessThan(before * 0.3);
    // no lag: the smoothed yaw at i is the truth at i (a straight turn is its own mean)
    expect(ang(sm[100], truth(100))).toBeLessThan(0.8);
  });
  it('baking keeps the raw take so it can be reset; smoothing amount 0 equals the raw read', () => {
    const take = buildTake(samples({ jitter: 4, yawAt: (t) => 30 * t, seconds: 3 }), { fps: FPS })!;
    const baked = bakeSmoothing(take, { amount: 0.4 });
    expect(baked.baked).not.toBeNull();
    expect(baked.raw).toBe(take.raw);
    expect(takeDense(baked).ch.yaw[40]).not.toBeCloseTo(takeDense(take).ch.yaw[40], 6);
    const back = resetToRaw(baked);
    expect(takeDense(back).ch.yaw[40]).toBeCloseTo(takeDense(take).ch.yaw[40], 9);
    // read-time smoothing is non-destructive
    expect(takeDense(take, { amount: 0.4 }).ch.yaw[40]).not.toBeCloseTo(takeDense(take).ch.yaw[40], 6);
    expect(takeDense(take, { amount: 0 })).toBe(takeDense(take));
  });
  it('withDerived fills the angle channels of a single frame', () => {
    const q = qAxisAngle('y', 50);
    const f = withDerived({ ...neutralFrame(), qx: q[0], qy: q[1], qz: q[2], qw: q[3] });
    expect(f.yaw).toBeCloseTo(50, 6);
  });
});

describe('rdp', () => {
  it('keeps the corners of a polyline and drops the straight parts', () => {
    const v = [0, 1, 2, 3, 4, 3, 2, 1, 0];
    expect(rdp(v, 0.01)).toEqual([0, 4, 8]);
  });
});
