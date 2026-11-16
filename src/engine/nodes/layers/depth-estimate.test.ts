import { describe, expect, it } from 'vitest';
import { harness, type Harness } from '../../testing';
import { addNode, connect, createGraph } from '../../graph';
import { pictureToScene, sceneToPicture } from '../../lib/depth';
import { PNG_DIR, writePng } from '../../lib/gen-3d-testutil';
import { cameraSource, cam, readHalf } from '../../lib/splat-testutil';
import type { CameraValue, GraphDoc, ImageValue, MaskValue } from '../../types';

const T = { timeout: 180_000 };
let shared: Promise<Harness> | null = null;
const H = () => (shared ??= harness());

/** All cues off, no smoothing, raw cue values out: tests switch on exactly the cue they look at. */
const ISO = { preset: 'custom', ground: 0, room: 0, sky: 0, focus: 0, haze: 0, subject: 0, brightness: 0, color: 0, motion: 0, smooth: 0, detail: 1, contrast: 1, gamma: 1, quality: 'full' };
const W = 128;
const HT = 96;

interface Depth {
  f: Float32Array;
  w: number;
  h: number;
  at(x: number, y: number): number;
}
async function depthOf(t: Harness, params: Record<string, unknown>, inputs: Record<string, ImageValue | MaskValue>, opts: { seconds?: number } = {}): Promise<Depth> {
  const out = await t.run('depth-estimate', { ...ISO, ...params }, inputs, opts);
  const d = out.depth as ImageValue;
  const f = await readHalf(t, d);
  return { f, w: d.width, h: d.height, at: (x, y) => f[(y * d.width + x) * 4] };
}
const mean = (d: Depth, x0: number, y0: number, x1: number, y1: number) => {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) (s += d.at(x, y)), n++;
  return s / n;
};
const flat = (t: Harness, rgb: [number, number, number] = [128, 128, 128]) => t.fromFn(W, HT, () => [...rgb, 255]);

