import { describe, expect, it } from 'vitest';
import { coverZoom, wander } from './shake';
import { SHAKE_LOOKS, shakePose, shakeReach } from '../nodes/transform/camera-shake.node';
import { WEAVE_LOOKS, weaveFrame } from '../nodes/stylize/gate-weave.node';

describe('camera and film movement', () => {
  it('wander stays between -1 and 1, is smooth, and joins at the end of a loop', () => {
    let prev = wander(0, 0.7, 0.55, 3);
    for (let i = 1; i < 2000; i++) {
      const v = wander(i / 240, 0.7, 0.55, 3);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.2);
      prev = v;
    }
    expect(wander(4, 0.7, 0.55, 3, 4)).toBeCloseTo(wander(0, 0.7, 0.55, 3, 4), 6);
    expect(wander(1.3, 0.7, 0.55, 3)).not.toBeCloseTo(wander(1.3, 0.7, 0.55, 4), 3);
  });
  it('every camera shake look stays inside the reach its fill zoom is made for, and loops', () => {
    for (const look of Object.values(SHAKE_LOOKS)) {
      const reach = shakeReach(look);
      for (let i = 0; i < 600; i++) {
        const p = shakePose(look, i / 30, 5, 0);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(reach.x + 1e-9);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(reach.y + 1e-9);
        expect(Math.abs(p.rot)).toBeLessThanOrEqual(reach.rot + 1e-9);
        expect(p.zoom).toBeGreaterThanOrEqual(reach.zoom - 1e-9);
      }
      const a = shakePose(look, 0, 5, 4);
      const b = shakePose(look, 4, 5, 4);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.rot).toBeCloseTo(a.rot, 6);
    }
    // running moves more than a tripod
    expect(shakeReach(SHAKE_LOOKS.running).y).toBeGreaterThan(shakeReach(SHAKE_LOOKS.tripod).y * 20);
  });
  it('the fill zoom covers a moved and tilted frame', () => {
    expect(coverZoom(0, 0, 0, 16 / 9)).toBe(1);
    expect(coverZoom(0.01, 0, 0, 16 / 9)).toBeCloseTo(1.02, 6);
    expect(coverZoom(0, 0.01, 0, 16 / 9)).toBeCloseTo(1 + 0.02 * (16 / 9), 6);
    expect(coverZoom(0, 0, 0.02, 16 / 9)).toBeGreaterThan(1.03);
  });
  it('gate weave moves mostly up and down, once per frame, and only worn machines slip', () => {
    let sx = 0;
    let sy = 0;
    let slips = 0;
    for (let f = 0; f < 500; f++) {
      const w = weaveFrame(WEAVE_LOOKS.film16, f, 2, 0);
      sx += Math.abs(w.pose.x);
      sy += Math.abs(w.pose.y);
      if (w.slip !== 0) slips++;
      expect(Math.abs(w.pose.y)).toBeLessThanOrEqual((0.14 + 0.07) / 100 + 1e-9);
    }
    expect(sy).toBeGreaterThan(sx * 1.5);
    expect(slips).toBe(0);
    let worn = 0;
    for (let f = 0; f < 500; f++) if (weaveFrame(WEAVE_LOOKS.broken, f, 2, 0).slip !== 0) worn++;
    expect(worn).toBeGreaterThan(40);
    expect(weaveFrame(WEAVE_LOOKS.film16, 12, 2, 0)).toEqual(weaveFrame(WEAVE_LOOKS.film16, 12, 2, 0));
  });
});
