import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('value / color / math / remap', () => {
  it('value and color output constants', async () => {
    const t = await harness();
    expect((await t.run('value', { value: 3.5 })).value).toBe(3.5);
    expect((await t.run('color', { color: [0.1, 0.2, 0.3, 0.4] })).color).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('math does binary operations', async () => {
    const t = await harness();
    const calc = async (op: string, a: number, b: number) => (await t.run('math', { op, a, b })).value as number;
    expect(await calc('add', 2, 3)).toBe(5);
    expect(await calc('subtract', 2, 3)).toBe(-1);
    expect(await calc('multiply', 2, 3)).toBe(6);
    expect(await calc('divide', 6, 3)).toBe(2);
    expect(await calc('divide', 6, 0)).toBe(0);
    expect(await calc('power', 2, 10)).toBe(1024);
    expect(await calc('min', 2, 3)).toBe(2);
    expect(await calc('max', 2, 3)).toBe(3);
    expect(await calc('modulo', 7, 3)).toBe(1);
    expect(await calc('modulo', -1, 3)).toBe(2);
    expect(await calc('modulo', 5, 0)).toBe(0);
  });

  it('math does unary operations on A and ignores B', async () => {
    const t = await harness();
    const calc = async (op: string, a: number) => (await t.run('math', { op, a, b: 99 })).value as number;
    expect(await calc('abs', -2)).toBe(2);
    expect(await calc('floor', 2.7)).toBe(2);
    expect(await calc('ceil', 2.1)).toBe(3);
    expect(await calc('round', 2.5)).toBe(3);
    expect(await calc('sin', Math.PI / 2)).toBeCloseTo(1);
    expect(await calc('cos', 0)).toBe(1);
    expect(await calc('sqrt', 9)).toBe(3);
    expect(await calc('sqrt', -4)).toBe(0);
    expect(await calc('negate', 4)).toBe(-4);
  });

  it('math clamps and accepts wired numbers', async () => {
    const t = await harness();
    expect((await t.run('math', { op: 'multiply', a: 4, b: 5, clamp: true })).value).toBe(1);
    expect((await t.run('math', { op: 'add', b: 1 }, { a: 41 })).value).toBe(42);
  });

  it('remap converts ranges, with and without clamping', async () => {
    const t = await harness();
    const p = { fromMin: 0, fromMax: 1, toMin: 10, toMax: 20 };
    expect((await t.run('remap', { ...p, value: 0.25 })).value).toBe(12.5);
    expect((await t.run('remap', { ...p, value: 2 })).value).toBe(20);
    expect((await t.run('remap', { ...p, value: 2, clamp: false })).value).toBe(30);
    expect((await t.run('remap', { ...p, fromMax: 0, value: 5 })).value).toBe(10);
    expect((await t.run('remap', { ...p, toMin: 5, toMax: 0, value: 0.5 })).value).toBe(2.5);
  });
});
