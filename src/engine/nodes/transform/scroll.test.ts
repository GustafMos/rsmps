import { describe, expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';

describe('scroll', () => {
  it('wraps a static offset around the edges', async () => {
    const t = await harness();
    const src = t.fromFn(8, 2, (x) => [x * 30, 0, 0, 255]);
    const out = await t.pixels((await t.run('scroll', { cyclesX: 0, offset: [0.25, 0], filter: 'nearest' }, { image: src })).image as never);
    expect(out.at(2, 0)[0]).toBe(0);
    expect(out.at(0, 0)[0]).toBe(180);
    expect(out.at(1, 1)[0]).toBe(210);
  });

  it('loops seamlessly and moves', async () => {
    const t = await harness();
    const src = t.fromFn(16, 16, (x, y) => [x * 15, y * 15, 0, 255]);
    const r = await t.loopCheck('scroll', { cyclesX: 1, filter: 'nearest' }, { image: src });
    expect(r.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(r.motion).toBeGreaterThan(1);
    const v = await t.loopCheck('scroll', { cyclesX: 0, cyclesY: -1, filter: 'linear' }, { image: src });
    expect(v.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(v.motion).toBeGreaterThan(0);
  });

  it('travels exactly one image width per loop for 1 cycle', async () => {
    const t = await harness();
    const src = t.fromFn(8, 2, (x) => [x * 30, 0, 0, 255]);
    const project = { fps: 8, duration: 1, loop: true };
    const at = async (s: number) => (await t.pixels((await t.run('scroll', { cyclesX: 1, filter: 'nearest' }, { image: src }, { seconds: s, project })).image as never)).at(0, 0)[0];
    expect(await at(0)).toBe(0);
    expect(await at(0.25)).toBe(180); // moved 2 texels right: texel 0 now shows source texel 6
    expect(await at(0.5)).toBe(120);
  });

  it('keeps alpha and is a no-op when still', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => [255, 0, 0, x < 4 ? 0 : 255]);
    expect((await t.run('scroll', { cyclesX: 0, cyclesY: 0 }, { image: src })).image).toBe(src);
    const out = await t.pixels((await t.run('scroll', { cyclesX: 0, offset: [0.5, 0], filter: 'nearest' }, { image: src })).image as never);
    expect(out.at(1, 0)[3]).toBe(255);
    expect(out.at(5, 0)[3]).toBe(0);
  });
});