describe('cues in isolation', () => {
  it('ground: lower rows are nearer, monotonically; the horizon holds everything above it at far', T, async () => {
    const t = await H();
    const d = await depthOf(t, { ground: 1, horizon: 0 }, { image: flat(t) });
    for (let y = 1; y < HT; y++) expect(d.at(64, y)).toBeGreaterThanOrEqual(d.at(64, y - 1) - 1e-3);
    expect(d.at(64, 0)).toBeLessThan(0.02);
    expect(d.at(64, HT - 1)).toBeGreaterThan(0.97);
    expect(d.at(10, 50)).toBeCloseTo(d.at(100, 50), 3); // depends on the row only
    const h = await depthOf(t, { ground: 1, horizon: 0.5 }, { image: flat(t) });
    expect(h.at(64, 40)).toBeLessThan(0.01);
    expect(h.at(64, 70)).toBeGreaterThan(0.3);
    const curved = await depthOf(t, { ground: 1, horizon: 0, curve: 2 }, { image: flat(t) });
    expect(curved.at(64, 48)).toBeLessThan(d.at(64, 48) - 0.1); // a curve above 1 keeps the middle far
  });

  it('room: the middle is far, the edges are near; sky: smooth area above the horizon goes far', T, async () => {
    const t = await H();
    const r = await depthOf(t, { room: 1 }, { image: flat(t) });
    expect(r.at(64, 48)).toBeLessThan(0.05);
    expect(r.at(1, 48)).toBeGreaterThan(0.6);
    expect(r.at(64, 1)).toBeGreaterThan(0.4);
    const s = await depthOf(t, { sky: 1, horizon: 0.5 }, { image: flat(t) });
    expect(s.at(64, 3)).toBeLessThan(0.02);
    expect(s.at(64, 90)).toBeGreaterThan(0.25); // base level below the horizon
  });

  it('focus: a sharp textured square on a blurred background is nearer than the background', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => {
      const inSq = x >= 44 && x < 84 && y >= 28 && y < 68;
      if (inSq) return (((x >> 2) + (y >> 2)) & 1 ? [235, 235, 235, 255] : [25, 25, 25, 255]) as [number, number, number, number];
      const v = Math.round(128 + 60 * Math.sin(x / 11) * Math.cos(y / 13)); // soft, out of focus
      return [v, v, v, 255];
    });
    const d = await depthOf(t, { focus: 1, focusSpread: 0.04 }, { image: img });
    const inside = mean(d, 52, 36, 76, 60);
    const outside = mean(d, 4, 4, 30, 24);
    expect(inside).toBeGreaterThan(outside + 0.3);
    // an in-focus edge reads as sharper than an equally strong soft one
    const edgeSharp = t.fromFn(W, HT, (x) => (x < 64 ? [30, 30, 30, 255] : [220, 220, 220, 255]));
    const edgeSoft = t.fromFn(W, HT, (x) => {
      const v = Math.round(30 + 190 * Math.min(1, Math.max(0, (x - 48) / 32)));
      return [v, v, v, 255];
    });
    const a = await depthOf(t, { focus: 1 }, { image: edgeSharp });
    const b = await depthOf(t, { focus: 1 }, { image: edgeSoft });
    expect(mean(a, 60, 40, 68, 56)).toBeGreaterThan(mean(b, 56, 40, 72, 56) + 0.2);
  });

  it('haze: a flat, grey-blue, low contrast band is farther than a crisp saturated band', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => {
      if (y < 40) return [150, 160, 175, 255]; // hazy
      return ((x >> 2) & 1 ? [220, 40, 30, 255] : [30, 190, 60, 255]) as [number, number, number, number]; // crisp
    });
    const d = await depthOf(t, { haze: 1, focusSpread: 0.03 }, { image: img });
    expect(mean(d, 8, 4, 120, 30)).toBeLessThan(mean(d, 8, 52, 120, 90) - 0.4);
  });

  it('brightness and color cues, both directions', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x) => (x < 64 ? [60, 60, 60, 255] : [200, 200, 200, 255]));
    const lighter = await depthOf(t, { brightness: 1 }, { image: img });
    expect(lighter.at(100, 40)).toBeGreaterThan(lighter.at(20, 40) + 0.3);
    const darker = await depthOf(t, { brightness: -1 }, { image: img });
    expect(darker.at(20, 40)).toBeGreaterThan(darker.at(100, 40) + 0.3);
    const red = t.fromFn(W, HT, (x) => (x < 64 ? [230, 40, 40, 255] : [40, 90, 230, 255]));
    const near = await depthOf(t, { color: 1, pickColor: [0.9, 0.16, 0.16, 1] }, { image: red });
    expect(near.at(20, 40)).toBeGreaterThan(0.9);
    expect(near.at(100, 40)).toBeLessThan(0.1);
    const far = await depthOf(t, { color: -1, pickColor: [0.9, 0.16, 0.16, 1] }, { image: red });
    expect(far.at(20, 40)).toBeLessThan(0.1);
    expect(far.at(100, 40)).toBeGreaterThan(0.9);
  });

  it('motion: larger flow magnitude is nearer; without a Flow input the cue does nothing', T, async () => {
    const t = await H();
    // flow encodes motion as a fraction of the picture width (r) per frame: left 0.1 * 128 = 12.8 px, right 0.012 * 128 = 1.5 px
    const flow = t.fromFn(W, HT, (x) => (x < 64 ? [26, 0, 0, 255] : [3, 0, 0, 255]));
    const d = await depthOf(t, { motion: 1, motionScale: 12 }, { image: flat(t), flow });
    expect(d.at(20, 40)).toBeGreaterThan(0.9);
    expect(d.at(100, 40)).toBeLessThan(0.3);
    const none = await depthOf(t, { motion: 1 }, { image: flat(t) });
    expect(none.at(20, 40)).toBeCloseTo(none.at(100, 40), 3);
  });

  it('subject: a disc mask becomes a dome (centre > middle > rim > outside); roundness 0 is a flat cut-out', T, async () => {
    const t = await H();
    const disc = t.maskFn(W, HT, (x, y) => (Math.hypot(x - 64, y - 48) <= 32 ? 1 : 0));
    const params = { subject: 1, pull: 1, roundness: 1, domeSize: 0.25 };
    const d = await depthOf(t, params, { image: flat(t), subjectMask: disc });
    const profile = [33, 37, 42, 50, 58, 64].map((x) => d.at(x, 48)); // rim -> centre
    for (let i = 1; i < profile.length; i++) expect(profile[i]).toBeGreaterThan(profile[i - 1] - 1e-3);
    expect(profile[5]).toBeGreaterThan(profile[0] + 0.15);
    expect(profile[0]).toBeGreaterThan(d.at(10, 48) + 0.1); // even the rim is in front of the surroundings
    expect(d.at(10, 48)).toBeCloseTo(0.3, 1);
    // symmetric about the centre
    expect(d.at(64 - 20, 48)).toBeCloseTo(d.at(64 + 20, 48), 1);
    const cut = await depthOf(t, { ...params, roundness: 0 }, { image: flat(t), subjectMask: disc });
    expect(Math.abs(cut.at(64, 48) - cut.at(40, 48))).toBeLessThan(0.02);
    expect(cut.at(64, 48)).toBeGreaterThan(cut.at(10, 48) + 0.3);
  });

  it('subject, unwired: finds the subject itself (a bright disc on a dark backdrop) and pulls it forward', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => (Math.hypot(x - 64, y - 48) <= 24 ? [230, 120, 40, 255] : [20, 30, 50, 255]));
    const d = await depthOf(t, { subject: 1, pull: 0.8, roundness: 0.5, quality: 'normal' }, { image: img });
    expect(d.at(64, 48)).toBeGreaterThan(d.at(8, 8) + 0.4);
  });
});

