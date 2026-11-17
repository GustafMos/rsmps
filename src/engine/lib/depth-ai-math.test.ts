import { describe, expect, it } from 'vitest';
import {
  alignAffine,
  alignChain,
  blendFrames,
  clipRange,
  fromU16,
  halfToFloat,
  interpPlan,
  mapCentre,
  modelDims,
  normaliseDepth,
  percentile,
  processedFrames,
  resizeChannels,
  rgbaToInput,
  robustRange,
  temporalBlend,
  toU16,
} from './depth-ai-math';

/** A deterministic pseudo-random sequence (no Math.random in tests). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A synthetic "scene": a smooth ramp plus a bump, in model-like relative units. */
function scene(w: number, h: number, bump = 0): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = x / w + 0.5 * (y / h) + (x > w * 0.6 && y < h * 0.4 ? 0.8 + bump : 0);
  return out;
}

describe('model sizes and resizing', () => {
  it('keeps the aspect ratio, multiples of 14, long side about the request', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [640, 480], [100, 100], [4000, 300], [64, 64]]) {
      for (const long of [392, 518, 700]) {
        const d = modelDims(w, h, long);
        expect(d.width % 14).toBe(0);
        expect(d.height % 14).toBe(0);
        expect(Math.max(d.width, d.height)).toBeGreaterThanOrEqual(long - 7);
        expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(long + 7);
        // aspect error stays within one multiple on the short side
        const shortWant = (Math.min(w, h) * long) / Math.max(w, h);
        expect(Math.abs(Math.min(d.width, d.height) - shortWant)).toBeLessThanOrEqual(14);
      }
    }
    expect(modelDims(1920, 1080, 518)).toEqual({ width: 518, height: 294 });
    expect(modelDims(1000, 1, 518).height).toBe(14); // never below one multiple
  });

  it('maps pixel centres of the destination into the source and back (round trip of an enlarge then a shrink)', () => {
    expect(mapCentre(0, 100, 50)).toBeCloseTo(0.5, 6);
    expect(mapCentre(49, 100, 50)).toBeCloseTo(98.5, 6);
    // a smooth field survives 100 -> 518 -> 100 within a small error
    const w = 100;
    const f = new Float32Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) f[y * w + x] = Math.sin(x / 15) * 0.5 + y / w;
    const up = resizeChannels(f, w, w, 518, 518, 1);
    const back = resizeChannels(up, 518, 518, w, w, 1);
    let worst = 0;
    for (let i = 0; i < f.length; i++) worst = Math.max(worst, Math.abs(f[i] - back[i]));
    expect(worst).toBeLessThan(0.03);
  });

  it('shrinking averages instead of point sampling, same size is a copy, channels stay separate', () => {
    const src = new Float32Array(8 * 8 * 2);
    for (let i = 0; i < 64; i++) {
      src[i * 2] = i % 2 ? 1 : 0; // alternating columns in channel 0
      src[i * 2 + 1] = 0.25;
    }
    const half = resizeChannels(src, 8, 8, 2, 2, 2);
    for (let i = 0; i < 4; i++) {
      expect(half[i * 2]).toBeCloseTo(0.5, 1);
      expect(half[i * 2 + 1]).toBeCloseTo(0.25, 5);
    }
    expect(Array.from(resizeChannels(src, 8, 8, 8, 8, 2))).toEqual(Array.from(src));
  });

  it('the input tensor is planar, normalised with the model mean / std, and ignores alpha', () => {
    const rgba = new Uint8ClampedArray([255, 0, 128, 7, 0, 255, 128, 200]); // 2 x 1
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const t = rgbaToInput(rgba, 2, 1, 2, 1, mean, std);
    expect(t.length).toBe(6);
    expect(t[0]).toBeCloseTo((1 - mean[0]) / std[0], 5); // R of pixel 0
    expect(t[1]).toBeCloseTo((0 - mean[0]) / std[0], 5); // R of pixel 1
    expect(t[2]).toBeCloseTo((0 - mean[1]) / std[1], 5); // G plane
    expect(t[4]).toBeCloseTo((128 / 255 - mean[2]) / std[2], 5); // B plane
  });
});

