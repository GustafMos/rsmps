import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

const GREEN: [number, number, number, number] = [0, 178, 64, 255];

describe('keying nodes', () => {
  it('key-color removes the key colour, keeps the subject, soft transition', async () => {
    const t = await harness();
    // Left: green screen. Right: red subject. Between: a ramp from green to red (soft edge).
    const img = t.fromFn(64, 64, (x) => (x < 24 ? GREEN : x >= 40 ? [200, 60, 50, 255] : [(x - 24) * 12, 178 - (x - 24) * 7, 64 - (x - 24), 255]));
    const px = await t.pixels((await t.run('key-color', { key: [0, 0.698, 0.251, 1], tolerance: 0.05, softness: 0.3 }, { image: img })).mask as never);
    expect(px.at(5, 5)[0]).toBe(0);
    expect(px.at(50, 5)[0]).toBeGreaterThan(240);
    const ramp = Array.from({ length: 16 }, (_, i) => px.at(24 + i, 5)[0]);
    expect(ramp.some((v) => v > 20 && v < 235)).toBe(true); // the transition is soft
    expect(ramp[15]).toBeGreaterThanOrEqual(ramp[0]); // and monotonic overall
    const inv = await t.pixels((await t.run('key-color', { key: [0, 0.698, 0.251, 1], invert: true }, { image: img })).mask as never);
    expect(inv.at(5, 5)[0]).toBe(255);
    expect(inv.at(50, 5)[0]).toBe(0);
  });

  it('key-color respects alpha', async () => {
    const t = await harness();
    const img = t.fromFn(16, 16, (x) => (x < 8 ? [200, 60, 50, 0] : [200, 60, 50, 255]));
    const px = await t.pixels((await t.run('key-color', {}, { image: img })).mask as never);
    expect(px.at(2, 2)[0]).toBe(0);
    expect(px.at(12, 2)[0]).toBe(255);
  });

  it('key-luma selects a brightness band', async () => {
    const t = await harness();
    const img = t.fromFn(64, 8, (x) => [x * 4, x * 4, x * 4, 255]);
    const px = await t.pixels((await t.run('key-luma', { low: 0.4, high: 0.7, softness: 0.02 }, { image: img })).mask as never);
    expect(px.at(10, 0)[0]).toBe(0); // dark
    expect(px.at(35, 0)[0]).toBe(255); // mid
    expect(px.at(60, 0)[0]).toBe(0); // bright
    const inv = await t.pixels((await t.run('key-luma', { low: 0.4, high: 0.7, softness: 0.02, invert: true }, { image: img })).mask as never);
    expect(inv.at(10, 0)[0]).toBe(255);
  });

  it('color-range selects by hue with tolerance', async () => {
    const t = await harness();
    const img = t.fromFn(48, 8, (x) => (x < 16 ? [230, 40, 40, 255] : x < 32 ? [235, 90, 60, 255] : [40, 60, 230, 255]));
    const px = await t.pixels((await t.run('color-range', { color: [0.9, 0.15, 0.15, 1], hue: 25 }, { image: img })).mask as never);
    expect(px.at(5, 0)[0]).toBeGreaterThan(240); // red
    expect(px.at(24, 0)[0]).toBeGreaterThan(100); // orange-red, inside tolerance
    expect(px.at(40, 0)[0]).toBe(0); // blue
    const inv = await t.pixels((await t.run('color-range', { color: [0.9, 0.15, 0.15, 1], hue: 25, invert: true }, { image: img })).mask as never);
    expect(inv.at(40, 0)[0]).toBe(255);
  });

  it('despill removes a green cast but keeps neutral and unrelated colours', async () => {
    const t = await harness();
    const img = t.fromFn(8, 8, (x) => (x < 2 ? [150, 190, 140, 255] : x < 4 ? [128, 128, 128, 255] : x < 6 ? [200, 60, 50, 255] : [100, 100, 220, 255]));
    const px = await t.pixels((await t.run('despill', { key: [0, 0.7, 0.25, 1], keepLuma: 0 }, { image: img })).image as never);
    const spill = px.at(0, 0);
    expect(spill[1]).toBeLessThanOrEqual(150); // g limited to avg(r, b) = 145
    expect(spill[1]).toBeGreaterThan(140);
    expect(px.at(2, 0).slice(0, 3)).toEqual([128, 128, 128]);
    expect(px.at(4, 0).slice(0, 3)).toEqual([200, 60, 50]);
    expect(px.at(6, 0).slice(0, 3)).toEqual([100, 100, 220]);
    const lit = await t.pixels((await t.run('despill', { key: [0, 0.7, 0.25, 1], keepLuma: 1 }, { image: img })).image as never);
    expect(lit.at(0, 0)[0]).toBeGreaterThan(spill[0]); // keepLuma adds brightness back
  });
});