describe('structure', () => {
  it('edges snap to the picture: a depth edge drawn 4 px off moves onto the picture edge (also at half work size)', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => (x >= 40 && x < 88 && y >= 24 && y < 72 ? [230, 230, 230, 255] : [25, 25, 25, 255]));
    const mask = t.maskFn(W, HT, (x, y) => (x >= 36 && x < 92 && y >= 20 && y < 76 ? 1 : 0)); // 4 px too big on every side
    for (const quality of ['full', 'normal']) {
      const params = { subject: 1, pull: 1, roundness: 0, smooth: 1, edge: 1, detail: 0, quality };
      const sm = await depthOf(t, params, { image: img, subjectMask: mask });
      const raw = await depthOf(t, { ...params, smooth: 0, detail: 1 }, { image: img, subjectMask: mask });
      const inside = sm.at(64, 48);
      const outside = sm.at(10, 48);
      const mid = (inside + outside) / 2;
      // the 4 px strip between the mask edge and the picture edge belongs to the dark region
      expect(raw.at(38, 48), `${quality}: raw strip`).toBeGreaterThan(mid);
      expect(sm.at(38, 48), `${quality}: snapped strip`).toBeLessThan(raw.at(38, 48) - 0.2);
      expect(sm.at(41, 48), `${quality}: inside the picture edge`).toBeGreaterThan(mid);
      // the steepest step along the row is within 2 px of the picture edge (x = 40)
      let best = 0;
      let at = 0;
      for (let x = 30; x < 50; x++) {
        const g = Math.abs(sm.at(x + 1, 48) - sm.at(x - 1, 48));
        if (g > best) (best = g), (at = x);
      }
      expect(Math.abs(at - 40), `${quality}: step at ${at}`).toBeLessThanOrEqual(2);
      expect(best, `${quality}: the step is a real edge`).toBeGreaterThan(0.2);
    }
  });

  it('flatten regions: noise inside a uniform region is averaged away, a region boundary is kept', T, async () => {
    const t = await H();
    const noise = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 31; // 0..30, hashed per pixel
    const img = t.fromFn(W, HT, (x, y) => (x < 64 ? [60 + 3 * noise(x, y), 60 + 3 * noise(x, y), 60 + 3 * noise(x, y), 255] : [170 + noise(x, y), 170 + noise(x, y), 170 + noise(x, y), 255]));
    const std = (d: Depth) => {
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (let y = 20; y < 76; y++) for (let x = 10; x < 54; x++) (s1 += d.at(x, y)), (s2 += d.at(x, y) ** 2), n++;
      return Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2));
    };
    const raw = await depthOf(t, { brightness: 1 }, { image: img });
    const sm = await depthOf(t, { brightness: 1, smooth: 1, detail: 0, edge: 0.3 }, { image: img });
    expect(std(raw)).toBeGreaterThan(0.03);
    expect(std(sm)).toBeLessThan(std(raw) * 0.4);
    // the boundary between the two colour regions stays a step
    expect(Math.abs(sm.at(70, 48) - sm.at(57, 48))).toBeGreaterThan(Math.abs(raw.at(70, 48) - raw.at(57, 48)) * 0.5);
  });

  it('detail brings back fine structure of the raw cues', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x) => (((x >> 1) & 1) ? [240, 240, 240, 255] : [20, 20, 20, 255]));
    const smooth = await depthOf(t, { brightness: 1, smooth: 1, detail: 0, edge: 0 }, { image: img });
    const detail = await depthOf(t, { brightness: 1, smooth: 1, detail: 1, edge: 0 }, { image: img });
    const ripple = (d: Depth) => Math.abs(d.at(64, 40) - d.at(66, 40)) + Math.abs(d.at(65, 40) - d.at(67, 40));
    expect(ripple(detail)).toBeGreaterThan(ripple(smooth) + 0.5);
  });

  it('contrast, gamma, near / far level, invert; output is a 16 bit grey picture with alpha 1', T, async () => {
    const t = await H();
    const base = await depthOf(t, { ground: 1, horizon: 0 }, { image: flat(t) });
    const y = 72;
    const v = base.at(64, y);
    const g = await depthOf(t, { ground: 1, horizon: 0, gamma: 2 }, { image: flat(t) });
    expect(g.at(64, y)).toBeCloseTo(v * v, 2);
    const c = await depthOf(t, { ground: 1, horizon: 0, contrast: 2 }, { image: flat(t) });
    expect(c.at(64, y)).toBeCloseTo(Math.min(1, Math.max(0, (v - 0.5) * 2 + 0.5)), 2);
    const lv = await depthOf(t, { ground: 1, horizon: 0, nearLevel: 0.8, farLevel: 0.2 }, { image: flat(t) });
    expect(lv.at(64, y)).toBeCloseTo(0.2 + 0.6 * v, 2);
    expect(lv.at(64, 0)).toBeCloseTo(0.2, 2);
    const inv = await depthOf(t, { ground: 1, horizon: 0, invert: true }, { image: flat(t) });
    expect(inv.at(64, y)).toBeCloseTo(1 - v, 3);
    expect(base.f[3]).toBe(1);
    expect(base.f[0]).toBe(base.f[1]);
    expect(base.f[1]).toBe(base.f[2]);
  });

  it('paint corrections: white pulls nearer, white pushes farther, elsewhere nothing changes', T, async () => {
    const t = await H();
    const base = await depthOf(t, { ground: 1, horizon: 0 }, { image: flat(t) });
    const brush = t.maskFn(W, HT, (x, y) => (x >= 40 && x < 60 && y >= 30 && y < 50 ? 1 : 0));
    const up = await depthOf(t, { ground: 1, horizon: 0, paint: 0.3 }, { image: flat(t), nearer: brush });
    const down = await depthOf(t, { ground: 1, horizon: 0, paint: 0.3 }, { image: flat(t), farther: brush });
    expect(up.at(50, 40)).toBeCloseTo(Math.min(1, base.at(50, 40) + 0.3), 2);
    expect(down.at(50, 40)).toBeCloseTo(Math.max(0, base.at(50, 40) - 0.3), 2);
    expect(up.at(100, 40)).toBeCloseTo(base.at(100, 40), 3);
    expect(down.at(100, 80)).toBeCloseTo(base.at(100, 80), 3);
    const off = await depthOf(t, { ground: 1, horizon: 0, paint: 0 }, { image: flat(t), nearer: brush });
    expect(off.at(50, 40)).toBeCloseTo(base.at(50, 40), 3);
  });

  it('presets override their controls; Custom leaves everything as set', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => [60 + x, 80 + y, 120, 255]);
    const a = await depthOf(t, { preset: 'landscape', quality: 'normal', smooth: 0.5, detail: 0.2 }, { image: img });
    const b = await depthOf(t, { preset: 'custom', ground: 1, horizon: 0.4, curve: 1.2, sky: 0.7, focus: 0.15, haze: 0.7, quality: 'normal', smooth: 0.7, detail: 0.2 }, { image: img });
    expect(Math.abs(a.at(64, 70) - b.at(64, 70))).toBeLessThan(0.004);
    expect(a.at(64, 90)).toBeGreaterThan(a.at(64, 10) + 0.2);
    for (const preset of ['portrait', 'room', 'graphic', 'moving', 'flat']) {
      const d = await depthOf(t, { preset, quality: 'normal' }, { image: img });
      expect(Number.isFinite(d.at(64, 48)), preset).toBe(true);
    }
  });
});

