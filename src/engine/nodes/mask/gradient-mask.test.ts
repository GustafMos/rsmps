import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

describe('gradient-mask', () => {
  it('linear ramp between two points', async () => {
    const t = await harness();
    const ref = t.solid(64, 64, [0, 0, 0, 255]);
    const px = await t.pixels((await t.run('gradient-mask', { kind: 'linear', from: [0.25, 0.5], to: [0.75, 0.5] }, { reference: ref })).mask as never);
    expect(px.at(4, 30)[0]).toBe(0);
    expect(px.at(32, 30)[0]).toBeGreaterThan(115);
    expect(px.at(32, 30)[0]).toBeLessThan(140);
    expect(px.at(60, 30)[0]).toBe(255);
  });

  it('radial, mirrored and invert', async () => {
    const t = await harness();
    const ref = t.solid(64, 64, [0, 0, 0, 255]);
    const rad = await t.pixels((await t.run('gradient-mask', { kind: 'radial', from: [0.5, 0.5], to: [1, 0.5] }, { reference: ref })).mask as never);
    expect(rad.at(32, 32)[0]).toBeLessThan(10);
    expect(rad.at(2, 2)[0]).toBe(255);
    const mir = await t.pixels((await t.run('gradient-mask', { kind: 'reflected', from: [0.5, 0.5], to: [1, 0.5] }, { reference: ref })).mask as never);
    expect(Math.abs(mir.at(16, 10)[0] - mir.at(48, 10)[0])).toBeLessThan(10);
    const inv = await t.pixels((await t.run('gradient-mask', { kind: 'radial', from: [0.5, 0.5], to: [1, 0.5], invert: true }, { reference: ref })).mask as never);
    expect(inv.at(32, 32)[0]).toBeGreaterThan(245);
  });
});
