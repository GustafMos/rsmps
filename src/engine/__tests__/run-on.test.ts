import { expect, it } from 'vitest';
import { harness } from '../testing';

const proj = { width: 32, height: 32, fps: 10, duration: 2 }; // 20 frames
const phaseAt = async (t: Awaited<ReturnType<typeof harness>>, seconds: number, loop: boolean) => {
  const out = await t.run('time', {}, {}, { seconds, project: { ...proj, loop } });
  return (out.phase as { value: number } | number | null) as unknown;
};
const num = (v: unknown): number => (typeof v === 'number' ? v : (v as { value: number }).value);

it('Loop on: the phase wraps at the project length; Loop off: it runs on past 1 when time runs on past the end', async () => {
  const t = await harness();
  // inside the project both are the same
  for (const s of [0, 0.5, 1.9]) {
    expect(num(await phaseAt(t, s, true))).toBeCloseTo(s / 2, 6);
    expect(num(await phaseAt(t, s, false))).toBeCloseTo(s / 2, 6);
  }
  // past the end: a loop comes round, a project without loop keeps counting (nothing jumps back)
  expect(num(await phaseAt(t, 2.5, true))).toBeCloseTo(0.25, 6);
  expect(num(await phaseAt(t, 2.5, false))).toBeCloseTo(1.25, 6);
  expect(num(await phaseAt(t, 7, true))).toBeCloseTo(0.5, 6);
  expect(num(await phaseAt(t, 7, false))).toBeCloseTo(3.5, 6);
});

it('with time running on, a looping type keeps moving smoothly across the project length and does not repeat frame for frame', async () => {
  const t = await harness();
  const grab = async (seconds: number) => (await t.pixels((await t.run('particles', { preset: 'dust', count: 60, particleSize: 8, seed: 3 }, {}, { seconds, project: { ...proj, width: 96, height: 96, loop: false } })).image as never)).data;
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };
  const [before, at, after, step] = [await grab(1.9), await grab(2.0), await grab(2.1), await grab(1.0)];
  const stepBefore = diff(await grab(0.9), step); // an ordinary step of one frame
  // crossing the project length is an ordinary step too: no jump back to the first frame
  expect(diff(before, at)).toBeLessThan(stepBefore * 3 + 0.5);
  expect(diff(at, after)).toBeLessThan(stepBefore * 3 + 0.5);
  expect(diff(at, await grab(0))).toBeGreaterThan(0); // and the frame at the project length is not the first frame again
});
