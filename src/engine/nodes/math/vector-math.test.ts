import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import type { VectorValue } from '../../types';
import { applyVectorMath } from './vector-math.node';

const A: VectorValue = [1, 2, 3];
const B: VectorValue = [4, -5, 6];
const close = (got: VectorValue, want: VectorValue) => got.forEach((n, i) => expect(n).toBeCloseTo(want[i], 9));

describe('Vector Math', () => {
  it('add, subtract, multiply, scale, mix', () => {
    expect(applyVectorMath('add', A, B, 0, 0).vector).toEqual([5, -3, 9]);
    expect(applyVectorMath('subtract', A, B, 0, 0).vector).toEqual([-3, 7, -3]);
    expect(applyVectorMath('multiply', A, B, 0, 0).vector).toEqual([4, -10, 18]);
    expect(applyVectorMath('scale', A, B, 2.5, 0).vector).toEqual([2.5, 5, 7.5]);
    expect(applyVectorMath('mix', A, B, 0, 0).vector).toEqual(A);
    expect(applyVectorMath('mix', A, B, 1, 0).vector).toEqual(B);
    close(applyVectorMath('mix', A, B, 0.5, 0).vector, [2.5, -1.5, 4.5]);
  });

  it('length, distance and dot give a number; the other operations give the length of their result', () => {
    expect(applyVectorMath('length', [3, 4, 12], B, 0, 0).value).toBe(13);
    expect(applyVectorMath('length', [3, 4, 12], B, 0, 0).vector).toEqual([3, 4, 12]);
    expect(applyVectorMath('distance', [1, 1, 1], [4, 5, 1], 0, 0).value).toBe(5);
    expect(applyVectorMath('dot', A, B, 0, 0).value).toBe(4 - 10 + 18);
    expect(applyVectorMath('add', [1, 0, 0], [2, 4, 4], 0, 0).value).toBe(Math.hypot(3, 4, 4));
  });

  it('normalize and cross', () => {
    close(applyVectorMath('normalize', [0, 3, 4], B, 0, 0).vector, [0, 0.6, 0.8]);
    expect(applyVectorMath('normalize', [0, 3, 4], B, 0, 0).value).toBeCloseTo(1, 12);
    expect(applyVectorMath('normalize', [0, 0, 0], B, 0, 0).vector).toEqual([0, 0, 0]); // no direction: zero, never NaN
    expect(applyVectorMath('cross', [1, 0, 0], [0, 1, 0], 0, 0).vector).toEqual([0, 0, 1]);
    expect(applyVectorMath('cross', A, B, 0, 0).vector).toEqual([27, 6, -13]);
  });

  it('rotate around an axis (right-handed, degrees); no axis leaves A alone', () => {
    close(applyVectorMath('rotate', [1, 0, 0], [0, 0, 1], 0, 90).vector, [0, 1, 0]);
    close(applyVectorMath('rotate', [1, 0, 0], [0, 0, 5], 0, 180).vector, [-1, 0, 0]); // the axis need not be unit length
    close(applyVectorMath('rotate', [0, 2, 0], [1, 0, 0], 0, 90).vector, [0, 0, 2]);
    close(applyVectorMath('rotate', A, B, 0, 360).vector, A);
    expect(applyVectorMath('rotate', A, [0, 0, 0], 0, 90).vector).toEqual(A);
    expect(applyVectorMath('rotate', A, B, 0, 73).value).toBeCloseTo(Math.hypot(1, 2, 3), 9); // length kept
  });

  it('never gives NaN or Infinity, and an unknown operation passes A through', () => {
    const r = applyVectorMath('scale', [1e308, 1, 1], B, 1e10, 0);
    expect(r.vector.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(r.value)).toBe(true);
    expect(applyVectorMath('nope', A, B, 0, 0).vector).toEqual(A);
  });

  it('as a node: unwired inputs count as zero, the factor is a wireable number', async () => {
    const t = await harness();
    const vec = (x: number, y: number, z: number) => ({ node: 'vector', params: { x, y, z } });
    const add = await t.run('vector-math', { op: 'add' }, { a: vec(1, 2, 3), b: vec(4, -5, 6) });
    expect(add.vector).toEqual([5, -3, 9]);
    expect((await t.run('vector-math', { op: 'add' }, { a: vec(1, 2, 3) })).vector).toEqual([1, 2, 3]);
    expect((await t.run('vector-math', { op: 'add' })).vector).toEqual([0, 0, 0]);
    expect((await t.run('vector-math', { op: 'scale' }, { a: vec(1, 2, 3), factor: 3 })).vector).toEqual([3, 6, 9]);
    expect((await t.run('vector-math', { op: 'length' }, { a: vec(3, 4, 0) })).value).toBe(5);
  });
});
