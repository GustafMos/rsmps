import { describe, expect, it } from 'vitest';
import { seamRatio } from '../../lib/copy-testutil';
import { harness } from '../../testing';

/** A ring logo: an opaque border 6 px wide around a transparent hole (the next copy fits inside). */
const ring = (t: Awaited<ReturnType<typeof harness>>, size = 32, border = 6) =>
  t.fromFn(size, size, (x, y) => {
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    return edge < border ? [20, 20, 20, 255] : [0, 0, 0, 0];
  });

describe('infinite-zoom', () => {
  it('shows a smaller copy of the picture inside the hole', async () => {
    const t = await harness();
    const src = ring(t);
    // scale 0.5 about the middle: the nested frame spans 8..24, so its border sits at x 8..10 (3 px wide)
    const deep = await t.pixels((await t.run('infinite-zoom', { scale: 0.5, levels: 1 }, { image: src })).image as never);
    expect(deep.at(9, 16)[3]).toBe(255);
    expect(deep.at(13, 16)[3]).toBe(0);
    const flat = await t.pixels((await t.run('infinite-zoom', { scale: 0.5, levels: 0 }, { image: src })).image as never);
    expect(flat.at(9, 16)[3]).toBe(0); // only the outer picture
    expect(flat.at(2, 16)[3]).toBe(255);
  });

  it('the nested copy goes where Centre says', async () => {
    const t = await harness();
    const src = ring(t, 32, 4);
    const out = await t.pixels((await t.run('infinite-zoom', { scale: 0.4, centre: [0.65, 0.5], levels: 1 }, { image: src })).image as never);
    // nested frame: width 12.8 centred on x = 20.8 -> 14.4 .. 27.2, its left border starts at 14.4
    expect(out.at(15, 16)[3]).toBe(255);
    expect(out.at(11, 16)[3]).toBe(0);
  });

  it('recolours each level with the next palette colour, keeping the shape', async () => {
    const t = await harness();
    const src = ring(t);
    const out = await t.pixels(
      (
        await t.run(
          'infinite-zoom',
          { scale: 0.5, levels: 3, recolor: 'fill', palette: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
          { image: src },
        )
      ).image as never,
    );
    expect(out.at(2, 16)).toEqual([255, 0, 0, 255]); // level 0: first colour
    expect(out.at(9, 16)).toEqual([0, 255, 0, 255]); // level 1: second colour
    // level 2: nested again by 0.5 -> frame 12..20, border 12..13.5
    expect(out.at(12, 16)).toEqual([0, 0, 255, 255]);
  });

  it('falls a whole number of levels per loop with no seam, for a picture that does not fit its hole too', async () => {
    const t = await harness();
    for (const src of [ring(t), t.fromFn(32, 32, (x, y) => [x * 8, y * 8, 120, 255])]) {
      const r = await seamRatio(t, 'infinite-zoom', { scale: 0.4, levels: 6, speed: 1, rotatePerLevel: 20, centre: [0.55, 0.45] }, { image: src });
      expect(r.wrap).toBeLessThan(r.max * 1.3 + 0.5);
      expect(r.motion).toBeGreaterThan(0.5);
    }
  });

  it('loops with spiral twist and with colours (palette length divides the speed, or colours flow)', async () => {
    const t = await harness();
    const src = ring(t);
    const base = { scale: 0.45, levels: 6, recolor: 'fill', palette: [[1, 0, 0], [0, 0, 1]] };
    const a = await seamRatio(t, 'infinite-zoom', { ...base, speed: 2, spiral: 1 }, { image: src });
    expect(a.wrap).toBeLessThan(a.max * 1.3 + 0.5);
    expect(a.motion).toBeGreaterThan(0.5);
    const b = await seamRatio(t, 'infinite-zoom', { ...base, speed: 1, attached: false }, { image: src });
    expect(b.wrap).toBeLessThan(b.max * 1.3 + 0.5);
    const c = await seamRatio(t, 'infinite-zoom', { ...base, speed: 1, attached: true }, { image: src });
    expect(c.wrap).toBeGreaterThan(c.max * 2); // attached colours shift by one palette step after one level: not a loop of 1
  });

  it('is still by default', async () => {
    const t = await harness();
    const r = await t.loopCheck('infinite-zoom', { levels: 4 }, { image: ring(t) });
    expect(r.motion).toBe(0);
  });

  it('inner picture replaces the picture for the nested levels', async () => {
    const t = await harness();
    const src = ring(t);
    const inner = t.fromFn(32, 32, () => [0, 255, 0, 255]);
    const out = await t.pixels((await t.run('infinite-zoom', { scale: 0.5, levels: 2 }, { image: src, inner })).image as never);
    expect(out.at(2, 16)).toEqual([20, 20, 20, 255]);
    expect(out.at(16, 16)).toEqual([0, 255, 0, 255]);
  });

  it('one pass, no new shader when numbers move', async () => {
    const t = await harness();
    const src = ring(t);
    await t.run('infinite-zoom', { levels: 4 }, { image: src });
    const s0 = t.gpu.stats().objects;
    await t.run('infinite-zoom', { levels: 20, scale: 0.61, spiral: 0.7, rotatePerLevel: 33, speed: 3 }, { image: src }, { seconds: 0.4 });
    const s1 = t.gpu.stats().objects;
    expect(s1.submits - s0.submits).toBe(1);
    expect(s1.pipelinesCreated - s0.pipelinesCreated).toBe(0);
  });
});
