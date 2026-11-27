import { describe, expect, it } from 'vitest';
import { nearestShape, sdfDistance, sdfLeafDistances, sdfRay, shapeDistance } from './sdf-eval';
import { sdfCombine, sdfMod, sdfMove, sdfShape } from './sdf-scene';
import type { SdfShapeKind } from '../types';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const one = (shape: SdfShapeKind, size: [number, number, number], p: [number, number, number]) => shapeDistance(sdfShape('s', shape, { size }), p);

describe('sdf-eval: primitive distances match the analytic values', () => {
  it('sphere, box, rounded box', () => {
    near(one('sphere', [0.5, 0, 0], [2, 0, 0]), 1.5);
    near(one('sphere', [0.5, 0, 0], [0, 0.2, 0]), -0.3);
    near(one('box', [1, 1, 1], [3, 0, 0]), 2);
    near(one('box', [1, 1, 1], [2, 2, 0]), Math.SQRT2);
    near(one('box', [1, 1, 1], [0, 0.5, 0]), -0.5);
    // rounded box: the corner is rounded by r = 0.25 x the smallest half size; straight out from a face nothing changes
    near(one('rbox', [1, 1, 1], [3, 0, 0]), 2);
    // diagonal from the corner: the inner box has half size 0.75, so the distance is |(2,2,2) - (0.75,...)| - 0.25
    near(one('rbox', [1, 1, 1], [2, 2, 2]), Math.hypot(1.25, 1.25, 1.25) - 0.25);
  });
  it('torus, capsule, cylinder, plane, octahedron, cone', () => {
    near(one('torus', [1, 0.2, 0], [2, 0, 0]), 0.8);
    near(one('torus', [1, 0.2, 0], [1, 0.5, 0]), 0.3);
    near(one('capsule', [0.3, 1, 0], [0, 2, 0]), 0.7);
    near(one('capsule', [0.3, 1, 0], [1, 0, 0]), 0.7);
    near(one('cylinder', [1, 1, 0], [3, 0, 0]), 2);
    near(one('cylinder', [1, 1, 0], [0, 3, 0]), 2);
    near(one('cylinder', [1, 1, 0], [2, 2, 0]), Math.SQRT2);
    near(one('plane', [0, 0, 0], [5, 0.7, 5]), 0.7);
    // octahedron |x|+|y|+|z| = r: the face distance is (sum - r) / sqrt 3
    near(one('octa', [1, 0, 0], [2, 0, 0]), 1);
    near(one('octa', [1, 0, 0], [0.5, 0.5, 0.5]), (1.5 - 1) * 0.57735027);
    // cone: base radius 0.5 at the bottom, tip at the top, half height 1
    near(one('cone', [0.5, 1, 0], [0, 1, 0]), 0, 1e-6);
    near(one('cone', [0.5, 1, 0], [0, -1, 0]), 0, 1e-6);
    expect(one('cone', [0.5, 1, 0], [0, 0, 0])).toBeLessThan(0);
    near(one('cone', [0.5, 1, 0], [0, -2, 0]), 1, 1e-6);
  });
});

describe('sdf-eval: combine, move, modifiers', () => {
  const a = sdfShape('a', 'sphere', { size: [0.5, 0, 0], pos: [-1, 0, 0] });
  const b = sdfShape('b', 'sphere', { size: [0.5, 0, 0], pos: [1, 0, 0] });
  it('union, subtract, intersect and smoothness', () => {
    near(sdfDistance(sdfCombine('c', 'union', [a, b], 0.0001), [0, 0, 0]), 0.5, 1e-4);
    near(sdfDistance(sdfCombine('c', 'union', [a, b], 0.0001), [-1, 0, 0]), -0.5, 1e-4);
    // a minus b: at b's centre we are outside a (1.5 from its surface); at a's centre we are inside, away from b
    near(sdfDistance(sdfCombine('c', 'subtract', [a, b], 0.0001), [1, 0, 0]), 1.5, 1e-4);
    near(sdfDistance(sdfCombine('c', 'subtract', [a, b], 0.0001), [-1, 0, 0]), -0.5, 1e-4);
    // intersect takes the larger distance: inside a but 1.5 from b gives 1.5
    near(sdfDistance(sdfCombine('c', 'intersect', [a, b], 0.0001), [-1, 0, 0]), 1.5, 1e-4);
    // a smooth union is never farther than the sharp one: where both distances are 0.5 it gives 0.5 - k / 4
    const sharp = sdfDistance(sdfCombine('c', 'union', [a, b], 0.0001), [0, 0, 0]);
    const soft = sdfDistance(sdfCombine('c', 'union', [a, b], 1), [0, 0, 0]);
    expect(soft).toBeLessThan(sharp);
    near(soft, 0.5 - 0.25, 1e-9);
  });
  it('move places, turns and scales the child', () => {
    const s = sdfShape('s', 'box', { size: [1, 0.2, 0.2] });
    const m = sdfMove('m', s, { pos: [0, 3, 0], rot: [0, 0, 90], scale: 2 });
    // the box is 1 long along x; turned 90 degrees about z it lies along y, doubled: reaches 2 up from y = 3
    near(sdfDistance(m, [0, 5.5, 0]), 0.5);
    near(sdfDistance(m, [0.9, 3, 0]), 0.9 - 0.4);
  });
  it('mirror, repeat, round, shell', () => {
    const s = sdfShape('s', 'sphere', { size: [0.5, 0, 0], pos: [2, 0, 0] });
    const mir = sdfMod('x', 'mirror', s, { axes: [true, false, false] });
    near(sdfDistance(mir, [-2, 0, 0]), -0.5);
    near(sdfDistance(mir, [-3, 0, 0]), 0.5);
    const c = sdfShape('c', 'sphere', { size: [0.5, 0, 0] });
    const rep = sdfMod('r', 'repeat', c, { v: [3, 1, 1, 0, 2, 1, 1, 0] });
    near(sdfDistance(rep, [2, 0, 0]), -0.5);
    near(sdfDistance(rep, [-2, 0, 0]), -0.5);
    near(sdfDistance(rep, [4, 0, 0]), 1.5); // the copies sit at -2, 0 and 2: x = 4 is 2 away from the last centre, 1.5 from its surface
    near(sdfDistance(sdfMod('rd', 'round', c, { v: [0.2] }), [1, 0, 0]), 0.3);
    near(sdfDistance(sdfMod('sh', 'shell', c, { v: [0.1] }), [0, 0, 0]), 0.4);
  });
});

