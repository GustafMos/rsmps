import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { meltWeights } from './style-melt.node';

it('the three changes are staggered: nothing at the ends, colour and texture lead, shapes follow', () => {
  expect(meltWeights(0)).toEqual({ style: 0, shape: 0, lead: 0 });
  const end = meltWeights(1);
  expect(end.style).toBeCloseTo(0, 6);
  expect(end.shape).toBe(1);
  expect(end.lead).toBe(1);
  const early = meltWeights(0.3);
  expect(early.lead).toBeGreaterThan(0.5); // B's colour and texture are well in
  expect(early.shape).toBe(0); // but the shapes are still A's
  expect(meltWeights(0.5).style).toBeCloseTo(1, 6);
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const w = meltWeights(i / 20);
    expect(w.shape).toBeGreaterThanOrEqual(prev);
    expect(w.lead).toBeGreaterThanOrEqual(w.shape);
    prev = w.shape;
  }
});

it('style melt: progress 0 is A, progress 1 is B, the middle is neither and carries B’s colour onto A’s layout', async () => {
  const t = await harness();
  // A: a red disc on dark grey. B: fine blue-white stripes.
  const a = t.fromFn(96, 64, (x, y) => (Math.hypot(x - 48, y - 32) < 18 ? [220, 40, 30, 255] : [40, 40, 40, 255]));
  const b = t.fromFn(96, 64, (x) => (x % 4 < 2 ? [40, 80, 230, 255] : [200, 220, 255, 255]));
  const run = async (progress: number) => t.pixels((await t.run('style-melt', { progress, churn: 0 }, { a, b })).image as never);
  const pa = await t.pixels(a as never);
  const pb = await t.pixels(b as never);
  const diff = (p: Awaited<ReturnType<typeof run>>, q: typeof pa) => {
    let s = 0;
    let n = 0;
    for (let y = 2; y < 62; y += 3) for (let x = 2; x < 94; x += 3) { for (let c = 0; c < 3; c++) s += Math.abs(p.at(x, y)[c] - q.at(x, y)[c]); n += 3; }
    return s / n;
  };
  expect((await t.run('style-melt', { progress: 0 }, { a, b })).image).toBe(a);
  expect(diff(await run(0.001), pa)).toBeLessThan(3);
  expect(diff(await run(1), pb)).toBeLessThan(3);
  const mid = await run(0.3);
  expect(diff(mid, pa)).toBeGreaterThan(12);
  expect(diff(mid, pb)).toBeGreaterThan(12);
  // at 30 % the disc is still where A has it (shapes are A's), but bluer than in A (B's colour leads)
  const inDisc = mid.at(48, 32);
  const outDisc = mid.at(8, 8);
  expect(inDisc[0]).toBeGreaterThan(outDisc[0] + 25);
  expect(inDisc[2]).toBeGreaterThan(pa.at(48, 32)[2] + 20);
});
