import { describe, expect, it } from 'vitest';
import {
  checkSdfSize,
  packSdf,
  repeatAxes,
  SDF_MAX_COPIES,
  SDF_MAX_SHAPES,
  sdfBounds,
  sdfCombine,
  sdfCount,
  sdfExact,
  sdfFind,
  sdfJoin,
  sdfMod,
  sdfMove,
  sdfPathTo,
  sdfShape,
  sdfSlotCount,
  sdfStepScale,
  sdfStructure,
  sdfValue,
} from './sdf-scene';
import { sdfSceneFn } from './sdf-render';

const two = (x1 = -0.5, x2 = 0.5, smooth = 0.2) => sdfCombine('scene/c', 'union', [sdfShape('scene/a', 'sphere', { pos: [x1, 0, 0], size: [0.4, 0, 0] }), sdfShape('scene/b', 'box', { pos: [x2, 0, 0], size: [0.3, 0.3, 0.3] })], smooth);

describe('sdf scene: structure signature', () => {
  it('ignores every number', () => {
    const a = sdfStructure(two(-0.5, 0.5, 0.2));
    const b = sdfStructure(two(-2, 3, 0.9));
    expect(a).toBe(b);
    const moved = sdfMove('scene/m', two(), { pos: [4, 5, 6], rot: [10, 20, 30], scale: 2 });
    expect(sdfStructure(moved)).toBe(sdfStructure(sdfMove('scene/m', two(), { pos: [0, 0, 0] })));
    // colours, ids and sizes are numbers or names, not structure
    const c = sdfShape('other/id', 'sphere', { color: [1, 0, 0], size: [9, 9, 9] });
    expect(sdfStructure(c)).toBe(sdfStructure(sdfShape('x', 'sphere')));
  });

  it('changes with shape kinds, operators, tree shape and modifier kinds', () => {
    const base = sdfStructure(two());
    expect(sdfStructure(sdfCombine('c', 'union', [sdfShape('a', 'box'), sdfShape('b', 'box')]))).not.toBe(base);
    expect(sdfStructure(sdfCombine('c', 'subtract', [sdfShape('a', 'sphere'), sdfShape('b', 'box')]))).not.toBe(base);
    expect(sdfStructure(sdfCombine('c', 'union', [sdfShape('a', 'sphere'), sdfShape('b', 'box'), sdfShape('d', 'box')]))).not.toBe(base);
    const mir = sdfMod('m', 'mirror', sdfShape('a', 'sphere'), { axes: [true, false, false] });
    expect(sdfStructure(mir)).not.toBe(sdfStructure(sdfShape('a', 'sphere')));
    expect(sdfStructure(sdfMod('m', 'mirror', sdfShape('a', 'sphere'), { axes: [true, true, false] }))).not.toBe(sdfStructure(mir));
    expect(sdfStructure(sdfMod('m', 'round', sdfShape('a', 'sphere'), { v: [0.1] }))).not.toBe(sdfStructure(sdfMod('m', 'shell', sdfShape('a', 'sphere'), { v: [0.1] })));
    expect(sdfStructure(sdfMod('m', 'twist', sdfShape('a', 'sphere'), { axis: 0 }))).not.toBe(sdfStructure(sdfMod('m', 'twist', sdfShape('a', 'sphere'), { axis: 1 })));
    expect(sdfStructure(null)).toBe('empty');
  });

  it('repeat: only which axes have copies is structure, not the counts', () => {
    const rep = (n: number[]) => sdfMod('r', 'repeat', sdfShape('a', 'sphere'), { v: [n[0], n[1], n[2], 0, 1, 1, 1, 0] });
    expect(sdfStructure(rep([3, 1, 1]))).toBe(sdfStructure(rep([9, 1, 1])));
    expect(sdfStructure(rep([3, 1, 1]))).not.toBe(sdfStructure(rep([3, 2, 1])));
    expect(repeatAxes(rep([1, 4, 1]) as never)).toEqual([false, true, false]);
  });

  it('the generated shader is a pure function of the structure (same text for different numbers)', () => {
    expect(sdfSceneFn(two(-0.5, 0.5, 0.2))).toBe(sdfSceneFn(two(2, -2, 0.7)));
    expect(sdfSceneFn(two())).not.toBe(sdfSceneFn(sdfShape('a', 'sphere')));
    for (const text of [sdfSceneFn(two()), sdfSceneFn(sdfMod('m', 'displace', sdfShape('a', 'sphere'), { v: [0.1, 2, 0] }))]) expect(text).not.toContain('`');
  });
});