describe('video: stability, no readbacks, no recompiles', () => {
  /** A source that reads the clock (so downstream re-renders every frame) and shows `pattern(frame)`. */
  function clockSource(t: Harness, id: string, pattern: (frame: number) => (x: number, y: number) => [number, number, number, number]) {
    t.registry.register({
      id,
      title: id,
      category: 'input',
      description: 'test source',
      inputs: {},
      outputs: { out: { type: 'image' } },
      params: {},
      render: (ctx) => {
        const fn = pattern(ctx.time.frame);
        const data = new Uint8ClampedArray(W * HT * 4);
        for (let y = 0; y < HT; y++) for (let x = 0; x < W; x++) data.set(fn(x, y), (y * W + x) * 4);
        return { out: ctx.gpu.upload(data, W, HT, 1, true) };
      },
    });
  }
  const scene = (gain: (f: number) => number) => (f: number) => (x: number, y: number): [number, number, number, number] => {
    const g = gain(f);
    const inDisc = Math.hypot(x - 64, y - 52) < 22;
    const v = inDisc ? [230, 140, 60] : [40 + (y >> 1), 60 + (x >> 2), 110 + ((x * 7 + y * 3) % 40)];
    return [Math.min(255, v[0] * g), Math.min(255, v[1] * g), Math.min(255, v[2] * g), 255];
  };
  function graphFor(t: Harness, source: string, params: Record<string, unknown>): { graph: GraphDoc; id: string } {
    let graph = createGraph('t');
    graph.project = { ...graph.project, width: W, height: HT, fps: 10, duration: 5, loop: false };
    const a = addNode(graph, t.registry, 'depth-estimate', { x: 0, y: 0 }, params);
    const s = addNode(a.graph, t.registry, source);
    graph = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: a.node.id, port: 'image' });
    return { graph, id: a.node.id };
  }
  async function frames(t: Harness, g: { graph: GraphDoc; id: string }, n: number): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let f = 0; f < n; f++) {
      const r = await t.engine.evaluate({ graph: g.graph, node: g.id, port: 'depth', seconds: f / 10 });
      if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
      out.push(await readHalf(t, r.value as ImageValue));
    }
    return out;
  }
  const maxDiff = (a: Float32Array, b: Float32Array) => {
    let m = 0;
    for (let i = 0; i < a.length; i += 4) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  const meanDiff = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]);
    return s / (a.length / 4);
  };

  it('the same picture on 12 frames gives identical depth, with the internal subject finder on and NO readback after the first frame', T, async () => {
    const t = await H();
    clockSource(t, 'test-still-clock', scene(() => 1));
    const g = graphFor(t, 'test-still-clock', { subject: 1, stabilize: true, quality: 'normal' });
    const first = await frames(t, g, 1);
    const reads = t.gpu.stats().objects.buffersCreated;
    const orig = t.gpu.read.bind(t.gpu);
    let count = 0;
    (t.gpu as unknown as { read: unknown }).read = (...a: Parameters<typeof orig>) => (count++, orig(...a));
    let rest: Float32Array[];
    try {
      rest = await frames(t, g, 12);
    } finally {
      (t.gpu as unknown as { read: unknown }).read = orig;
    }
    void reads;
    for (const f of rest) expect(maxDiff(first[0], f)).toBe(0);
    expect(count, 'gpu.read calls while playing').toBe(0);
  });

  it('a slowly brightening picture does not flicker: frame to frame change stays small, and Stabilize holds the levels', T, async () => {
    const t = await H();
    clockSource(t, 'test-brighten', scene((f) => 0.6 + 0.03 * f));
    const base = { subject: 0.5, quality: 'normal' };
    const off = await frames(t, graphFor(t, 'test-brighten', base), 12);
    const on = await frames(t, graphFor(t, 'test-brighten', { ...base, stabilize: true }), 12);
    for (const seq of [off, on]) {
      let worst = 0;
      for (let i = 1; i < seq.length; i++) worst = Math.max(worst, meanDiff(seq[i - 1], seq[i]));
      expect(worst, 'mean frame-to-frame change').toBeLessThan(0.012);
    }
    // the picture got 30 % brighter over the clip; depth must not follow it (no per-frame normalisation)
    expect(meanDiff(off[0], off[11])).toBeLessThan(0.05);
    expect(meanDiff(on[0], on[11])).toBeLessThan(0.05);
  });

  it('stabilize stretches the range using a fixed measurement', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x) => {
      const v = Math.round(77 + (x / (W - 1)) * 102); // luma 0.3 .. 0.7
      return [v, v, v, 255];
    });
    const off = await depthOf(t, { brightness: 1 }, { image: img });
    const on = await depthOf(t, { brightness: 1, stabilize: true }, { image: img });
    const range = (d: Depth) => d.at(W - 1, 40) - d.at(0, 40);
    expect(range(off)).toBeLessThan(0.5);
    expect(range(on)).toBeGreaterThan(0.85);
  });

  it('moving sliders never compile a new shader', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => [x * 2, y * 2, 120, 255]);
    const mask = t.maskFn(W, HT, (x, y) => (Math.hypot(x - 64, y - 48) <= 30 ? 1 : 0));
    const flow = t.fromFn(W, HT, () => [20, 128, 0, 255]);
    const wire = { image: img, subjectMask: mask, nearer: mask, farther: mask, flow };
    const base = { preset: 'custom', ground: 0.5, room: 0.2, sky: 0.3, focus: 0.3, haze: 0.2, brightness: 0.1, color: 0.1, subject: 0.5, roundness: 0.5, motion: 0.5 };
    await t.run('depth-estimate', base, wire);
    const before = t.gpu.stats().objects.pipelinesCreated;
    const moves: Record<string, unknown>[] = [
      { ground: 0.9, horizon: 0.7, curve: 2 },
      { room: 0.6, sky: 0.8, focus: 0.9, focusSpread: 0.1, haze: 0.9 },
      { brightness: -0.6, color: -0.4, pickColor: [0, 1, 0, 1], motionScale: 40, motion: 0.9 },
      { subject: 0.9, pull: 0.9, roundness: 0.9, domeSize: 0.3 },
      { smooth: 0.9, edge: 0.2, detail: 0.7, contrast: 2, gamma: 1.6, nearLevel: 0.8, farLevel: 0.1, invert: true, paint: 0.9 },
      { stabilize: true, analysisAt: 1 },
    ];
    for (const m of moves) await t.run('depth-estimate', { ...base, ...m }, wire);
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
  });
});

