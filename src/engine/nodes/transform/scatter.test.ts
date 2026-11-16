import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const project = { width: 64, height: 64 };
const RED: [number, number, number, number] = [255, 0, 0, 255];

async function coverage(t: Awaited<ReturnType<typeof harness>>, params: Record<string, unknown>, inputs: Record<string, unknown>) {
  const out = await t.run('scatter', params, inputs as never, { project });
  const px = await t.pixels(out.image as never);
  return px;
}
const alphaSum = (px: { data: Uint8ClampedArray }, x0: number, x1: number) => {
  // sums alpha over columns [x0, x1)
  let s = 0;
  const w = Math.sqrt(px.data.length / 4);
  for (let y = 0; y < w; y++) for (let x = x0; x < x1; x++) s += px.data[(y * w + x) * 4 + 3];
  return s;
};

describe('scatter', () => {
  it('without a mask it covers the frame with copies, evenly, and keeps their transparency', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => [255, 0, 0, x < 4 ? 255 : 0]);
    const px = await coverage(t, { count: 60, size: 0.12, rotVar: 0 }, { image: src });
    const filled = (px.data.length / 4) && Array.from({ length: px.data.length / 4 }, (_, i) => px.data[i * 4 + 3]).filter((a) => a > 200).length / (64 * 64);
    expect(filled).toBeGreaterThan(0.03);
    expect(filled).toBeLessThan(0.5);
    // left and right halves both get copies
    expect(alphaSum(px, 0, 32)).toBeGreaterThan(0);
    expect(alphaSum(px, 32, 64)).toBeGreaterThan(0);
  });

  it('places copies only where the mask is bright', async () => {
    const t = await harness();
    const mask = t.maskFn(64, 64, (x) => (x < 32 ? 1 : 0));
    const px = await coverage(t, { count: 300, size: 0.1, rotVar: 0 }, { image: t.solid(8, 8, RED), mask });
    expect(alphaSum(px, 0, 28)).toBeGreaterThan(2000);
    expect(alphaSum(px, 40, 64)).toBe(0);
  });

  it('is deterministic per seed and changes with it', async () => {
    const t = await harness();
    const src = t.solid(8, 8, RED);
    const a = await coverage(t, { count: 80, size: 0.1, seed: 3 }, { image: src });
    const b = await coverage(t, { count: 80, size: 0.1, seed: 3 }, { image: src });
    const c = await coverage(t, { count: 80, size: 0.1, seed: 4 }, { image: src });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(c.data));
  });

  it('density scales how many copies appear (0 = none)', async () => {
    const t = await harness();
    const src = t.solid(8, 8, RED);
    const full = alphaSum(await coverage(t, { count: 200, size: 0.08, density: 1 }, { image: src }), 0, 64);
    const half = alphaSum(await coverage(t, { count: 200, size: 0.08, density: 0.4 }, { image: src }), 0, 64);
    const none = alphaSum(await coverage(t, { count: 200, size: 0.08, density: 0 }, { image: src }), 0, 64);
    expect(half).toBeLessThan(full * 0.7);
    expect(half).toBeGreaterThan(full * 0.15);
    expect(none).toBe(0);
  });

  it('per-copy hue variation recolours copies differently', async () => {
    const t = await harness();
    const px = await coverage(t, { count: 80, size: 0.12, hueVar: 150, rotVar: 0 }, { image: t.solid(8, 8, [220, 40, 40, 255]) });
    const hues = new Set<string>();
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] === 255) hues.add(`${px.data[i] >> 5}-${px.data[i + 1] >> 5}-${px.data[i + 2] >> 5}`);
    expect(hues.size).toBeGreaterThan(3);
  });

  it('regions: one copy per tracked region, fitted to its box', async () => {
    const t = await harness();
    const regions = { kind: 'regions', items: [{ id: 1, label: 'a', score: 1, box: [0.5, 0.5, 0.75, 0.75] }] };
    const px = await coverage(t, { rotVar: 0, scaleVar: 0 }, { image: t.solid(4, 4, RED), regions });
    expect(px.at(40, 40)).toEqual(RED);
    expect(px.at(34, 46)[3]).toBe(255);
    expect(px.at(28, 28)[3]).toBe(0);
    expect(px.at(52, 52)[3]).toBe(0);
  });

  it('refuses copies that are too big for the point count with a readable error', async () => {
    const t = await harness();
    await expect(coverage(t, { count: 400, size: 1.5 }, { image: t.solid(4, 4, RED) })).rejects.toThrow(/Scatter: copies this large/);
  });

  it('thousands of points: still one pass and no new shader', async () => {
    const t = await harness();
    const src = t.solid(4, 4, RED);
    const mask = t.maskFn(64, 64, (x, y) => (x + y) / 128);
    await coverage(t, { count: 20 }, { image: src, mask });
    const s0 = t.gpu.stats().objects;
    await t.run('scatter', { count: 150000, size: 0.004, scaleVar: 0.1, seed: 9, density: 0.7 }, { image: src, mask }, { project });
    const s1 = t.gpu.stats().objects;
    expect(s1.submits - s0.submits).toBe(1);
    expect(s1.pipelinesCreated - s0.pipelinesCreated).toBe(0);
  });
});
