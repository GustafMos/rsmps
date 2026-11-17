import { describe, expect, it } from 'vitest';
import { seamRatio } from '../../lib/copy-testutil';
import { LOOP_SEAM_OK, harness } from '../../testing';
import kaleidoscope, { kaleidoscopeLoop } from './kaleidoscope.node';

describe('kaleidoscope', () => {
  it('2 segments fold the picture up/down about the horizontal axis through the centre', async () => {
    const t = await harness();
    const src = t.fromFn(32, 32, (x, y) => [x * 8, y * 8, 60, 255]);
    const out = await t.pixels((await t.run('kaleidoscope', { mode: 'kaleidoscope', segments: 2 }, { image: src })).image as never);
    for (const [x, y] of [[5, 6], [20, 9], [27, 12]]) {
      const a = out.at(x, y);
      const b = out.at(x, 31 - y);
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeLessThanOrEqual(24);
    }
  });

  it('mirror tiles reflect at the picture edge', async () => {
    const t = await harness();
    const src = t.fromFn(8, 2, (x) => [x * 30, 0, 0, 255]);
    const out = await t.pixels((await t.run('kaleidoscope', { mode: 'mirror', centre: [0.5, 0.5], source: [1, 0.5] }, { image: src })).image as never);
    // the frame's middle reads the picture's right edge (source x = 8): to its left the ramp goes down, to its right it mirrors back down
    expect(out.at(4, 0)[0]).toBeGreaterThan(180);
    expect(Math.abs(out.at(2, 0)[0] - out.at(6, 0)[0])).toBeLessThanOrEqual(35);
    expect(out.at(4, 0)[3]).toBe(255);
  });

  it('polar wraps the picture around the centre', async () => {
    const t = await harness();
    const src = t.fromFn(32, 32, (x) => (x < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const out = await t.pixels((await t.run('kaleidoscope', { mode: 'polar' }, { image: src })).image as never);
    const sample = [out.at(4, 16), out.at(27, 16), out.at(16, 4), out.at(16, 27)];
    for (const s of sample) expect(s[3]).toBe(255);
    // both halves of the picture appear around the ring
    expect(sample.some((s) => s[0] > 200)).toBe(true);
    expect(sample.some((s) => s[2] > 200)).toBe(true);
  });

  it('log-polar repeats inwards: radius r and r x ratio show the same row', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, (x, y) => [x * 4, y * 4, 90, 255]);
    const out = await t.pixels((await t.run('kaleidoscope', { mode: 'logpolar', segments: 1, ratio: 0.5 }, { image: src })).image as never);
    const a = out.at(32 + 16, 32);
    const b = out.at(32 + 8, 32);
    expect(Math.abs(a[1] - b[1])).toBeLessThanOrEqual(20);
  });

  it('spins and falls in loops that close', async () => {
    const t = await harness();
    const src = t.fromFn(48, 48, (x, y) => [x * 5, y * 5, (x ^ y) * 4, 255]);
    for (const params of [{ mode: 'kaleidoscope', segments: 5, spin: 1 }, { mode: 'logpolar', segments: 3, fall: 1, twist: 1 }, { mode: 'mirror', scroll: [1, 0] }]) {
      const r = await seamRatio(t, 'kaleidoscope', params, { image: src });
      expect(r.motion).toBeGreaterThan(0.3);
      expect(r.seam, r.text).toBeLessThan(LOOP_SEAM_OK);
    }
  });

  it('Loop on closes a fractional scroll and a twist that is not a whole number of arms, and says so', async () => {
    const t = await harness();
    const src = t.fromFn(48, 48, (x, y) => [x * 5, y * 5, (x ^ y) * 4, 255]);
    for (const params of [{ mode: 'mirror', scroll: [0.37, 1.3] }, { mode: 'logpolar', segments: 5, twist: 0.37, fall: 3 }, { mode: 'logpolar', segments: 4, twist: 1.25, fall: 2, spin: 1 }]) {
      const r = await seamRatio(t, 'kaleidoscope', params, { image: src }, 24);
      expect(r.motion, r.text).toBeGreaterThan(0.3);
      expect(r.seam, JSON.stringify(params) + ' ' + r.text).toBeLessThan(LOOP_SEAM_OK);
    }
    const twisted = { mode: 'logpolar', segments: 5, twist: 0.37, fall: 3 };
    const off = await t.loopCheck('kaleidoscope', { ...twisted, twist: 0.5, fall: 3 }, { image: src }, { frames: 24, fps: 8, size: 48, project: { loop: false } });
    expect(off.seam, off.text).toBeGreaterThan(LOOP_SEAM_OK); // Loop off: a half arm per repeat x 3 repeats leaves a seam
    expect(kaleidoscopeLoop({ mode: 'mirror', scroll: [0.37, 1.3], twist: 0, fall: 0 }, true).scroll).toEqual([1, 1]);
    expect(kaleidoscopeLoop({ mode: 'mirror', scroll: [0.37, 1.3], twist: 0, fall: 0 }, false).scroll).toEqual([0.37, 1.3]);
    const fix = kaleidoscopeLoop({ mode: 'logpolar', scroll: [0, 0], twist: 0.37, fall: 3 }, true);
    expect(0.37 * 3 + fix.twistFix).toBeCloseTo(1, 9);
    expect(fix.notes[0]).toContain('extra turn');
    expect(kaleidoscope.summary!({ ...Object.fromEntries(Object.entries(kaleidoscope.params).map(([k, d]) => [k, (d as { default: unknown }).default])), ...twisted } as never, undefined, { loop: true, frames: 24, fps: 8 })).toContain('extra turn');
  });


  it('one pass; no new shader when numbers move', async () => {
    const t = await harness();
    const src = t.checker(32, 32, 4);
    await t.run('kaleidoscope', {}, { image: src });
    const s0 = t.gpu.stats().objects;
    await t.run('kaleidoscope', { segments: 17, zoom: 2.3, angle: 41, spin: 3 }, { image: src }, { seconds: 0.3 });
    await t.run('kaleidoscope', { mode: 'logpolar', segments: 9, ratio: 0.2 }, { image: src });
    const s1 = t.gpu.stats().objects;
    expect(s1.submits - s0.submits).toBe(2);
    expect(s1.pipelinesCreated - s0.pipelinesCreated).toBe(0);
  });
});