describe('conventions', () => {
  it('TypeScript helpers round-trip and match the splat reading (white = near)', () => {
    const r = { near: 3.5, far: 5.5 };
    expect(pictureToScene(1, r)).toBe(3.5);
    expect(pictureToScene(0, r)).toBe(5.5);
    for (const d of [0, 0.2, 0.5, 0.93, 1]) expect(sceneToPicture(pictureToScene(d, r), r)).toBeCloseTo(d, 9);
    expect(sceneToPicture(2, r)).toBe(1);
    expect(sceneToPicture(9, r)).toBe(0);
  });

  it('Depth Convert: scene distance -> depth map -> scene distance, misses are far, invert flips', T, async () => {
    const t = await H();
    // 8-bit stand-in for a scene depth: r = distance in units (0.1 .. 1.0), a = hit
    const scene = t.fromFn(W, HT, (x) => (x < 100 ? [Math.round(((0.1 + (x / 99) * 0.9) * 255)), 0, 0, 255] : [0, 0, 0, 0]));
    const toPic = await t.run('depth-convert', { mode: 'scene-to-picture', near: 0.1, far: 1 }, { depth: scene });
    const pic = toPic.depth as ImageValue;
    t.gpu.retain(pic.texture);
    const p = await readHalf(t, pic);
    expect(p[(40 * W + 0) * 4]).toBeCloseTo(1, 2); // nearest distance = white
    expect(p[(40 * W + 99) * 4]).toBeCloseTo(0, 2); // farthest = black
    expect(p[(40 * W + 120) * 4]).toBe(0); // a miss is infinitely far
    const back = await t.run('depth-convert', { mode: 'picture-to-scene', near: 0.1, far: 1 }, { depth: pic });
    const s = await readHalf(t, back.depth as ImageValue);
    for (const x of [0, 30, 60, 99]) expect(s[(40 * W + x) * 4]).toBeCloseTo(0.1 + (x / 99) * 0.9, 1);
    const inv = await t.run('depth-convert', { mode: 'scene-to-picture', near: 0.1, far: 1, invert: true }, { depth: scene });
    const pi = await readHalf(t, inv.depth as ImageValue);
    expect(pi[(40 * W + 0) * 4]).toBeCloseTo(0, 2);
  });

  it('Picture to Splats reads Depth from Picture as white = near (inverting the encoding mirrors the result)', T, async () => {
    const t = await H();
    const img = t.fromFn(W, HT, (x, y) => [80 + x, 90 + y, 100, 255]);
    const dep = (await t.run('depth-estimate', { ...ISO, ground: 1, horizon: 0 }, { image: img })).depth as ImageValue;
    t.gpu.retain(dep.texture);
    const inv = (await t.run('depth-estimate', { ...ISO, ground: 1, horizon: 0, invert: true }, { image: img })).depth as ImageValue;
    t.gpu.retain(inv.texture);
    const sp = { density: 128, edgeBreak: 0 };
    const a = await t.run('image-to-splats', { ...sp, depthEncoding: 'luma-near-white' }, { image: img, depth: dep });
    const b = await t.run('image-to-splats', { ...sp, depthEncoding: 'luma-near-black' }, { image: img, depth: inv });
    expect(await t.diff(a.image as ImageValue, b.image as ImageValue)).toBeLessThan(0.5);
  });
});

