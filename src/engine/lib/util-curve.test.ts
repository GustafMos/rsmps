import { describe, expect, it } from 'vitest';
import type { CurveValue } from '../types';
import {
  CURVE_PRESETS,
  addKey,
  animateToCurve,
  autoTangents,
  curveBounds,
  evalCurve,
  evalCurveSlope,
  fitToRange,
  moveKey,
  normalizeCurve,
  presetBounce,
  presetEaseIn,
  presetEaseInOut,
  presetEaseOut,
  presetPulse,
  presetSteps,
  removeKey,
  reverse,
  sampleCurve,
  scaleTime,
  setHandles,
  setInterp,
  shiftTime,
} from './util-curve';
import { ease } from './util-ease';
import { waveValue } from './util-wave';

const smoothKeys = (): CurveValue => ({
  keys: [
    { t: 0, v: 0, interp: 'smooth' },
    { t: 0.5, v: 1, interp: 'smooth' },
    { t: 0.8, v: 0.3, interp: 'smooth' },
  ],
});

describe('evalCurve', () => {
  it('linear interpolates and holds the ends', () => {
    const c: CurveValue = { keys: [{ t: 0.2, v: 0, interp: 'linear' }, { t: 0.8, v: 10, interp: 'linear' }] };
    expect(evalCurve(c, 0.5)).toBeCloseTo(5, 9);
    expect(evalCurve(c, 0)).toBe(0);
    expect(evalCurve(c, 1)).toBe(10);
    expect(evalCurve({ keys: [] }, 0.3)).toBe(0);
    expect(evalCurve({ keys: [{ t: 0.5, v: 7, interp: 'smooth' }] }, 0.9)).toBe(7);
  });

  it('hold makes steps', () => {
    const c: CurveValue = { keys: [{ t: 0, v: 1, interp: 'hold' }, { t: 0.5, v: 3, interp: 'hold' }, { t: 1, v: 5, interp: 'hold' }] };
    expect(evalCurve(c, 0.49)).toBe(1);
    expect(evalCurve(c, 0.5)).toBe(3);
    expect(evalCurve(c, 0.99)).toBe(3);
    expect(evalCurve(c, 1)).toBe(5);
  });

  it('smooth passes through the keys; monotone never overshoots, catmull-rom does', () => {
    const c = smoothKeys();
    expect(evalCurve(c, 0.5)).toBeCloseTo(1, 9);
    expect(evalCurve(c, 0.8)).toBeCloseTo(0.3, 9);
    const plateau: CurveValue = {
      keys: [
        { t: 0, v: 0, interp: 'smooth' },
        { t: 0.3, v: 1, interp: 'smooth' },
        { t: 0.7, v: 1, interp: 'smooth' },
        { t: 1, v: 0, interp: 'smooth' },
      ],
    };
    const max = (monotone: boolean) => Math.max(...sampleCurve(plateau, 400, { monotone }).map(([, v]) => v));
    expect(max(true)).toBeLessThanOrEqual(1 + 1e-9);
    expect(max(false)).toBeGreaterThan(1.01);
    const lo = Math.min(...sampleCurve(plateau, 400).map(([, v]) => v));
    expect(lo).toBeGreaterThanOrEqual(-1e-9);
  });

  it('bezier handles shape the segment', () => {
    expect(evalCurve(presetEaseIn(), 0.25)).toBeLessThan(0.1);
    expect(evalCurve(presetEaseOut(), 0.25)).toBeGreaterThan(0.35);
    const inOut = presetEaseInOut();
    expect(evalCurve(inOut, 0.5)).toBeCloseTo(0.5, 6);
    expect(evalCurve(inOut, 0.1)).toBeLessThan(0.1);
    expect(evalCurve(inOut, 0.9)).toBeGreaterThan(0.9);
    // straight handles = a straight line
    const straight: CurveValue = { keys: [{ t: 0, v: 0, interp: 'bezier', out: [1 / 3, 1 / 3] }, { t: 1, v: 1, interp: 'bezier', in: [-1 / 3, -1 / 3] }] };
    expect(evalCurve(straight, 0.3)).toBeCloseTo(0.3, 5);
  });

  it('bezier time never runs backwards, even with absurd handles', () => {
    const wild: CurveValue = { keys: [{ t: 0, v: 0, interp: 'bezier', out: [5, 0.2] }, { t: 1, v: 1, interp: 'bezier', in: [-5, -0.2] }] };
    const vals = sampleCurve(wild, 200).map(([, v]) => v);
    for (const v of vals) expect(Number.isFinite(v)).toBe(true);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - 1e-9);
    const backwards: CurveValue = { keys: [{ t: 0, v: 0, interp: 'bezier', out: [0.9, 0.5] }, { t: 1, v: 1, interp: 'bezier', in: [0.9, -0.5] }] };
    const v2 = sampleCurve(backwards, 200).map(([, v]) => v);
    for (let i = 1; i < v2.length; i++) expect(v2[i]).toBeGreaterThanOrEqual(v2[i - 1] - 1e-9);
  });

  it('looping: value and slope are continuous across the wrap (smooth)', () => {
    const c = smoothKeys();
    const opts = { loop: true };
    expect(evalCurve(c, 0, opts)).toBeCloseTo(0, 9);
    expect(Math.abs(evalCurve(c, 1 - 1e-6, opts) - evalCurve(c, 1e-6, opts))).toBeLessThan(1e-3);
    expect(evalCurve(c, 1.25, opts)).toBeCloseTo(evalCurve(c, 0.25, opts), 9);
    expect(evalCurve(c, -0.75, opts)).toBeCloseTo(evalCurve(c, 0.25, opts), 9);
    const s1 = evalCurveSlope(c, 1 - 2e-3, opts);
    const s2 = evalCurveSlope(c, 2e-3, opts);
    expect(Math.abs(s1 - s2)).toBeLessThan(0.15);
    // without loop the end just holds
    expect(evalCurve(c, 0.95)).toBeCloseTo(0.3, 9);
    expect(evalCurve(c, 0.95, opts)).not.toBeCloseTo(0.3, 3);
  });

  it('looping: bezier with automatic tangents matches slopes at the wrap', () => {
    const c = autoTangents(smoothKeys(), { loop: true });
    const opts = { loop: true };
    const s1 = evalCurveSlope(c, 1 - 1e-4, opts);
    const s2 = evalCurveSlope(c, 1e-4, opts);
    expect(Math.abs(s1 - s2)).toBeLessThan(0.05);
    const asBez = { keys: c.keys.map((k) => ({ ...k, interp: 'bezier' as const })) };
    const b1 = evalCurveSlope(asBez, 1 - 1e-3, opts);
    const b2 = evalCurveSlope(asBez, 1e-3, opts);
    expect(Math.abs(b1 - b2)).toBeLessThan(0.15);
    expect(Math.abs(evalCurve(asBez, 1 - 1e-6, opts) - evalCurve(asBez, 1e-6, opts))).toBeLessThan(1e-3);
  });
});