describe('sdf scene: number packing', () => {
  it('has a stable pre-order layout: shape 6 slots, combine 1, move 4, mod 2', () => {
    const root = sdfMove('m', sdfCombine('c', 'union', [sdfShape('a', 'sphere', { pos: [1, 2, 3], size: [0.5, 0, 0], color: [0.1, 0.2, 0.3], scale: 2 }), sdfShape('b', 'box', { pos: [4, 5, 6] })], 0.25), { pos: [7, 8, 9], scale: 3 });
    expect(sdfSlotCount(root)).toBe(4 + 1 + 6 + 6);
    const p = packSdf(root);
    expect(p.length).toBe(17 * 4);
    // move first: [pos, scale], then three rotation rows (identity)
    expect([...p.slice(0, 4)]).toEqual([7, 8, 9, 3]);
    expect([...p.slice(4, 7)]).toEqual([1, 0, 0]);
    // combine next: smooth
    expect(p[16]).toBeCloseTo(0.25);
    // then shape a: pos+scale, size, colour
    expect([...p.slice(20, 24)]).toEqual([1, 2, 3, 2]);
    expect([...p.slice(24, 28)]).toEqual([0.5, 0, 0, 0]);
    expect(p[28]).toBeCloseTo(0.1);
    expect(p[30]).toBeCloseTo(0.3);
    // shape b follows shape a (6 slots later)
    expect([...p.slice(44, 47)]).toEqual([4, 5, 6]);
  });

  it('numbers change the pack, never the length', () => {
    expect(packSdf(two(1, 2, 0.3)).length).toBe(packSdf(two(-5, 9, 0)).length);
    expect([...packSdf(two(1, 2, 0.3))]).not.toEqual([...packSdf(two(-5, 9, 0))]);
    expect(packSdf(two()).every(Number.isFinite)).toBe(true);
    expect(packSdf(null).length).toBe(0);
  });

  it('a hard combine still packs a tiny positive blend, and a rotation is a transposed matrix', () => {
    const p = packSdf(sdfCombine('c', 'union', [], 0));
    expect(p[0]).toBeGreaterThan(0);
    const s = packSdf(sdfShape('a', 'box', { rot: [0, 0, 90] }));
    // rotation about z by 90 degrees: local x axis row is (0, -1, 0) or (0, 1, 0), never the identity
    expect(Math.abs(s[12])).toBeLessThan(1e-6);
    expect(Math.abs(s[13])).toBeCloseTo(1);
  });
});

describe('sdf scene: counting, bounds, ids and joining', () => {
  it('counts shapes and the copies repeats and mirrors make', () => {
    const rep = sdfMod('r', 'repeat', two(), { v: [4, 3, 1, 0, 1, 1, 1, 0] });
    const mir = sdfMod('m', 'mirror', rep, { axes: [true, true, false] });
    expect(sdfCount(mir)).toEqual({ shapes: 2, copies: 2 * 4 * 3 * 4 });
    expect(() => checkSdfSize(mir)).not.toThrow();
    const huge = sdfMod('r', 'repeat', sdfShape('a', 'sphere'), { v: [32, 32, 32, 0, 1, 1, 1, 0] });
    expect(sdfCount(huge).copies).toBeGreaterThan(SDF_MAX_COPIES);
    expect(() => checkSdfSize(huge)).toThrow(/copies/);
    const many = sdfCombine('c', 'union', Array.from({ length: SDF_MAX_SHAPES + 1 }, (_, i) => sdfShape(`s${i}`, 'sphere')));
    expect(() => checkSdfSize(many)).toThrow(/shapes/);
  });

  it('bounding sphere holds every shape, through moves, and is infinite with a plane', () => {
    const b = sdfBounds(two(-1, 1, 0));
    expect(b.radius).toBeGreaterThanOrEqual(1.3 - 1e-9); // the box reaches x = 1 + 0.3 * sqrt(3)
    const reach = (c: number[], x: number, r: number) => Math.hypot(x - c[0], 0, 0) <= r + 1e-9;
    expect(reach(b.center, -1.4, b.radius)).toBe(true);
    expect(reach(b.center, 1.5, b.radius)).toBe(true);
    const moved = sdfBounds(sdfMove('m', sdfShape('a', 'sphere', { size: [1, 0, 0] }), { pos: [3, 0, 0], scale: 2 }));
    expect(moved.center[0]).toBeCloseTo(3);
    expect(moved.radius).toBeCloseTo(2);
    expect(Number.isFinite(sdfBounds(sdfMod('r', 'repeat', sdfShape('a', 'sphere', { size: [0.5, 0, 0] }), { v: [3, 1, 1, 0, 2, 1, 1, 0] })).radius)).toBe(true);
    expect(sdfBounds(sdfCombine('c', 'union', [sdfShape('a', 'sphere'), sdfShape('p', 'plane')])).radius).toBe(Infinity);
    expect(sdfBounds(null).radius).toBe(0);
  });

  it('ids are kept as given and a path lists the scenes a shape sits in', () => {
    const inner = sdfMove('outer/scene2/render', sdfCombine('outer/scene2/c', 'union', [sdfShape('outer/scene2/s1', 'sphere')]));
    const outer = sdfCombine('outer/c', 'union', [sdfShape('outer/s0', 'box'), inner]);
    expect(sdfFind(outer, 'outer/scene2/s1')?.t).toBe('shape');
    expect(sdfPathTo(outer, 'outer/scene2/s1')).toEqual(['outer/c', 'outer/scene2/render', 'outer/scene2/c', 'outer/scene2/s1']);
    expect(sdfPathTo(outer, 'outer/s0')).toEqual(['outer/c', 'outer/s0']);
    expect(sdfPathTo(outer, 'nope')).toEqual([]);
  });

  it('joins several scenes (empty ones dropped) and keeps the first picture', () => {
    const pic = { texture: {} } as never;
    const j = sdfJoin([sdfValue(sdfShape('a', 'sphere')), sdfValue(null), null, sdfValue(sdfShape('b', 'box'), pic)]);
    expect(j.roots.map((r) => r.id)).toEqual(['a', 'b']);
    expect(j.picture).toBe(pic);
  });

  it('twist, bend and displace make the field inexact and shorten the steps', () => {
    expect(sdfExact(two())).toBe(true);
    expect(sdfStepScale(two())).toBe(1);
    for (const m of ['twist', 'bend', 'displace'] as const) {
      const s = sdfMod('m', m, sdfShape('a', 'sphere'));
      expect(sdfExact(s)).toBe(false);
      expect(sdfStepScale(s)).toBeLessThan(1);
    }
    expect(sdfExact(sdfMod('m', 'shell', sdfShape('a', 'sphere')))).toBe(true);
  });
});
