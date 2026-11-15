import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

describe('shape-mask', () => {
  it('draws a centred rectangle on the reference size', async () => {
    const t = await harness();
    const ref = t.solid(64, 32, [0, 0, 0, 255]);
    const px = await t.pixels((await t.run('shape-mask', { shape: 'rectangle', size: [0.5, 0.5] }, { reference: ref })).mask as never);
    expect([px.width, px.height]).toEqual([64, 32]);
    expect(px.at(32, 16)[0]).toBe(255);
    expect(px.at(2, 2)[0]).toBe(0);
    expect(px.at(32, 2)[0]).toBe(0);
  });

  it('ellipse, rotation, feather and invert', async () => {
    const t = await harness();
    const ref = t.solid(64, 64, [0, 0, 0, 255]);
    const ell = await t.pixels((await t.run('shape-mask', { shape: 'ellipse', size: [0.8, 0.4] }, { reference: ref })).mask as never);
    expect(ell.at(32, 32)[0]).toBe(255);
    expect(ell.at(10, 32)[0]).toBeGreaterThan(200); // inside the wide axis
    expect(ell.at(32, 12)[0]).toBe(0); // outside the short axis
    const rot = await t.pixels((await t.run('shape-mask', { shape: 'ellipse', size: [0.8, 0.4], rotation: 90 }, { reference: ref })).mask as never);
    expect(rot.at(10, 32)[0]).toBe(0);
    expect(rot.at(32, 10)[0]).toBeGreaterThan(200);
    const soft = await t.pixels((await t.run('shape-mask', { shape: 'rectangle', size: [0.5, 0.5], feather: 8 }, { reference: ref })).mask as never);
    expect(soft.at(16, 32)[0]).toBeGreaterThan(80); // edge pixel is partly covered
    expect(soft.at(16, 32)[0]).toBeLessThan(180);
    const inv = await t.pixels((await t.run('shape-mask', { size: [0.5, 0.5], invert: true }, { reference: ref })).mask as never);
    expect(inv.at(32, 32)[0]).toBe(0);
    expect(inv.at(2, 2)[0]).toBe(255);
  });

  it('feather length scales with the image unit', async () => {
    const t = await harness();
    const a = await t.pixels((await t.run('shape-mask', { size: [0.5, 0.5], feather: 8 }, { reference: t.solid(64, 64, [0, 0, 0, 255], 1) })).mask as never);
    const b = await t.pixels((await t.run('shape-mask', { size: [0.5, 0.5], feather: 8 }, { reference: t.solid(128, 128, [0, 0, 0, 255], 2) })).mask as never);
    expect(Math.abs(a.at(16, 32)[0] - b.at(32, 64)[0])).toBeLessThan(20);
  });
});