describe('sdf-eval: picking', () => {
  const two = sdfCombine('c', 'union', [sdfShape('sc/left', 'sphere', { size: [0.5, 0, 0], pos: [-1, 0, 0] }), sdfShape('sc/right', 'box', { size: [0.5, 0.5, 0.5], pos: [1, 0, 0] })]);
  it('the ray hits the right shape of two', () => {
    const l = sdfRay(two, [-1, 0, -5], [0, 0, 1]);
    expect(l?.id).toBe('sc/left');
    near(l!.t, 4.5, 0.01);
    const r = sdfRay(two, [1, 0.2, -5], [0, 0, 1]);
    expect(r?.id).toBe('sc/right');
    near(r!.t, 4.5, 0.01);
    expect(sdfRay(two, [0, 0, -5], [0, 0, 1])).toBeNull();
  });
  it('a ray through a nested scene (a Move around a combine) finds the shape inside it, in the world frame', () => {
    const inner = sdfCombine('in', 'union', [sdfShape('o/in/a', 'sphere', { size: [0.5, 0, 0], pos: [1, 0, 0] }), sdfShape('o/in/b', 'sphere', { size: [0.5, 0, 0], pos: [-1, 0, 0] })]);
    const outer = sdfCombine('o', 'union', [sdfMove('o/in', inner, { pos: [0, 2, 0], rot: [0, 0, 90], scale: 1.5 }), sdfShape('o/floor', 'sphere', { size: [0.5, 0, 0], pos: [-3, 0, 0] })]);
    // after the turn about z, shape a (x = +1) sits at y = 2 + 1.5, b at y = 2 - 1.5
    expect(sdfRay(outer, [0, 3.5, -6], [0, 0, 1])?.id).toBe('o/in/a');
    expect(sdfRay(outer, [0, 0.5, -6], [0, 0, 1])?.id).toBe('o/in/b');
    expect(sdfRay(outer, [-3, 0, -6], [0, 0, 1])?.id).toBe('o/floor');
  });
  it('a subtracted shape owns the surface of the hole it cut', () => {
    const cut = sdfCombine('c', 'subtract', [sdfShape('big', 'sphere', { size: [1, 0, 0] }), sdfShape('hole', 'sphere', { size: [0.5, 0, 0], pos: [0, 0, -1] })]);
    expect(sdfRay(cut, [0, 0, -5], [0, 0, 1])?.id).toBe('hole');
  });
  it('shapes under a mirror are measured against their nearest copy', () => {
    const s = sdfShape('m/s', 'sphere', { size: [0.5, 0, 0], pos: [2, 0, 0] });
    const other = sdfShape('m/o', 'sphere', { size: [0.5, 0, 0], pos: [0, 3, 0] });
    const root = sdfCombine('c', 'union', [sdfMod('mir', 'mirror', s, { axes: [true, false, false] }), other]);
    expect(sdfRay(root, [-2, 0, -5], [0, 0, 1])?.id).toBe('m/s');
    expect(nearestShape(root, [-2, 0.4, 0])).toBe('m/s');
    near(sdfLeafDistances(root, [-2, 0, 0]).get('m/s')!, 0.5);
  });
});
