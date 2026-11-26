import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  MotionTracker,
  TRACK_STRIDE,
  UNCERTAIN,
  applySim,
  cameraPath,
  compose,
  correctionAt,
  correctionMaps,
  estimateMotion,
  gaussian,
  invert,
  neededZoom,
  planStabilize,
  pyramid,
  smoothPath,
  toGrey,
  type Grey,
  type Sim,
  type SmoothOptions,
} from './stabilize';
import { render, scene } from './stabilize-testkit';

const W = 256;
const H = 192;
const L = 256;
const deg = (a: number) => (a * Math.PI) / 180;
/** Motion from frame A to frame B when the scene is at Ta and Tb. */
const motion = (ta: Sim, tb: Sim): Sim => compose(tb, invert(ta));
const est = (a: Grey, b: Grey) => estimateMotion(pyramid(a), pyramid(b));

describe('estimateMotion recovers known motion', () => {
  const base = render(W, H, IDENTITY);

  it('small shifts to sub-pixel accuracy', () => {
    for (const [sx, sy] of [
      [0.6, -0.4],
      [2.3, 1.7],
      [-5.5, 3.2],
    ]) {
      const t: Sim = { ls: 0, rot: 0, x: sx / L, y: sy / L };
      const e = est(base, render(W, H, t));
      expect(e.confidence).toBeGreaterThan(0.7);
      expect(Math.abs(e.sim.x * L - sx)).toBeLessThan(0.4);
      expect(Math.abs(e.sim.y * L - sy)).toBeLessThan(0.4);
      expect(Math.abs(e.sim.rot)).toBeLessThan(0.004);
    }
  });

  it('rotation and zoom together with a shift', () => {
    const t: Sim = { ls: Math.log(1.04), rot: deg(3), x: 4 / L, y: -3 / L };
    const e = est(base, render(W, H, t));
    expect(e.confidence).toBeGreaterThan(0.6);
    expect(Math.abs(e.sim.rot - t.rot)).toBeLessThan(deg(0.4));
    expect(Math.abs(e.sim.ls - t.ls)).toBeLessThan(0.01);
    expect(Math.abs(e.sim.x - t.x) * L).toBeLessThan(1);
    expect(Math.abs(e.sim.y - t.y) * L).toBeLessThan(1);
  });

  it('large jumps of a hyperlapse: a quarter of the frame', () => {
    for (const [sx, sy, r] of [
      [60, -20, 0],
      [-64, 30, 2],
      [20, 45, -3],
    ]) {
      const t: Sim = { ls: 0, rot: deg(r), x: sx / L, y: sy / L };
      const e = est(base, render(W, H, t));
      expect(e.confidence).toBeGreaterThan(UNCERTAIN);
      expect(Math.abs(e.sim.x - t.x) * L).toBeLessThan(1.5);
      expect(Math.abs(e.sim.y - t.y) * L).toBeLessThan(1.5);
      expect(Math.abs(e.sim.rot - t.rot)).toBeLessThan(deg(0.6));
    }
  });

  it('a region that moves differently is rejected', () => {
    const t: Sim = { ls: 0, rot: 0, x: 5 / L, y: 2 / L };
    // an object over about a fifth of the picture, showing other texture
    const blob = (x: number, y: number, v: number) => (Math.hypot(x - 0.12, y + 0.05) < 0.17 ? scene(x + 0.2, y - 0.1, 9) : v);
    const e = est(base, render(W, H, t, 1, blob));
    expect(e.confidence).toBeGreaterThan(UNCERTAIN);
    expect(Math.abs(e.sim.x * L - 5)).toBeLessThan(0.6);
    expect(Math.abs(e.sim.y * L - 2)).toBeLessThan(0.6);
  });

  it('textureless frames give low confidence, not garbage', () => {
    const flat: Grey = { w: W, h: H, d: new Float32Array(W * H).fill(128) };
    expect(est(flat, flat).confidence).toBeLessThan(UNCERTAIN);
    // noise only: nothing to follow
    let s = 12345;
    const noisy = (): Grey => {
      const d = new Float32Array(W * H);
      for (let i = 0; i < d.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        d[i] = 128 + ((s >>> 8) % 5) - 2;
      }
      return { w: W, h: H, d };
    };
    expect(est(noisy(), noisy()).confidence).toBeLessThan(UNCERTAIN);
    // a smooth gradient has no corners
    const grad: Grey = { w: W, h: H, d: Float32Array.from({ length: W * H }, (_, i) => (i % W) * 0.8) };
    expect(est(grad, grad).confidence).toBeLessThan(UNCERTAIN);
  });

  it('the tracker stores identity for an uncertain frame and does not analyse a repeated picture', () => {
    const a = render(W, H, IDENTITY);
    const flat: Grey = { w: W, h: H, d: new Float32Array(W * H).fill(90) };
    const tr = new MotionTracker();
    tr.push(a);
    tr.push(a); // identical: held shot
    tr.push(render(W, H, { ls: 0, rot: 0, x: 3 / L, y: 0 }));
    tr.push(flat);
    const t = tr.result();
    expect(t.length).toBe(4 * TRACK_STRIDE);
    expect(tr.stats).toMatchObject({ frames: 4, repeated: 1, uncertain: 1 });
    expect(t[2 * TRACK_STRIDE] * L).toBeCloseTo(3, 0);
    expect(t[3 * TRACK_STRIDE]).toBe(0);
    expect(t[3 * TRACK_STRIDE + 4]).toBeLessThan(UNCERTAIN);
  });

  it('toGrey shrinks to the analysis size', () => {
    const rgba = new Uint8ClampedArray(512 * 256 * 4).fill(200);
    const g = toGrey(rgba, 512, 256);
    expect([g.w, g.h]).toEqual([256, 128]);
    expect(g.d[10]).toBeCloseTo(200, 0);
  });
});