describe('robust normalisation', () => {
  it('percentiles ignore non-finite values and a few outliers', () => {
    const v = new Float32Array(1000).map((_, i) => i / 999);
    v[3] = NaN;
    v[10] = 1e9;
    v[11] = -1e9;
    const r = robustRange(v);
    expect(r.lo).toBeGreaterThan(0.005);
    expect(r.lo).toBeLessThan(0.04);
    expect(r.hi).toBeGreaterThan(0.95);
    expect(r.hi).toBeLessThan(1.0);
    expect(percentile([], 0.5)).toBe(0);
    expect(robustRange(new Float32Array(50).fill(2)).hi).toBeGreaterThan(2); // a flat picture does not divide by zero
  });

  it('normalise maps the robust range into 0..1 with a little headroom and clamps', () => {
    const out = normaliseDepth([-5, 0, 0.5, 1, 9], { lo: 0, hi: 1 });
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(1);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(0.1);
    expect(out[2]).toBeCloseTo(0.5, 5);
  });

  it('fits the affine change between two frames from the static pixels, not from a moving object', () => {
    const w = 64;
    const h = 48;
    const ref = scene(w, h);
    const cur = scene(w, h, 0.5); // the bump moved nearer: those pixels really changed
    for (let i = 0; i < cur.length; i++) cur[i] = cur[i] * 0.4 + 3; // the model's flicker: scale 0.4, shift 3
    const a = alignAffine(ref, cur);
    expect(a.scale).toBeCloseTo(2.5, 1);
    expect(a.shift).toBeCloseTo(-7.5, 0);
  });

  it('a flickering scale / shift sequence of the same scene comes out stable after alignment and clip normalisation', () => {
    const w = 64;
    const h = 36;
    const rand = rng(7);
    const base = scene(w, h);
    const raws: Float32Array[] = [];
    for (let k = 0; k < 24; k++) {
      const scale = 0.4 + 2.2 * rand();
      const shift = -3 + 6 * rand();
      const noise = 0.004;
      raws.push(base.map((v) => v * scale + shift + (rand() - 0.5) * noise * scale));
    }
    const naive = raws.map((r) => {
      const q = robustRange(r);
      return normaliseDepth(r, q);
    });
    const { frames } = alignChain(raws);
    const range = clipRange(frames);
    const stable = frames.map((f) => normaliseDepth(f, range));
    const spread = (seq: Float32Array[]) => {
      // largest difference between any frame and the mean frame
      let worst = 0;
      for (let p = 0; p < seq[0].length; p += 7) {
        let m = 0;
        for (const f of seq) m += f[p];
        m /= seq.length;
        for (const f of seq) worst = Math.max(worst, Math.abs(f[p] - m));
      }
      return worst;
    };
    expect(spread(stable)).toBeLessThan(0.03);
    // per-frame percentiles alone are much steadier than raw numbers but can still jitter; alignment must be at least as good
    expect(spread(stable)).toBeLessThanOrEqual(spread(naive) + 1e-6);
    // and the whole range is used
    expect(Math.max(...stable[0])).toBeGreaterThan(0.95);
    expect(Math.min(...stable[0])).toBeLessThan(0.05);
  });

  it('keeps a slow real change: a push-in that brightens the near part over the clip is still there at the end', () => {
    const w = 48;
    const h = 32;
    const raws: Float32Array[] = [];
    for (let k = 0; k < 20; k++) {
      const near = 0.8 + 0.04 * k; // the nearest object comes nearer
      const f = scene(w, h);
      for (let i = 0; i < f.length; i++) if (f[i] > 1.3) f[i] += near - 0.8;
      raws.push(f.map((v) => v * (1 + 0.3 * Math.sin(k)) + 0.5 * Math.cos(k)));
    }
    const { frames } = alignChain(raws);
    const range = clipRange(frames);
    const first = normaliseDepth(frames[0], range);
    const last = normaliseDepth(frames[19], range);
    let a = 0;
    let b = 0;
    for (let i = 0; i < first.length; i++) {
      if (scene(w, h)[i] > 1.3) {
        a += first[i];
        b += last[i];
      }
    }
    expect(b).toBeGreaterThan(a);
  });

  it('temporal blend calms noise, keeps a sudden real change (a moving edge), and does not shift anything in time', () => {
    const px = 400;
    const rand = rng(3);
    const frames: Float32Array[] = [];
    for (let k = 0; k < 16; k++) {
      const f = new Float32Array(px).fill(0.5);
      for (let i = 0; i < px; i++) f[i] += (rand() - 0.5) * 0.06;
      // a step edge that exists from frame 8 on
      if (k >= 8) for (let i = 200; i < px; i++) f[i] += 0.5;
      frames.push(f);
    }
    const noise = (f: Float32Array) => {
      let s = 0;
      for (let i = 20; i < 180; i++) s += Math.abs(f[i] - 0.5);
      return s / 160;
    };
    const before = noise(frames[4]);
    temporalBlend(frames, 0.8);
    expect(noise(frames[4])).toBeLessThan(before * 0.75);
    // the edge at frame 8 stays sharp (not smeared into frame 7)
    expect(frames[7][300]).toBeLessThan(0.65);
    expect(frames[8][300]).toBeGreaterThan(0.85);
    // amount 0 does nothing
    const g = [Float32Array.of(0.1, 0.9), Float32Array.of(0.9, 0.1)];
    temporalBlend(g, 0);
    expect(Array.from(g[0])).toEqual([Float32Array.of(0.1, 0.9)[0], Float32Array.of(0.1, 0.9)[1]]);
  });
});