describe('editing helpers', () => {
  it('normalizeCurve sorts, dedupes, clamps and repairs', () => {
    const n = normalizeCurve({
      keys: [
        { t: 1.5, v: 2, interp: 'linear' },
        { t: 0.5, v: 1, interp: 'bogus' as never },
        { t: 0.5, v: 9, interp: 'hold' },
        { t: -1, v: NaN, interp: 'linear', out: [NaN, 1] },
      ],
    });
    expect(n.keys.map((k) => k.t)).toEqual([0, 0.5, 1]);
    expect(n.keys[0].v).toBe(0);
    expect(n.keys[0].out).toBeUndefined();
    expect(n.keys[1]).toMatchObject({ v: 9, interp: 'hold' });
    expect(normalizeCurve({ keys: [] }).keys).toHaveLength(1);
  });

  it('addKey / removeKey / moveKey keep order and bounds', () => {
    const c = presetEaseInOut();
    const { curve, index } = addKey(c, 0.5);
    expect(curve.keys.map((k) => k.t)).toEqual([0, 0.5, 1]);
    expect(index).toBe(1);
    expect(curve.keys[1].v).toBeCloseTo(0.5, 6);
    expect(c.keys).toHaveLength(2); // input untouched
    const moved = moveKey(curve, 1, 5, 0.9);
    expect(moved.keys[1].t).toBeLessThan(1);
    expect(moved.keys[1].t).toBeGreaterThan(0.99);
    expect(moved.keys[1].v).toBe(0.9);
    expect(moveKey(curve, 1, -3).keys[1].t).toBeGreaterThan(0);
    expect(moveKey(curve, 0, -3).keys[0].t).toBe(0);
    expect(removeKey(curve, 1).keys).toHaveLength(2);
    expect(removeKey({ keys: [{ t: 0, v: 1, interp: 'smooth' }] }, 0).keys).toHaveLength(1);
    expect(addKey(curve, 0.5, 4).curve.keys).toHaveLength(3); // same place: replaced, not duplicated
  });

  it('setInterp and setHandles', () => {
    const c = setInterp(smoothKeys(), 1, 'hold');
    expect(c.keys[1].interp).toBe('hold');
    const h = setHandles(c, 1, { out: [0.1, 0.2], in: [-0.1, 0] });
    expect(h.keys[1].out).toEqual([0.1, 0.2]);
    expect(setHandles(h, 1, { out: null }).keys[1].out).toBeUndefined();
    expect(h.keys[0].out).toBeUndefined();
  });

  it('autoTangents writes handles on every key', () => {
    const c = autoTangents(smoothKeys());
    expect(c.keys[0].in).toBeUndefined();
    expect(c.keys[0].out).toBeDefined();
    expect(c.keys[1].in).toBeDefined();
    expect(c.keys[2].out).toBeUndefined();
    expect(autoTangents(smoothKeys(), { loop: true }).keys[2].out).toBeDefined();
  });

  it('reverse, scaleTime, shiftTime, fitToRange', () => {
    const c = smoothKeys();
    const r = reverse(c);
    for (const t of [0.1, 0.3, 0.6, 0.9]) expect(evalCurve(r, t)).toBeCloseTo(evalCurve(c, 1 - t), 6);
    const lin: CurveValue = { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 0.5, v: 1, interp: 'linear' }, { t: 1, v: 3, interp: 'linear' }] };
    const rl = reverse(lin);
    expect(evalCurve(rl, 0.25)).toBeCloseTo(evalCurve(lin, 0.75), 6);
    const half = scaleTime(c, 0.5);
    expect(evalCurve(half, 0.25)).toBeCloseTo(evalCurve(c, 0.5), 9);
    expect(scaleTime(c, 2).keys.every((k) => k.t <= 1)).toBe(true);
    const shifted = shiftTime(c, 0.25);
    for (const t of [0.1, 0.4, 0.7]) expect(evalCurve(shifted, t, { loop: true })).toBeCloseTo(evalCurve(c, t - 0.25, { loop: true }), 6);
    const fit = fitToRange(c, 10, 20);
    const b = curveBounds(fit);
    expect(b.vMin).toBeCloseTo(10, 6);
    expect(b.vMax).toBeCloseTo(20, 6);
    expect(fitToRange({ keys: [{ t: 0, v: 5, interp: 'linear' }] }, 1, 2).keys[0].v).toBe(1);
  });

  it('sampleCurve and curveBounds', () => {
    const s = sampleCurve(presetEaseInOut(), 11);
    expect(s).toHaveLength(11);
    expect(s[0]).toEqual([0, 0]);
    expect(s[10][0]).toBe(1);
    expect(s[10][1]).toBeCloseTo(1, 9);
    const b = curveBounds(smoothKeys());
    expect(b.vMax).toBeCloseTo(1, 6);
    expect(b.vMin).toBeCloseTo(0, 6);
  });
});

