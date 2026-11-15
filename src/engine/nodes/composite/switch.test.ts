import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('switch', () => {
  it('picks by index, wrapping in both directions', async () => {
    const t = await harness();
    const imgs = [t.solid(2, 2, [10, 0, 0, 255]), t.solid(2, 2, [20, 0, 0, 255]), t.solid(2, 2, [30, 0, 0, 255])];
    const pick = async (index: number) => (await t.pixels((await t.run('switch', { index }, { images: imgs })).image as never)).at(0, 0)[0];
    expect(await pick(0)).toBe(10);
    expect(await pick(1)).toBe(20);
    expect(await pick(4)).toBe(20);
    expect(await pick(-1)).toBe(30);
  });

  it('takes the index from a wired number and passes images through untouched', async () => {
    const t = await harness();
    const imgs = [t.solid(2, 2, [10, 0, 0, 255]), t.solid(3, 3, [20, 0, 0, 255])];
    const out = await t.run('switch', {}, { images: imgs, index: 1 });
    expect(out.image).toBe(imgs[1]);
  });

  it('returns nothing when there are no images', async () => {
    const t = await harness();
    expect((await t.run('switch', {}, {})).image).toBeNull();
  });
});
