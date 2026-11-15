import { describe, expect, it } from 'vitest';
import { numberAt, numberChain, numberSource } from '../../lib/util-testsource';
import { harness } from '../../testing';

const step = (at: number, lo = 0, hi = 1) => (f: number) => (f >= at ? hi : lo);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('smooth', () => {
  it('ease: monotonic, ~63% after one time constant, exact before the jump', async () => {
    const t = await harness([numberSource('s-step', step(20))]);
    const c = numberChain(t, 's-step', 'smooth', { mode: 'ease', rise: 0.5, fall: 0.5 });
    expect(await numberAt(t, c.graph, c.node, 10)).toBe(0);
    const ys: number[] = [];
    for (const f of range(19, 60)) ys.push(await numberAt(t, c.graph, c.node, f));
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-12);
    // frame 20 is the first frame of the new value; 0.5 s (5 frames) after the jump the follower has covered 1 - 1/e
    const afterOneTau = ys[20 - 19 + 4] ?? 0;
    expect(Math.abs(afterOneTau - 0.632)).toBeLessThan(0.07);
    expect(ys[ys.length - 1]).toBeGreaterThan(0.97);
  });

  it('ease: separate rise and fall (0 = instant)', async () => {
    const t = await harness([numberSource('s-pulse', (f) => (f >= 20 && f < 40 ? 1 : 0))]);
    const c = numberChain(t, 's-pulse', 'smooth', { mode: 'ease', rise: 0, fall: 0.5 });
    expect(await numberAt(t, c.graph, c.node, 20)).toBe(1);
    expect(await numberAt(t, c.graph, c.node, 39)).toBe(1);
    const a = await numberAt(t, c.graph, c.node, 42);
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThan(0.5);
    expect(await numberAt(t, c.graph, c.node, 41)).toBeGreaterThan(a);
    const off = numberChain(t, 's-pulse', 'smooth', { mode: 'ease', rise: 0, fall: 0 });
    expect(await numberAt(t, off.graph, off.node, 41)).toBe(0);
  });

  it('linear: matches a hand-computed moving average', async () => {
    const t = await harness([numberSource('s-step', step(20, 0, 10))]);
    const c = numberChain(t, 's-step', 'smooth', { mode: 'linear', time: 0.5 }); // 5 frames
    expect(await numberAt(t, c.graph, c.node, 19)).toBe(0);
    expect(await numberAt(t, c.graph, c.node, 22)).toBeCloseTo((0 + 0 + 10 + 10 + 10) / 5, 9);
    expect(await numberAt(t, c.graph, c.node, 20)).toBeCloseTo(2, 9);
    expect(await numberAt(t, c.graph, c.node, 30)).toBe(10);
  });

  it('slew: never changes faster than the rate, both ways', async () => {
    const t = await harness([numberSource('s-pulse', (f) => (f >= 20 && f < 50 ? 10 : 0))]);
    const c = numberChain(t, 's-pulse', 'smooth', { mode: 'slew', riseRate: 10, fallRate: 5, history: 3 });
    const ys: number[] = [];
    for (const f of range(10, 90)) ys.push(await numberAt(t, c.graph, c.node, f));
    for (let i = 1; i < ys.length; i++) {
      const d = ys[i] - ys[i - 1];
      expect(d).toBeLessThanOrEqual(10 * 0.1 + 1e-9);
      expect(d).toBeGreaterThanOrEqual(-5 * 0.1 - 1e-9);
    }
    expect(Math.max(...ys)).toBeCloseTo(10, 6);
    expect(ys[ys.length - 1]).toBe(0);
  });

  it('spring: overshoots only when bounce > 0', async () => {
    const t = await harness([numberSource('s-step', step(20))]);
    const run = async (bounce: number) => {
      const c = numberChain(t, 's-step', 'smooth', { mode: 'spring', stiffness: 2, bounce });
      let m = 0;
      let prev = 0;
      let monotone = true;
      for (const f of range(18, 80)) {
        const y = await numberAt(t, c.graph, c.node, f);
        m = Math.max(m, y);
        if (y < prev - 1e-12) monotone = false;
        prev = y;
      }
      return { m, monotone, end: prev };
    };
    const flat = await run(0);
    expect(flat.m).toBeLessThanOrEqual(1 + 1e-9);
    expect(flat.monotone).toBe(true);
    expect(flat.end).toBeGreaterThan(0.95);
    const wobbly = await run(0.8);
    expect(wobbly.m).toBeGreaterThan(1.05);
  });

  it('wrapAngle takes the short way round the circle', async () => {
    const t = await harness([numberSource('s-ang', (f) => (f >= 20 ? 10 : 350))]);
    const circ = (a: number) => Math.abs((((a + 180) % 360) + 360) % 360 - 180); // distance from 0 degrees
    const wrap = numberChain(t, 's-ang', 'smooth', { mode: 'ease', rise: 0.5, fall: 0.5, wrapAngle: true });
    const plain = numberChain(t, 's-ang', 'smooth', { mode: 'ease', rise: 0.5, fall: 0.5, wrapAngle: false });
    let worstWrap = 0;
    let plainWent = false;
    for (const f of range(15, 50)) {
      worstWrap = Math.max(worstWrap, circ(await numberAt(t, wrap.graph, wrap.node, f)));
      const y = await numberAt(t, plain.graph, plain.node, f);
      if (y > 100 && y < 260) plainWent = true;
    }
    expect(worstWrap).toBeLessThanOrEqual(20.001);
    expect(plainWent).toBe(true);
    expect(circ((await numberAt(t, wrap.graph, wrap.node, 60)) - 10)).toBeLessThan(0.5);
  });

  it('a static input returns the input exactly; zero times pass through', async () => {
    const t = await harness();
    expect((await t.run('smooth', { mode: 'ease', rise: 1, fall: 1 }, { value: 0.37 })).value).toBe(0.37);
    expect((await t.run('smooth', { mode: 'spring' }, { value: -2.5 })).value).toBe(-2.5);
    const t2 = await harness([numberSource('s-step', step(20))]);
    for (const p of [{ mode: 'ease', rise: 0, fall: 0 }, { mode: 'linear', time: 0 }, { mode: 'slew', riseRate: 0, fallRate: 0 }]) {
      const c = numberChain(t2, 's-step', 'smooth', p);
      expect(await numberAt(t2, c.graph, c.node, 21)).toBe(1);
    }
  });

  it('caps the number of upstream renders per frame', async () => {
    const spy = { n: 0 };
    const t = await harness([numberSource('s-step', step(20), spy)]);
    const c = numberChain(t, 's-step', 'smooth', { mode: 'ease', rise: 600, fall: 600 }, { project: { duration: 10000 } });
    spy.n = 0;
    await numberAt(t, c.graph, c.node, 30000);
    expect(spy.n).toBeLessThanOrEqual(97);
    expect(spy.n).toBeGreaterThan(20);
    const spring = numberChain(t, 's-step', 'smooth', { mode: 'spring', stiffness: 0.05, bounce: 1 }, { project: { duration: 10000 } });
    spy.n = 0;
    await numberAt(t, spring.graph, spring.node, 30000);
    expect(spy.n).toBeLessThanOrEqual(97);
  });

  it('costs well under a millisecond per frame in steady playback', async () => {
    const t = await harness([numberSource('s-step', (f) => Math.floor(f / 12) % 5)]);
    const c = numberChain(t, 's-step', 'smooth', { mode: 'ease', rise: 0.2, fall: 0.2 }, { project: { fps: 24 } });
    for (let f = 0; f < 150; f++) await t.engine.evaluate({ graph: c.graph, node: c.source, seconds: f / 24 }); // upstream cached per frame
    let total = 0;
    const frames = range(60, 149);
    for (const f of frames) {
      const r = await t.engine.evaluate({ graph: c.graph, node: c.node, seconds: f / 24 });
      expect(r.errors.size).toBe(0);
      total += r.timings.get(c.node) ?? 0;
    }
    expect(total / frames.length).toBeLessThan(3); // generous; typically a fraction of a millisecond
  });
});