/** A track from per-frame absolute transforms (scene -> frame i). */
function trackOf(ts: Sim[]): Float32Array {
  const out: number[] = [];
  ts.forEach((t, i) => {
    const m = i === 0 ? IDENTITY : motion(ts[i - 1], t);
    out.push(m.x, m.y, m.rot, m.ls, 1);
  });
  return Float32Array.from(out);
}
const OPT: SmoothOptions = { mode: 'smooth', sigma: 6, loop: false, fixRotation: true, fixZoom: false, strength: 1 };

describe('camera path and smoothing', () => {
  const n = 120;
  const jitter = (i: number, a: number) => a * Math.sin(i * 12.9898) * Math.cos(i * 78.233);

  it('the path of a track returns the transforms that made it', () => {
    const ts: Sim[] = Array.from({ length: 8 }, (_, i) => ({ ls: 0.01 * i, rot: deg(2) * i, x: 0.01 * i, y: -0.005 * i }));
    const p = cameraPath(trackOf(ts));
    for (let i = 0; i < 8; i++) {
      const back = invert(ts[i]);
      expect(p.x[i]).toBeCloseTo(back.x, 5);
      expect(p.rot[i]).toBeCloseTo(back.rot, 5);
    }
  });

  it('a noisy straight pan becomes a straight pan', () => {
    // camera pans right at 0.004 per frame with 1.5% jitter
    const ts: Sim[] = Array.from({ length: n }, (_, i) => ({ ls: 0, rot: 0, x: -(0.004 * i + jitter(i, 0.015)), y: jitter(i + 500, 0.015) }));
    const real = cameraPath(trackOf(ts));
    const sm = smoothPath(real, OPT);
    const resid = (v: Float64Array, slope: number) => {
      let worst = 0;
      // the whole clip, ends included: a lopsided window must not bend the pan
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(v[i] - (v[0] + slope * i)));
      return worst;
    };
    expect(resid(sm.x, 0.004)).toBeLessThan(0.004);
    expect(resid(real.x, 0.004)).toBeGreaterThan(0.01);
    expect(resid(sm.y, 0)).toBeLessThan(0.004);
  });

  it('Locked off returns every frame to the first framing', () => {
    const ts: Sim[] = Array.from({ length: n }, (_, i) => ({ ls: 0, rot: deg(jitter(i, 2)), x: jitter(i, 0.02), y: jitter(i + 9, 0.02) }));
    ts[0] = IDENTITY;
    const real = cameraPath(trackOf(ts));
    const sm = smoothPath(real, { ...OPT, mode: 'locked' });
    for (let i = 0; i < n; i += 7) {
      // scene point s shows at ts[i](s) in frame i; the output reads frame i at k(q): it must put s back at ts[0](s) = s
      const k = correctionAt(real, sm, i);
      const s: [number, number] = [0.13, -0.07];
      const [ox, oy] = applySim(invert(k), ...applySim(ts[i], ...s));
      expect(Math.hypot(ox - s[0], oy - s[1])).toBeLessThan(1e-5);
    }
  });

  it('with a loop the correction has no jump where the loop starts again', () => {
    const ts: Sim[] = Array.from({ length: n }, (_, i) => ({ ls: 0, rot: deg(0.02 * i), x: -(0.006 * i) + jitter(i, 0.01), y: jitter(i + 3, 0.01) }));
    ts[0] = IDENTITY;
    const real = cameraPath(trackOf(ts));
    const step = (sm: ReturnType<typeof smoothPath>) => {
      const a = correctionAt(real, sm, n - 1);
      const b = correctionAt(real, sm, 0);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const circSm = smoothPath(real, { ...OPT, loop: true, sigma: 10 });
    const circ = step(circSm);
    const lin = step(smoothPath(real, { ...OPT, loop: false, sigma: 10 }));
    let typical = 0;
    for (let i = 1; i < n; i++) {
      const a = correctionAt(real, circSm, i - 1);
      const b = correctionAt(real, circSm, i);
      typical = Math.max(typical, Math.hypot(a.x - b.x, a.y - b.y));
    }
    expect(circ).toBeLessThanOrEqual(typical * 1.2 + 1e-9);
    expect(circ).toBeLessThan(lin);
  });

  it('gaussian keeps a constant and a line (away from the ends)', () => {
    const v = Float64Array.from({ length: 50 }, (_, i) => 3 + 0.5 * i);
    const s = gaussian(v, 4, false);
    expect(s[25]).toBeCloseTo(v[25], 6);
    expect(gaussian(new Float64Array(10).fill(2), 3, true)[4]).toBeCloseTo(2, 9);
  });

  it('the auto zoom covers the borders: no corner reads outside the picture at that zoom', () => {
    const ts: Sim[] = Array.from({ length: n }, (_, i) => ({ ls: jitter(i + 1, 0.02), rot: deg(jitter(i, 3)), x: jitter(i, 0.03), y: jitter(i + 9, 0.03) }));
    ts[0] = IDENTITY;
    const plan = planStabilize(trackOf(ts), OPT, W / H);
    expect(plan.zoom).toBeGreaterThan(1.02);
    const hx = 0.5;
    const hy = 0.5 * (H / W);
    const over = (z: number) => {
      let worst = -1;
      for (let i = 0; i < n; i++) {
        const re = plan.maps[i * 4];
        const im = plan.maps[i * 4 + 1];
        for (const [qx, qy] of [
          [-hx, -hy],
          [hx, -hy],
          [-hx, hy],
          [hx, hy],
        ]) {
          const sx = (re * qx - im * qy) / z + plan.maps[i * 4 + 2];
          const sy = (im * qx + re * qy) / z + plan.maps[i * 4 + 3];
          worst = Math.max(worst, Math.abs(sx) - hx, Math.abs(sy) - hy);
        }
      }
      return worst;
    };
    expect(over(plan.zoom)).toBeLessThan(1e-6);
    expect(over(plan.zoom * 0.97)).toBeGreaterThan(1e-4);
    // nothing to correct = no zoom
    const real = cameraPath(trackOf(ts));
    expect(neededZoom(correctionMaps(real, real), W / H)).toBeCloseTo(1, 9);
  });

  it('strength 0 is the picture as shot', () => {
    const ts: Sim[] = Array.from({ length: 30 }, (_, i) => ({ ls: 0, rot: 0, x: jitter(i, 0.03), y: 0 }));
    ts[0] = IDENTITY;
    const plan = planStabilize(trackOf(ts), { ...OPT, strength: 0 }, 1.5);
    for (let i = 0; i < 30; i++) {
      expect(plan.maps[i * 4]).toBeCloseTo(1, 9);
      expect(plan.maps[i * 4 + 2]).toBeCloseTo(0, 9);
    }
    expect(plan.zoom).toBeCloseTo(1, 9);
  });
});