describe('integration: Depth from Picture -> Picture to Splats', () => {
  const blob = (px: { data: Uint8ClampedArray; width: number; height: number }, rgb: [number, number, number], tol = 60) => {
    let n = 0;
    let sx = 0;
    for (let y = 0; y < px.height; y++)
      for (let x = 0; x < px.width; x++) {
        const i = (y * px.width + x) * 4;
        if (px.data[i + 3] > 200 && Math.abs(px.data[i] - rgb[0]) < tol && Math.abs(px.data[i + 1] - rgb[1]) < tol && Math.abs(px.data[i + 2] - rgb[2]) < tol) (n++, (sx += x + 0.5));
      }
    return { n, cx: n ? sx / n : NaN };
  };

  it('the subject moves more than the background when the camera moves (and not at all differently with no depth)', T, async () => {
    const t = await H();
    const IW = 192;
    const IH = 128;
    const subjectAt = (x: number, y: number) => Math.hypot(x - 96, y - 74) < 30;
    const marker = (x: number, y: number) => x >= 20 && x < 50 && y >= 16 && y < 40;
    const picture = t.fromFn(IW, IH, (x, y) => (subjectAt(x, y) ? [255, 0, 0, 255] : marker(x, y) ? [0, 255, 0, 255] : [110, 110, 110, 255]));
    const mask = t.maskFn(IW, IH, (x, y) => (subjectAt(x, y) ? 1 : 0));
    const CAP = { position: [0, 0, -4.5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 40 };

    const build = (withDepth: boolean, camera: CameraValue) => {
      let graph = createGraph('t');
      graph.project = { ...graph.project, width: IW, height: IH, fps: 10, duration: 2, loop: true };
      const sp = addNode(graph, t.registry, 'image-to-splats', { x: 0, y: 0 }, { density: 192, near: 3.5, far: 5.5, edgeBreak: 0.3, guess: 'flat' });
      graph = sp.graph;
      const wire = (srcType: string, port: string, dst = sp.node.id, out = 'out') => {
        const s = addNode(graph, t.registry, srcType);
        graph = connect(s.graph, t.registry, { node: s.node.id, port: out }, { node: dst, port });
      };
      wire(t.source(picture), 'image');
      wire(cameraSource(t, camera), 'camera');
      if (withDepth) {
        const de = addNode(graph, t.registry, 'depth-estimate', { x: 0, y: 0 }, { ...ISO, ground: 0.4, horizon: 0.2, subject: 1, pull: 1, roundness: 0.3, domeSize: 0.2, smooth: 0.4, detail: 0.2, quality: 'normal' });
        graph = de.graph;
        const pic = addNode(graph, t.registry, t.source(picture));
        graph = connect(pic.graph, t.registry, { node: pic.node.id, port: 'out' }, { node: de.node.id, port: 'image' });
        const mk = addNode(graph, t.registry, t.source(mask));
        graph = connect(mk.graph, t.registry, { node: mk.node.id, port: 'out' }, { node: de.node.id, port: 'subjectMask' });
        graph = connect(graph, t.registry, { node: de.node.id, port: 'depth' }, { node: sp.node.id, port: 'depth' });
      }
      return { graph, id: sp.node.id };
    };
    const shot = async (withDepth: boolean, dx: number) => {
      const g = build(withDepth, cam({ ...CAP, position: [dx, 0, -4.5], target: [dx, 0, 0] }));
      const r = await t.engine.evaluate({ graph: g.graph, node: g.id, port: 'image' });
      if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
      return t.pixels(r.value as ImageValue);
    };
    const shifts = async (withDepth: boolean) => {
      const base = await shot(withDepth, 0);
      const moved = await shot(withDepth, 0.4);
      return {
        red: blob(moved, [255, 0, 0]).cx - blob(base, [255, 0, 0]).cx,
        green: blob(moved, [0, 255, 0]).cx - blob(base, [0, 255, 0]).cx,
        redPx: moved,
      };
    };
    const flatCard = await shifts(false);
    const layered = await shifts(true);
    // a flat card moves as one piece; with depth the subject slides further than the background marker
    expect(Math.abs(flatCard.red - flatCard.green)).toBeLessThan(1.5);
    expect(Math.abs(layered.red)).toBeGreaterThan(Math.abs(layered.green) * 1.25);
    expect(Math.sign(layered.red)).toBe(Math.sign(layered.green));
    writePng('depth/integration-subject-moved', layered.redPx);
    void PNG_DIR;
  });
});
