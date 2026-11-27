import { describe, expect, it } from 'vitest';
import { assignEffects, matchesList } from '../../lib/region-fx-assign';
import { regionsSource } from '../../lib/track-testutil';
import { harness, type Harness } from '../../testing';
import type { ImageValue, MaskValue, Region } from '../../types';

const R = (id: number, box: [number, number, number, number], label = 'blob'): Region => ({ id, label, score: 0.9, box });
const ALL4 = [true, true, true, true] as const;
const AB = [true, true, false, false] as const;

describe('assignEffects (pure)', () => {
  const items = [R(30, [0.6, 0.1, 0.9, 0.4], 'car'), R(10, [0.1, 0.5, 0.2, 0.6], 'person'), R(20, [0.3, 0.2, 0.5, 0.5])];

  it('gives everything to A, or to the first wired effect', () => {
    expect(assignEffects(items, { mode: 'all', wired: ALL4 })).toEqual([0, 0, 0]);
    expect(assignEffects(items, { mode: 'all', wired: [false, false, true, false] })).toEqual([2, 2, 2]);
    expect(assignEffects(items, { mode: 'all', wired: [false, false, false, false] })).toEqual([-1, -1, -1]);
  });

  it('takes turns in order of id and skips unwired effects', () => {
    expect(assignEffects(items, { mode: 'cycle', wired: ALL4 })).toEqual([2, 0, 1]); // ids 10, 20, 30 -> A, B, C
    expect(assignEffects(items, { mode: 'cycle', wired: [true, false, true, false] })).toEqual([0, 0, 2]);
  });

  it('keeps a region on its effect when others appear later with higher ids', () => {
    const before = assignEffects(items, { mode: 'cycle', wired: AB });
    const more = [...items, R(99, [0, 0, 0.05, 0.05])];
    const after = assignEffects(more, { mode: 'cycle', wired: AB });
    expect(after.slice(0, 3)).toEqual(before);
  });

  it('does not depend on the order the regions arrive in', () => {
    const a = assignEffects(items, { mode: 'cycle', wired: ALL4 });
    const rev = [...items].reverse();
    const b = assignEffects(rev, { mode: 'cycle', wired: ALL4 }).reverse();
    expect(b).toEqual(a);
  });

  it('by size: largest gets A', () => {
    expect(assignEffects(items, { mode: 'size', wired: ALL4 })).toEqual([0, 2, 1]);
  });

  it('by position', () => {
    expect(assignEffects(items, { mode: 'left', wired: ALL4 })).toEqual([2, 0, 1]);
    expect(assignEffects(items, { mode: 'top', wired: ALL4 })).toEqual([0, 2, 1]);
  });

  it('by label or id; unmatched regions get nothing', () => {
    const labels = ['car', 'person, 20', '', ''] as const;
    expect(assignEffects(items, { mode: 'label', wired: ALL4, labels })).toEqual([0, 1, 1]);
    expect(assignEffects(items, { mode: 'label', wired: [false, true, false, false], labels })).toEqual([-1, 1, 1]);
    expect(matchesList(R(12, [0, 0, 1, 1], 'Big Person'), 'person')).toBe(true);
    expect(matchesList(R(12, [0, 0, 1, 1], 'blob 1'), '1')).toBe(false);
    expect(matchesList(R(12, [0, 0, 1, 1]), ' 12 ')).toBe(true);
  });

  it('random is stable per id and changes with the seed', () => {
    const r1 = assignEffects(items, { mode: 'random', wired: ALL4, seed: 3 });
    expect(assignEffects([items[1]], { mode: 'random', wired: ALL4, seed: 3 })[0]).toBe(r1[1]);
    expect(assignEffects([...items].reverse(), { mode: 'random', wired: ALL4, seed: 3 }).reverse()).toEqual(r1);
    const many = Array.from({ length: 40 }, (_, i) => R(i, [0, 0, 0.1, 0.1]));
    const s1 = assignEffects(many, { mode: 'random', wired: ALL4, seed: 1 });
    const s2 = assignEffects(many, { mode: 'random', wired: ALL4, seed: 2 });
    expect(s1).not.toEqual(s2);
    expect(new Set(s1).size).toBe(4);
  });
});

let list: Region[] = [];
const SIZE = 64;
const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const GREY: [number, number, number, number] = [100, 100, 100, 255];

async function setup() {
  const t = await harness([regionsSource('fx-test-regions', () => list)]);
  return { t, base: t.solid(SIZE, SIZE, GREY), a: t.solid(SIZE, SIZE, RED), b: t.solid(SIZE, SIZE, GREEN), c: t.solid(SIZE, SIZE, BLUE) };
}

