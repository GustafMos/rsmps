import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { GAUGE_LOOKS, gaugeFrame } from './film-gauge.node';

it('gate weave and flicker stay inside their limits and change from frame to frame', () => {
  const seen = new Set<string>();
  for (let f = 0; f < 200; f++) {
    const g = gaugeFrame(f, 1, 0.5, 0.1);
    expect(Math.abs(g.dx)).toBeLessThanOrEqual(0.005 * 0.5 + 1e-9);
    expect(Math.abs(g.dy)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(Math.abs(g.gain - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
    seen.add(g.dy.toFixed(6));
  }
  expect(seen.size).toBeGreaterThan(150);
  expect(gaugeFrame(7, 1, 0, 0)).toEqual({ dx: 0, dy: 0, gain: 1 });
  // smaller film: more of everything
  expect(GAUGE_LOOKS.super8.grain).toBeGreaterThan(GAUGE_LOOKS.film35.grain);
  expect(GAUGE_LOOKS.super8.weave).toBeGreaterThan(GAUGE_LOOKS.super16.weave);
});

it('film gauge: Super 8 adds grain, dark corners and a black gate edge; 65mm stays close to the picture; strength 0 is off', async () => {
  const t = await harness();
  const src = t.solid(96, 54, [128, 128, 128, 255]);
  const s8 = await t.pixels((await t.run('film-gauge', { gauge: 'super8' }, { image: src })).image as never);
  const big = await t.pixels((await t.run('film-gauge', { gauge: 'film65' }, { image: src })).image as never);
  const spread = (px: typeof s8) => {
    let lo = 255;
    let hi = 0;
    for (let y = 20; y < 34; y++) for (let x = 36; x < 60; x++) { lo = Math.min(lo, px.at(x, y)[1]); hi = Math.max(hi, px.at(x, y)[1]); }
    return hi - lo;
  };
  expect(spread(s8)).toBeGreaterThan(12);
  expect(spread(big)).toBeLessThan(spread(s8));
  expect(s8.at(0, 0)[1]).toBeLessThan(10); // the gate edge
  expect(big.at(0, 0)[1]).toBeGreaterThan(90);
  expect((await t.run('film-gauge', { strength: 0 }, { image: src })).image).toBe(src);
});
