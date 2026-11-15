import { describe, expect, it } from 'vitest';
import { regionsSource, TestGraph } from '../../lib/track-testutil';
import { harness } from '../../testing';
import type { Region } from '../../types';

const R = (id: number, label: string, score: number, box: [number, number, number, number]): Region => ({ id, label, score, box });
const LIST: Region[] = [
  R(1, 'person', 0.9, [0.1, 0.1, 0.3, 0.5]),
  R(2, 'car', 0.6, [0.5, 0.5, 0.9, 0.8]),
  R(3, 'person', 0.4, [0.6, 0.1, 0.65, 0.2]),
];

async function chain(type: string, params: Record<string, unknown>, list = LIST) {
  const t = await harness([regionsSource('test-list', () => list)]);
  const g = new TestGraph(t);
  const s = g.add('test-list');
  const n = g.add(type, params);
  g.wire(s, 'regions', n, 'regions');
  return { g, n, t };
}

describe('region-filter', () => {
  it('filters by label, with exclusion', async () => {
    const { g, n } = await chain('region-filter', { label: 'person' });
    expect((await g.regions(n)).map((r) => r.id)).toEqual([1, 3]);
    const ex = await chain('region-filter', { label: '!person' });
    expect((await ex.g.regions(ex.n)).map((r) => r.id)).toEqual([2]);
  });

  it('filters by score and id', async () => {
    const a = await chain('region-filter', { minScore: 0.5 });
    expect((await a.g.regions(a.n)).map((r) => r.id)).toEqual([1, 2]);
    const b = await chain('region-filter', { ids: '3, 2' });
    expect((await b.g.regions(b.n)).map((r) => r.id)).toEqual([2, 3]);
  });

  it('keeps the largest, region #n, or everything but', async () => {
    const big = await chain('region-filter', { order: 'largest', count: 1 });
    expect((await big.g.regions(big.n)).map((r) => r.id)).toEqual([2]);
    const nth = await chain('region-filter', { first: 2, count: 1 });
    expect((await nth.g.regions(nth.n)).map((r) => r.id)).toEqual([3]);
    const inv = await chain('region-filter', { order: 'largest', count: 1, invert: true });
    expect((await inv.g.regions(inv.n)).map((r) => r.id)).toEqual([1, 3]);
    const left = await chain('region-filter', { order: 'left', first: 1 });
    expect((await left.g.regions(left.n)).map((r) => r.id)).toEqual([3, 2]);
  });
});

describe('region-transform', () => {
  it('scales, grows and offsets', async () => {
    const a = await chain('region-transform', { scale: 2 }, [R(1, 'a', 1, [0.4, 0.4, 0.5, 0.5])]);
    const r = (await a.g.regions(a.n))[0].box;
    expect(r[0]).toBeCloseTo(0.35, 5);
    expect(r[2]).toBeCloseTo(0.55, 5);
    const b = await chain('region-transform', { grow: 0.05, offset: [0.1, 0] }, [R(1, 'a', 1, [0.4, 0.4, 0.5, 0.5])]);
    const g = (await b.g.regions(b.n))[0].box;
    expect(g[0]).toBeCloseTo(0.45, 5);
    expect(g[2]).toBeCloseTo(0.65, 5);
    expect(g[1]).toBeCloseTo(0.35, 5);
  });

  it('forces an aspect ratio in image pixels and clamps to the frame', async () => {
    // Project is 64x64, so aspect 1 = square in frame fractions too.
    const a = await chain('region-transform', { aspect: 1 }, [R(1, 'a', 1, [0.4, 0.3, 0.5, 0.7])]);
    const r = (await a.g.regions(a.n))[0].box;
    expect(r[2] - r[0]).toBeCloseTo(r[3] - r[1], 5);
    expect(r[3] - r[1]).toBeCloseTo(0.4, 5); // grown to the larger side
    const s = await chain('region-transform', { aspect: 1, aspectMode: 'shrink' }, [R(1, 'a', 1, [0.4, 0.3, 0.5, 0.7])]);
    const q = (await s.g.regions(s.n))[0].box;
    expect(q[3] - q[1]).toBeCloseTo(0.1, 5);
    const c = await chain('region-transform', { scale: 8 }, [R(1, 'a', 1, [0.4, 0.4, 0.6, 0.6])]);
    const k = (await c.g.regions(c.n))[0].box;
    expect(k).toEqual([0, 0, 1, 1]);
    const free = await chain('region-transform', { scale: 8, clamp: false }, [R(1, 'a', 1, [0.4, 0.4, 0.6, 0.6])]);
    expect((await free.g.regions(free.n))[0].box[0]).toBeLessThan(0);
  });
});

describe('region-info', () => {
  it('outputs numbers of the chosen region', async () => {
    const { g, n } = await chain('region-info', { index: 1 });
    const num = async (port: string) => (await g.eval(n, 0, port)) as number;
    expect(await num('x')).toBeCloseTo(0.7, 5);
    expect(await num('y')).toBeCloseTo(0.65, 5);
    expect(await num('width')).toBeCloseTo(0.4, 5);
    expect(await num('height')).toBeCloseTo(0.3, 5);
    expect(await num('score')).toBeCloseTo(0.6, 5);
    expect(await num('id')).toBe(2);
    expect(await num('count')).toBe(3);
  });

  it('picks by id and falls back when missing', async () => {
    const { g, n } = await chain('region-info', { id: 3 });
    expect(((await g.eval(n, 0, 'x')) as number)).toBeCloseTo(0.625, 5);
    const miss = await chain('region-info', { id: 99, fallback: 0.5 });
    expect(await miss.g.eval(miss.n, 0, 'x')).toBe(0.5);
    expect(await miss.g.eval(miss.n, 0, 'count')).toBe(3);
  });
});
