import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const off = { dither: 0, xorR: 0, xorG: 0, xorB: 0, rotate: 0, swap: 'none' };

describe('bit-crush', () => {
  it('limits each channel to its own number of levels', async () => {
    const t = await harness();
    const src = t.fromFn(64, 1, (x) => [x * 4, x * 4, x * 4, 255]);
    const px = await t.pixels((await t.run('bit-crush', { ...off, bitsR: 1, bitsG: 2, bitsB: 8 }, { image: src })).image as never);
    const distinct = (ch: number) => new Set(Array.from({ length: 64 }, (_, x) => px.at(x, 0)[ch])).size;
    expect(distinct(0)).toBe(2);
    expect(distinct(1)).toBe(4);
    expect(distinct(2)).toBeGreaterThan(40);
  });

  it('dither noise spreads the bands so the average brightness survives', async () => {
    const t = await harness();
    const src = t.solid(32, 32, [100, 100, 100, 255]);
    const hard = await t.pixels((await t.run('bit-crush', { ...off, bitsR: 1, bitsG: 1, bitsB: 1 }, { image: src })).image as never);
    expect(new Set([hard.at(3, 3)[0], hard.at(10, 20)[0]]).size).toBe(1);
    for (const ditherKind of ['bayer', 'white']) {
      const d = await t.pixels((await t.run('bit-crush', { ...off, bitsR: 1, bitsG: 1, bitsB: 1, dither: 1, ditherKind }, { image: src })).image as never);
      let sum = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) sum += d.at(x, y)[0];
      expect(sum / 1024, ditherKind).toBeGreaterThan(70);
      expect(sum / 1024, ditherKind).toBeLessThan(130);
    }
  });

  it('XOR flips bits exactly, rotate rolls them, swap reorders channels', async () => {
    const t = await harness();
    const src = t.solid(4, 4, [200, 100, 50, 255]);
    const full = { ...off, bitsR: 8, bitsG: 8, bitsB: 8 };
    const x = await t.pixels((await t.run('bit-crush', { ...full, xorR: 255, xorG: 15 }, { image: src })).image as never);
    expect(x.at(1, 1).slice(0, 3)).toEqual([200 ^ 255, 100 ^ 15, 50]);
    const r = await t.pixels((await t.run('bit-crush', { ...full, rotate: 1 }, { image: src })).image as never);
    expect(r.at(1, 1).slice(0, 3)).toEqual([((200 << 1) | (200 >> 7)) & 255, ((100 << 1) | (100 >> 7)) & 255, ((50 << 1) | (50 >> 7)) & 255]);
    const s = await t.pixels((await t.run('bit-crush', { ...full, swap: 'bgr' }, { image: src })).image as never);
    expect(s.at(1, 1).slice(0, 3)).toEqual([50, 100, 200]);
  });

  it('keeps alpha, and full depth with nothing else is a no-op', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('bit-crush', {}, { image: t.solid(4, 4, [200, 100, 50, 128]) })).image as never);
    expect(px.at(1, 1)[3]).toBe(128);
    const src = t.solid(4, 4, [1, 2, 3, 255]);
    expect((await t.run('bit-crush', { ...off, bitsR: 8, bitsG: 8, bitsB: 8 }, { image: src })).image).toBe(src);
  });
});
