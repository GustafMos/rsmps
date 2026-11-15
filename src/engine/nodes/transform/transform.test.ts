import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const grad = (t: Awaited<ReturnType<typeof harness>>, size = 8) => t.fromFn(size, size, (x, y) => [x * 30, y * 30, 0, 255]);

describe('transform', () => {
  it('moves the image and leaves transparent space behind', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const out = await t.run('transform', { translate: [0.5, 0], filter: 'nearest' }, { image: src });
    const px = await t.pixels(out.image as never);
    expect([px.width, px.height]).toEqual([8, 8]);
    expect(px.at(1, 3)[3]).toBe(0);
    expect(px.at(5, 3)).toEqual([255, 0, 0, 255]);
    expect(px.at(7, 3)).toEqual([255, 0, 0, 255]);
  });

  it('rotates 180 degrees about the centre', async () => {
    const t = await harness();
    const out = await t.run('transform', { rotate: 180, filter: 'nearest' }, { image: grad(t) });
    const px = await t.pixels(out.image as never);
    expect(px.at(0, 0)).toEqual([210, 210, 0, 255]);
    expect(px.at(7, 7)).toEqual([0, 0, 0, 255]);
  });

  it('scales about the pivot', async () => {
    const t = await harness();
    const out = await t.run('transform', { scale: 2, filter: 'nearest' }, { image: grad(t) });
    const px = await t.pixels(out.image as never);
    expect(px.at(0, 4)[0]).toBe(60);
    expect(px.at(7, 4)[0]).toBe(150);
    // pivot in the top-left corner keeps that corner fixed
    const corner = await t.run('transform', { scale: 2, pivot: [0, 0], filter: 'nearest' }, { image: grad(t) });
    const cp = await t.pixels(corner.image as never);
    expect(cp.at(0, 0)[0]).toBe(0);
    expect(cp.at(7, 0)[0]).toBe(90);
  });

  it('handles the four edge modes', async () => {
    const t = await harness();
    const run = async (edge: string) => {
      const out = await t.run('transform', { translate: [0.25, 0], edge, filter: 'nearest' }, { image: grad(t) });
      return (await t.pixels(out.image as never)).at(0, 0);
    };
    expect((await run('transparent'))[3]).toBe(0);
    expect((await run('clamp'))[0]).toBe(0);
    expect((await run('wrap'))[0]).toBe(180);
    expect((await run('mirror'))[0]).toBe(30);
  });

  it('keeps transparency and partial alpha', async () => {
    const t = await harness();
    const half = t.solid(8, 8, [200, 100, 50, 128]);
    const out = await t.run('transform', { rotate: 90, filter: 'nearest' }, { image: half });
    const px = await t.pixels(out.image as never);
    expect(Math.abs(px.at(4, 4)[3] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(px.at(4, 4)[0] - 200)).toBeLessThanOrEqual(2);
    const clear = await t.run('transform', { rotate: 33 }, { image: t.solid(8, 8, [0, 0, 0, 0]) });
    expect((await t.pixels(clear.image as never)).at(4, 4)[3]).toBe(0);
  });

  it('is a no-op at defaults and independent of resolution', async () => {
    const t = await harness();
    const src = grad(t);
    const same = await t.run('transform', {}, { image: src });
    expect(same.image).toBe(src);
    const big = t.fromFn(16, 16, (x) => (x < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255]), 2);
    const out = await t.run('transform', { translate: [0.5, 0], filter: 'nearest' }, { image: big });
    const px = await t.pixels(out.image as never);
    expect(px.at(2, 3)[3]).toBe(0);
    expect(px.at(10, 3)).toEqual([255, 0, 0, 255]);
  });
});
