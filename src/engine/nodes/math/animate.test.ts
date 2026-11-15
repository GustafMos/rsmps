import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const project = { fps: 10, duration: 2, loop: true };

describe('animate', () => {
  it('sine goes from → to → from over one loop', async () => {
    const t = await harness();
    const at = async (params: Record<string, unknown>, seconds: number) => (await t.run('animate', params, {}, { seconds, project })).value as number;
    const p = { wave: 'sine', from: 0, to: 10, cycles: 1 };
    expect(await at(p, 0)).toBeCloseTo(0, 6);
    expect(await at(p, 1)).toBeCloseTo(10, 6);
    expect(await at(p, 0.5)).toBeCloseTo(5, 6);
    expect(await at({ ...p, cycles: 2 }, 0.5)).toBeCloseTo(10, 6);
    expect(await at({ ...p, phase: 0.5 }, 0)).toBeCloseTo(10, 6);
  });

  it('every wave loops exactly and stays inside From..To', async () => {
    const t = await harness();
    for (const wave of ['sine', 'triangle', 'saw-up', 'saw-down', 'square', 'bounce', 'ping-pong-ease', 'steps', 'noise']) {
      for (const cycles of [1, 3]) {
        const params = { wave, from: -5, to: 5, cycles, seed: 4 };
        const first = (await t.run('animate', params, {}, { seconds: 0, project })).value as number;
        const end = (await t.run('animate', params, {}, { seconds: 2, project })).value as number;
        expect(end, `${wave} x${cycles} seam`).toBe(first);
        let lo = Infinity;
        let hi = -Infinity;
        for (let f = 3; f < 20; f += 5) {
          const v = (await t.run('animate', params, {}, { seconds: f / 10, project })).value as number;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        expect(lo, wave).toBeGreaterThanOrEqual(-5 - 1e-9);
        expect(hi, wave).toBeLessThanOrEqual(5 + 1e-9);
        expect(hi - lo, `${wave} moves`).toBeGreaterThan(0.5);
      }
    }
  });

  it('saw, square, steps and bounce have their shapes', async () => {
    const t = await harness();
    const at = async (params: Record<string, unknown>, seconds: number) => (await t.run('animate', { from: 0, to: 1, ...params }, {}, { seconds, project })).value as number;
    expect(await at({ wave: 'saw-up' }, 0.5)).toBeCloseTo(0.25, 6);
    expect(await at({ wave: 'saw-down' }, 0.5)).toBeCloseTo(0.75, 6);
    expect(await at({ wave: 'square' }, 0.4)).toBe(0);
    expect(await at({ wave: 'square' }, 1.2)).toBe(1);
    expect(await at({ wave: 'steps', steps: 4 }, 0.7)).toBeCloseTo(1 / 3, 6);
    expect(await at({ wave: 'steps', steps: 4 }, 1.9)).toBeCloseTo(1, 6);
    expect(await at({ wave: 'bounce' }, 1)).toBeCloseTo(1, 6);
  });

  it('easing reshapes the motion', async () => {
    const t = await harness();
    const at = async (easing: string) => (await t.run('animate', { wave: 'triangle', easing }, {}, { seconds: 0.5, project })).value as number;
    expect(await at('linear')).toBeCloseTo(0.5, 6);
    expect(await at('ease-in')).toBeCloseTo(0.125, 6);
    expect(await at('ease-out')).toBeCloseTo(0.875, 6);
  });

  it('noise is repeatable, seed-dependent and animated', async () => {
    const t = await harness();
    const at = async (seed: number, seconds: number) => (await t.run('animate', { wave: 'noise', seed }, {}, { seconds, project })).value as number;
    expect(await at(3, 0.7)).toBe(await at(3, 0.7));
    expect(await at(3, 0.7)).not.toBe(await at(4, 0.7));
    expect(await at(3, 0.2)).not.toBe(await at(3, 1.1));
  });

  it('cycles 0 holds still and does not depend on time', async () => {
    const t = await harness();
    const at = async (s: number) => (await t.run('animate', { cycles: 0, from: 2, to: 8, phase: 0.5 }, {}, { seconds: s, project })).value;
    expect(await at(0)).toBe(8);
    expect(await at(1.3)).toBe(8);
  });
});
