import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { wholeCyclePoses } from '../../lib/boil';

const speckle = (x: number, y: number): [number, number, number, number] => {
  const v = 150 + (((x * 7 + y * 13) % 5) * 20);
  return [v, v, v, 255];
};

describe('paper-texture', () => {
  it('multiply darkens by the texture, screen lightens, amount 0 is a pass-through', async () => {
    const t = await harness();
    const img = t.solid(32, 32, [200, 200, 200, 255]);
    const tex = t.fromFn(16, 16, () => [128, 128, 128, 255]);
    const mul = await t.pixels((await t.run('paper-texture', { blend: 'multiply', amount: 1 }, { image: img, texture: tex })).image as never);
    expect(mul.at(10, 10)[0]).toBeGreaterThan(95);
    expect(mul.at(10, 10)[0]).toBeLessThan(105);
    const scr = await t.pixels((await t.run('paper-texture', { blend: 'screen', amount: 1 }, { image: img, texture: tex })).image as never);
    expect(scr.at(10, 10)[0]).toBeGreaterThan(225);
    const off = await t.run('paper-texture', { amount: 0 }, { image: img, texture: tex });
    expect(off.image).toBe(img);
  });

  it('overlay keeps mid grey and pushes contrast; alpha survives', async () => {
    const t = await harness();
    const img = t.fromFn(16, 16, (x) => (x < 8 ? [60, 60, 60, 255] : [200, 200, 200, 128]));
    const tex = t.fromFn(8, 8, () => [180, 180, 180, 255]);
    const px = await t.pixels((await t.run('paper-texture', { blend: 'overlay', amount: 1 }, { image: img, texture: tex })).image as never);
    expect(px.at(2, 2)[0]).toBeGreaterThan(60); // dark base lightened by a light overlay
    expect(Math.abs(px.at(12, 2)[3] - 128)).toBeLessThan(3);
  });

  it('scale repeats the texture', async () => {
    const t = await harness();
    const img = t.solid(64, 64, [255, 255, 255, 255]);
    const tex = t.fromFn(32, 32, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const one = await t.pixels((await t.run('paper-texture', { amount: 1, scale: 1 }, { image: img, texture: tex })).image as never);
    const four = await t.pixels((await t.run('paper-texture', { amount: 1, scale: 4 }, { image: img, texture: tex })).image as never);
    const stripes = (p: { at(x: number, y: number): number[] }) => {
      let n = 0;
      for (let x = 1; x < 64; x++) if (Math.abs(p.at(x, 5)[0] - p.at(x - 1, 5)[0]) > 40) n++;
      return n;
    };
    expect(stripes(four)).toBeGreaterThan(stripes(one) + 3);
  });

  it('boil moves the texture between poses and repeats in whole cycles', async () => {
    const t = await harness();
    const img = t.solid(48, 48, [230, 230, 230, 255]);
    const tex = t.fromFn(48, 48, speckle);
    const params = { amount: 1, boil: 0.1, boilPoses: 3 };
    const project = { fps: 12, duration: 1, loop: true };
    const f = async (frame: number) => (await t.run('paper-texture', params, { image: img, texture: tex }, { seconds: frame / 12, project })).image as never;
    const a = await f(0);
    const b = await f(1);
    const c = await f(3); // same pose as frame 0 (3 poses divide the 12-frame loop)
    expect(await t.diff(a, b)).toBeGreaterThan(1);
    expect(await t.diff(a, c)).toBeLessThan(0.01);
    const still = await t.loopCheck('paper-texture', { amount: 1, boil: 0.1, boilPoses: 4 }, { image: img, texture: tex });
    expect(still.seam).toBeLessThan(0.01);
    expect(still.motion).toBeGreaterThan(0);
  });

  it('wholeCyclePoses reduces the pose count to a divisor of the loop', () => {
    expect(wholeCyclePoses(24, 5)).toBe(4);
    expect(wholeCyclePoses(24, 12)).toBe(12);
    expect(wholeCyclePoses(13, 5)).toBe(1);
    expect(wholeCyclePoses(7, 7)).toBe(7);
  });
});