describe('presets and animate conversion', () => {
  it('presets behave', () => {
    const bounce = presetBounce();
    expect(evalCurve(bounce, 0)).toBe(0);
    expect(evalCurve(bounce, 1)).toBeCloseTo(1, 6);
    expect(Math.abs(evalCurve(bounce, 0.5) - ease('bounce', 0.5))).toBeLessThan(0.03);
    const steps = presetSteps(4);
    expect(evalCurve(steps, 0.1)).toBe(0);
    expect(evalCurve(steps, 0.3)).toBeCloseTo(1 / 3, 9);
    expect(evalCurve(steps, 0.9)).toBe(1);
    const pulse = presetPulse(0.25);
    expect(evalCurve(pulse, 0.1)).toBe(1);
    expect(evalCurve(pulse, 0.5)).toBe(0);
    for (const p of CURVE_PRESETS) {
      const c = p.make();
      expect(c.keys.length).toBeGreaterThan(1);
      for (const [, v] of sampleCurve(c, 50)) expect(Number.isFinite(v)).toBe(true);
    }
    const over = CURVE_PRESETS.find((p) => p.id === 'overshoot')!.make();
    expect(curveBounds(over).vMax).toBeGreaterThan(1.05);
  });

  it('animateToCurve reproduces the animate node waves', () => {
    const cases = [
      { wave: 'sine', cycles: 1, easing: 'linear' },
      { wave: 'sine', cycles: 3, easing: 'ease-in' },
      { wave: 'triangle', cycles: 2, easing: 'linear' },
      { wave: 'saw-up', cycles: 2, easing: 'linear' },
      { wave: 'square', cycles: 2, easing: 'linear' },
      { wave: 'steps', cycles: 1, easing: 'linear' },
      { wave: 'bounce', cycles: 2, easing: 'linear' },
      { wave: 'sine', cycles: 1, easing: 'linear', phase: 0.3 },
    ];
    for (const c of cases) {
      const s = { from: -2, to: 6, steps: 5, seed: 1, phase: 0, ...c };
      const curve = animateToCurve(s);
      let worst = 0;
      for (let i = 0; i < 97; i++) {
        const t = (i + 0.37) / 97;
        const w = waveValue({ wave: s.wave, t: t * s.cycles + s.phase, steps: s.steps, seed: s.seed, cycles: s.cycles });
        const shaped = s.wave === 'steps' || s.wave === 'square' ? w : ease(s.easing, w);
        const expected = s.from + (s.to - s.from) * shaped;
        const got = evalCurve(curve, t, { loop: true, monotone: false });
        // allow a miss only right next to a jump
        worst = Math.max(worst, Math.abs(got - expected));
      }
      expect(worst, `${c.wave} x${c.cycles}`).toBeLessThan(s.wave === 'square' || s.wave === 'steps' || s.wave === 'saw-up' ? 8.01 : 0.35);
      const typical: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t = (i + 0.5) / 40 + 0.0007;
        const w = waveValue({ wave: s.wave, t: t * s.cycles + s.phase, steps: s.steps, seed: s.seed, cycles: s.cycles });
        const shaped = s.wave === 'steps' || s.wave === 'square' ? w : ease(s.easing, w);
        typical.push(Math.abs(evalCurve(curve, t, { loop: true, monotone: false }) - (s.from + (s.to - s.from) * shaped)));
      }
      typical.sort((a, b) => a - b);
      expect(typical[Math.floor(typical.length * 0.8)], `${c.wave} median error`).toBeLessThan(0.1);
    }
  });
});
