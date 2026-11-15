import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

const square = (x: number, y: number) => (x >= 24 && x < 40 && y >= 24 && y < 40 ? 1 : 0);

describe('mask operations', () => {
  it('mask-invert flips coverage', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('mask-invert', {}, { mask: t.maskFn(64, 64, square) })).mask as never);
    expect(px.at(30, 30)[0]).toBe(0);
    expect(px.at(2, 2)[0]).toBe(255);
  });

  it('mask-grow dilates by a round distance and erodes', async () => {
    const t = await harness();
    const m = t.maskFn(64, 64, square);
    const g = await t.pixels((await t.run('mask-grow', { amount: 5 }, { mask: m })).mask as never);
    expect(g.at(20, 32)[0]).toBe(255); // 4px outside the left edge
    expect(g.at(17, 32)[0]).toBe(0); // 7px outside
    expect(g.at(18, 18)[0]).toBe(0); // round: the diagonal corner is farther than 5px
    const s = await t.pixels((await t.run('mask-grow', { amount: 5, shape: 'square' }, { mask: m })).mask as never);
    expect(s.at(20, 20)[0]).toBe(255); // square keeps the corner
    const e = await t.pixels((await t.run('mask-grow', { amount: -3 }, { mask: m })).mask as never);
    expect(e.at(25, 32)[0]).toBe(0);
    expect(e.at(32, 32)[0]).toBe(255);
  });

  it('mask-grow is resolution independent (2x, unit 2)', async () => {
    const t = await harness();
    const a = await t.pixels((await t.run('mask-grow', { amount: 4 }, { mask: t.maskFn(64, 64, square, 1) })).mask as never);
    const b = await t.pixels((await t.run('mask-grow', { amount: 4 }, { mask: t.maskFn(128, 128, (x, y) => square(x >> 1, y >> 1), 2) })).mask as never);
    expect(a.at(21, 32)[0]).toBe(255);
    expect(b.at(42, 64)[0]).toBe(255);
    expect(a.at(18, 32)[0]).toBe(0);
    expect(b.at(36, 64)[0]).toBe(0);
  });

  it('mask-feather blurs the edge', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('mask-feather', { radius: 6 }, { mask: t.maskFn(64, 64, square) })).mask as never);
    expect(px.at(24, 32)[0]).toBeGreaterThan(60);
    expect(px.at(24, 32)[0]).toBeLessThan(200);
    expect(px.at(32, 32)[0]).toBeGreaterThan(240);
    expect(px.at(5, 5)[0]).toBe(0);
  });

  it('mask-combine implements the boolean operations', async () => {
    const t = await harness();
    const a = t.maskFn(8, 8, (x) => (x < 5 ? 1 : 0));
    const b = t.maskFn(8, 8, (x) => (x >= 3 ? 1 : 0));
    const op = async (name: string) => t.pixels((await t.run('mask-combine', { op: name }, { a, b })).mask as never);
    const u = await op('union');
    expect([u.at(0, 0)[0], u.at(7, 0)[0]]).toEqual([255, 255]);
    const i = await op('intersect');
    expect([i.at(0, 0)[0], i.at(4, 0)[0], i.at(7, 0)[0]]).toEqual([0, 255, 0]);
    const s = await op('subtract');
    expect([s.at(0, 0)[0], s.at(4, 0)[0]]).toEqual([255, 0]);
    const d = await op('difference');
    expect([d.at(0, 0)[0], d.at(4, 0)[0], d.at(7, 0)[0]]).toEqual([255, 0, 255]);
    const passthrough = await t.pixels((await t.run('mask-combine', {}, { a })).mask as never);
    expect(passthrough.at(1, 1)[0]).toBe(255);
  });

  it('mask-levels adjusts contrast and thresholds', async () => {
    const t = await harness();
    const ramp = t.maskFn(64, 4, (x) => x / 63);
    const lv = await t.pixels((await t.run('mask-levels', { black: 0.25, white: 0.75 }, { mask: ramp })).mask as never);
    expect(lv.at(8, 0)[0]).toBe(0);
    expect(lv.at(56, 0)[0]).toBe(255);
    expect(lv.at(32, 0)[0]).toBeGreaterThan(110);
    const th = await t.pixels((await t.run('mask-levels', { mode: 'threshold', threshold: 0.5 }, { mask: ramp })).mask as never);
    expect(th.at(20, 0)[0]).toBe(0);
    expect(th.at(44, 0)[0]).toBe(255);
  });
});

describe('length params follow the image unit', () => {
  it('mask-feather gives the same softness at 2x resolution', async () => {
    const t = await harness();
    const a = await t.pixels((await t.run('mask-feather', { radius: 4 }, { mask: t.maskFn(64, 64, square, 1) })).mask as never);
    const b = await t.pixels((await t.run('mask-feather', { radius: 4 }, { mask: t.maskFn(128, 128, (x, y) => square(x >> 1, y >> 1), 2) })).mask as never);
    expect(Math.abs(a.at(24, 32)[0] - b.at(48, 64)[0])).toBeLessThan(25);
    expect(a.at(24, 32)[0]).toBeGreaterThan(40);
  });
});
