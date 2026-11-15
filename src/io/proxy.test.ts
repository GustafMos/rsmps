import { describe, expect, it } from 'vitest';
import { PROXY_LEVELS, ProxyController } from './clock';

const BUDGET = 1000 / 30;
const DT = BUDGET; // one frame per budget

/** Feed `seconds` of frames; cost(proxy, t) gives render ms. Returns the proxy history. */
function simulate(c: ProxyController, seconds: number, cost: (p: number, t: number) => number, t0 = 0): { t: number; proxy: number }[] {
  const out: { t: number; proxy: number }[] = [];
  for (let t = t0; t < t0 + seconds * 1000; t += DT) out.push({ t, proxy: c.report(cost(c.proxy, t), BUDGET, t) });
  return out;
}
const flips = (h: { proxy: number }[]) => h.filter((x, i) => i > 0 && x.proxy !== h[i - 1].proxy).length;

describe('ProxyController', () => {
  it('a slow first frame then 60% of budget stays at proxy 1', () => {
    const c = new ProxyController();
    const h = simulate(c, 20, (_p, t) => (t < DT ? BUDGET * 12 : BUDGET * 0.6));
    expect(new Set(h.map((x) => x.proxy))).toEqual(new Set([1]));
  });

  it('ignores a burst of slow frames right after warmup() (compiles, cold caches)', () => {
    const c = new ProxyController();
    c.warmup();
    const h = simulate(c, 10, (_p, t) => (t < 6 * DT ? BUDGET * 8 : BUDGET * 0.5));
    expect(h.every((x) => x.proxy === 1)).toBe(true);
  });

  it('steady 150% of budget settles one level down and stays there', () => {
    const c = new ProxyController();
    const h = simulate(c, 30, (p) => BUDGET * 1.5 * p * p);
    expect(c.proxy).toBe(0.75);
    expect(flips(h)).toBe(1);
  });

  it('steps down one level at a time and needs several consecutive slow frames', () => {
    const c = new ProxyController();
    const h = simulate(c, 1, () => BUDGET * 3);
    const firstDrop = h.findIndex((x) => x.proxy < 1);
    expect(firstDrop).toBeGreaterThanOrEqual(10); // warmup + window + consecutive count
    const levels = [...new Set(h.map((x) => x.proxy))];
    for (let i = 1; i < levels.length; i++) expect(PROXY_LEVELS.indexOf(levels[i] as 1)).toBe(PROXY_LEVELS.indexOf(levels[i - 1] as 1) + 1);
  });

  it('does not go below 0.5 unless 0.5 itself is over budget for a sustained time', () => {
    const c = new ProxyController();
    // 150% at 0.5-equivalent: cost = 3 budgets at full res -> 0.75 still over, 0.5 fits.
    simulate(c, 30, (p) => BUDGET * 3 * p * p);
    expect(c.proxy).toBe(0.5);
    const d = new ProxyController();
    const h = simulate(d, 30, () => BUDGET * 2); // hopeless: too slow at every level
    const reached = h.findIndex((x) => x.proxy < 0.5);
    expect(reached).toBeGreaterThan(0);
    expect(h[reached].t).toBeGreaterThan(2000);
  });

  it('alternating borderline load flips at most once per 10 s', () => {
    const c = new ProxyController();
    // Full resolution costs 130% of budget on even seconds and 40% on odd seconds, scaled by proxy^2.
    const h = simulate(c, 60, (p, t) => BUDGET * (Math.floor(t / 1000) % 2 === 0 ? 1.3 : 0.4) * p * p);
    for (let start = 0; start < 60_000; start += 10_000) {
      const win = h.filter((x) => x.t >= start && x.t < start + 10_000);
      expect(flips(win)).toBeLessThanOrEqual(1);
    }
  });

  it('climbs back only after a sustained comfortable stretch and not to a level abandoned < 10 s ago', () => {
    const c = new ProxyController();
    const slow = simulate(c, 3, (p) => BUDGET * 1.5 * p * p);
    expect(c.proxy).toBe(0.75);
    const tEnd = slow[slow.length - 1].t + DT;
    const easy = simulate(c, 5, () => BUDGET * 0.2, tEnd);
    expect(easy.every((x) => x.proxy === 0.75)).toBe(true); // 1.0 was abandoned moments ago
    const later = simulate(c, 6, () => BUDGET * 0.2, tEnd + 8000);
    expect(c.proxy).toBe(1);
    expect(later.length).toBeGreaterThan(0);
  });

  it('keeps its level across pause/play (warmup does not reset it)', () => {
    const c = new ProxyController();
    simulate(c, 30, (p) => BUDGET * 1.5 * p * p);
    const level = c.proxy;
    c.warmup();
    expect(c.proxy).toBe(level);
    c.reset();
    expect(c.proxy).toBe(1);
  });
});