async function fxRun(t: Harness, params: Record<string, unknown>, inputs: Record<string, unknown>) {
  const out = await t.run('region-fx', params, { regions: { node: 'fx-test-regions' }, ...inputs } as never);
  return out;
}
const rgb = (p: { at(x: number, y: number): number[] }, x: number, y: number) => Array.from(p.at(x, y)).slice(0, 3);

describe('region-fx (GPU)', () => {
  it('shows the original outside and the assigned effect inside; no regions = original', async () => {
    const { t, base, a, b } = await setup();
    list = [R(1, [0.1, 0.1, 0.4, 0.4]), R(2, [0.6, 0.6, 0.9, 0.9])];
    const px = await t.pixels((await fxRun(t, { give: 'cycle' }, { image: base, fx1: a, fx2: b })).image as ImageValue);
    expect(rgb(px, 16, 16)).toEqual([255, 0, 0]);
    expect(rgb(px, 48, 48)).toEqual([0, 255, 0]);
    expect(rgb(px, 32, 32)).toEqual([100, 100, 100]);
    expect(rgb(px, 5, 60)).toEqual([100, 100, 100]);
    list = [];
    const none = await t.pixels((await fxRun(t, { give: 'cycle' }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(none, 16, 16)).toEqual([100, 100, 100]);
  });

  it('works with unwired effects (only C wired, none wired)', async () => {
    const { t, base, c } = await setup();
    list = [R(1, [0.1, 0.1, 0.4, 0.4])];
    const px = await t.pixels((await fxRun(t, { give: 'all' }, { image: base, fx3: c })).image as ImageValue);
    expect(rgb(px, 16, 16)).toEqual([0, 0, 255]);
    const bare = await t.pixels((await fxRun(t, { give: 'all' }, { image: base })).image as ImageValue);
    expect(rgb(bare, 16, 16)).toEqual([100, 100, 100]);
  });

  it('the smallest region wins where regions overlap, whatever their order', async () => {
    const { t, base, a, b } = await setup();
    for (const order of [0, 1]) {
      const big = R(1, [0.1, 0.1, 0.9, 0.9]);
      const small = R(2, [0.4, 0.4, 0.6, 0.6]);
      list = order ? [small, big] : [big, small];
      // by size: the big one is A (red), the small one B (green)
      const px = await t.pixels((await fxRun(t, { give: 'size' }, { image: base, fx1: a, fx2: b })).image as ImageValue);
      expect(rgb(px, 32, 32)).toEqual([0, 255, 0]);
      expect(rgb(px, 16, 32)).toEqual([255, 0, 0]);
    }
  });

  it('an unassigned small region inside a big one shows the original', async () => {
    const { t, base, a } = await setup();
    list = [R(1, [0.1, 0.1, 0.9, 0.9], 'car'), R(2, [0.4, 0.4, 0.6, 0.6], 'person')];
    const px = await t.pixels((await fxRun(t, { give: 'label', labelsA: 'car' }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(px, 32, 32)).toEqual([100, 100, 100]);
    expect(rgb(px, 16, 32)).toEqual([255, 0, 0]);
  });

  it('ellipse and rounded shapes cut the corners', async () => {
    const { t, base, a } = await setup();
    list = [R(1, [0.1, 0.1, 0.9, 0.9])];
    const ell = await t.pixels((await fxRun(t, { shape: 'ellipse' }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(ell, 32, 32)).toEqual([255, 0, 0]);
    expect(rgb(ell, 9, 9)).toEqual([100, 100, 100]);
    const rr = await t.pixels((await fxRun(t, { shape: 'rounded', roundness: 0.5 }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(rr, 7, 7)).toEqual([100, 100, 100]);
    expect(rgb(rr, 32, 7)).toEqual([255, 0, 0]);
  });

  it('grow enlarges (and shrinks) the area; feather softens the edge', async () => {
    const { t, base, a } = await setup();
    list = [R(1, [0.25, 0.25, 0.75, 0.75])]; // 16..48
    const plain = await t.pixels((await fxRun(t, {}, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(plain, 12, 32)).toEqual([100, 100, 100]);
    const big = await t.pixels((await fxRun(t, { grow: 25 }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(big, 12, 32)).toEqual([255, 0, 0]); // 25% of 32 px = 8 px each side
    expect(rgb(big, 6, 32)).toEqual([100, 100, 100]);
    const small = await t.pixels((await fxRun(t, { grow: -25 }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(small, 20, 32)).toEqual([100, 100, 100]);
    expect(rgb(small, 32, 32)).toEqual([255, 0, 0]);
    const soft = await t.pixels((await fxRun(t, { feather: 12 }, { image: base, fx1: a })).image as ImageValue);
    const edge = soft.at(16, 32)[0];
    expect(edge).toBeGreaterThan(130);
    expect(edge).toBeLessThan(230);
    expect(rgb(soft, 32, 32)).toEqual([255, 0, 0]);
  });

  it('invert puts effect A outside and the original inside; mix blends', async () => {
    const { t, base, a } = await setup();
    list = [R(1, [0.25, 0.25, 0.75, 0.75])];
    const px = await t.pixels((await fxRun(t, { invert: true }, { image: base, fx1: a })).image as ImageValue);
    expect(rgb(px, 32, 32)).toEqual([100, 100, 100]);
    expect(rgb(px, 4, 4)).toEqual([255, 0, 0]);
    const half = await t.pixels((await fxRun(t, { amount: 0.5 }, { image: base, fx1: a })).image as ImageValue);
    expect(half.at(32, 32)[0]).toBeGreaterThan(170);
    expect(half.at(32, 32)[0]).toBeLessThan(190);
  });

  it('the mask output covers every affected area (and only assigned ones)', async () => {
    const { t, base, a } = await setup();
    list = [R(1, [0.1, 0.1, 0.4, 0.4], 'car'), R(2, [0.6, 0.6, 0.9, 0.9], 'person')];
    const out = await fxRun(t, { give: 'label', labelsA: 'car' }, { image: base, fx1: a });
    const m = await t.pixels(out.mask as MaskValue);
    expect(m.at(16, 16)[0]).toBe(255);
    expect(m.at(48, 48)[0]).toBe(0);
    expect(m.at(32, 32)[0]).toBe(0);
    const inv = await t.pixels((await fxRun(t, { invert: true }, { image: base, fx1: a })).mask as MaskValue);
    expect(inv.at(16, 16)[0]).toBe(0);
    expect(inv.at(32, 32)[0]).toBe(255);
  });

  it('a shape mask limits the effect to where it is white inside the box', async () => {
    const { t, base, a } = await setup();
    list = [R(1, [0.1, 0.1, 0.9, 0.9])];
    const matte = t.maskFn(SIZE, SIZE, (x) => (x < 32 ? 1 : 0));
    const px = await t.pixels((await fxRun(t, {}, { image: base, fx1: a, matte })).image as ImageValue);
    expect(rgb(px, 20, 32)).toEqual([255, 0, 0]);
    expect(rgb(px, 44, 32)).toEqual([100, 100, 100]);
    expect(rgb(px, 4, 32)).toEqual([100, 100, 100]); // white mask but outside the box
  });

  it('handles 64 regions in one pass, each with its own effect', async () => {
    const { t, base, a, b, c } = await setup();
    const big = 256;
    const img = t.solid(big, big, GREY);
    list = Array.from({ length: 64 }, (_, i) => {
      const cx = (i % 8) / 8, cy = Math.floor(i / 8) / 8;
      return R(i + 1, [cx + 0.01, cy + 0.01, cx + 0.115, cy + 0.115]);
    });
    void base; void a; void b;
    const fa = t.solid(big, big, RED), fb = t.solid(big, big, GREEN), fc = t.solid(big, big, BLUE);
    const px = await t.pixels((await fxRun(t, { give: 'cycle' }, { image: img, fx1: fa, fx2: fb, fx3: fc })).image as ImageValue);
    for (let i = 0; i < 64; i++) {
      const x = Math.round(((i % 8) / 8 + 0.06) * big), y = Math.round((Math.floor(i / 8) / 8 + 0.06) * big);
      const want = [RED, GREEN, BLUE][i % 3].slice(0, 3);
      expect(rgb(px, x, y), `region ${i}`).toEqual(want);
    }
    void c;
  });

  it('effect pictures of another size are stretched over the frame', async () => {
    const { t, base } = await setup();
    list = [R(1, [0.5, 0, 1, 1])];
    const small = t.fromFn(2, 2, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const px = await t.pixels((await fxRun(t, {}, { image: base, fx1: small })).image as ImageValue);
    expect(rgb(px, 40, 30)).toEqual([0, 255, 0]);
    expect(rgb(px, 20, 30)).toEqual([100, 100, 100]);
  });
});