describe('frame plan and storage', () => {
  it('lists the processed frames and plans the interpolation for every N', () => {
    expect(processedFrames(12, 3)).toEqual([0, 3, 6, 9]);
    expect(processedFrames(10, 4)).toEqual([0, 4, 8]);
    expect(processedFrames(5, 1)).toEqual([0, 1, 2, 3, 4]);
    expect(processedFrames(1, 30)).toEqual([0]);
    // 12 frames, every 3, stored 4, looping
    expect(interpPlan(0, 3, 4, 12, true)).toEqual({ a: 0, b: 1, t: 0 });
    const p1 = interpPlan(1, 3, 4, 12, true);
    expect(p1.a).toBe(0);
    expect(p1.b).toBe(1);
    expect(p1.t).toBeCloseTo(1 / 3, 6);
    expect(interpPlan(3, 3, 4, 12, true)).toMatchObject({ a: 1, b: 2, t: 0 });
    const tail = interpPlan(10, 3, 4, 12, true); // after the last stored frame (9): towards frame 0 of the next pass
    expect(tail.a).toBe(3);
    expect(tail.b).toBe(0);
    expect(tail.t).toBeCloseTo(1 / 3, 6);
    // not looping: hold the last stored frame
    expect(interpPlan(11, 3, 4, 12, false)).toEqual({ a: 3, b: 3, t: 0 });
    // every = 1 and a single stored frame never blend
    expect(interpPlan(5, 1, 12, 12, true)).toEqual({ a: 5, b: 5, t: 0 });
    expect(interpPlan(7, 1, 1, 12, true)).toEqual({ a: 0, b: 0, t: 0 });
    // frame numbers past the end wrap or clamp
    expect(interpPlan(13, 1, 12, 12, true).a).toBe(1);
    expect(interpPlan(40, 1, 12, 12, false).a).toBe(11);
  });

  it('blends two frames', () => {
    const o = new Float32Array(2);
    expect(Array.from(blendFrames(Float32Array.of(0, 1), Float32Array.of(1, 0), 0.25, o))).toEqual([0.25, 0.75]);
    expect(Array.from(blendFrames(Float32Array.of(0.3, 0.4), Float32Array.of(1, 0), 0, o))).toEqual([Float32Array.of(0.3)[0], Float32Array.of(0.4)[0]]);
  });

  it('16 bit storage keeps more than 8 bit: 65536 steps, round trip within half a step', () => {
    const src = new Float32Array(1000).map((_, i) => i / 999);
    const u = toU16(src);
    const back = fromU16(u, 0, src.length);
    let worst = 0;
    for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(src[i] - back[i]));
    expect(worst).toBeLessThanOrEqual(0.5 / 65535 + 1e-7);
    expect(new Set(Array.from(u)).size).toBe(1000); // a smooth gradient of 1000 values would collapse to 256 in 8 bit
    expect(Array.from(toU16(Float32Array.of(-1, 2)))).toEqual([0, 65535]);
  });

  it('decodes half floats', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0x3555)).toBeCloseTo(1 / 3, 3);
  });
});
