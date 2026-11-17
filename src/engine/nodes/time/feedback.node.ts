import { defineNode } from '../../define';
import { mod } from '../../lib/util-time';
import type { ImageValue } from '../../types';

/**
 * Video feedback: out[n] = over(in[n], T(out[n-1])), T = warp + zoom + rotate + shift + hue + blur + gain.
 *
 * Nodes are stateless, so the recursion is a BOUNDED FOLD that is a pure function of the frame number: with K = Memory, time is cut into
 * epochs of K frames and out[f] folds the input frames from the start of the PREVIOUS epoch up to f, starting from transparent (the trail
 * remembers K to 2K frames). With Loop on the epochs are those of the loop (the last one takes the remainder) and the fold wraps around the
 * seam, so frame N is frame 0 exactly.
 * Playing forward is one constant cost with no restarts: the node keeps TWO windows, A (the output) and B (the one that starts with the
 * current epoch), as the picture and a hidden `carry` picture of its cache entry. Each frame both advance one pass (2 passes, one input
 * evaluation); at an epoch start A continues from B's state and B starts over (also 2 passes). `ctx.previous({ wrap: true })` and
 * `previous({ carry: true })` give last frame's states; they are the same pixels the fold produces (bit for bit, tested), so the
 * cache is purely an optimisation. After a scrub the fold costs up to ~3K passes and up to 2K input evaluations once.
 * A still input needs no pulls and no clock: the fold of identical frames, K passes, cached like any static result.
 */
export default defineNode({
  id: 'feedback',
  title: 'Feedback',
  category: 'time',
  description:
    'Endless video feedback: every frame is laid over a zoomed, turned, shifted, recolored and softened copy of the previous result, so trails spiral into tunnels. Memory is a bounded number of frames, so any frame renders the same in any order, and a looping project loops. For a fixed number of fading copies use Frame Echo or Warped Echo.',
  keywords: ['video feedback', 'trails', 'recursive', 'tunnel', 'smear', 'echo', 'infinite', 'droste', 'ghost', 'afterimage'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    warp: { type: 'image', label: 'Warp (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  usesPrevious: true,
  params: {
    memory: {
      type: 'number',
      default: 24,
      min: 1,
      max: 240,
      softMax: 120,
      step: 1,
      integer: true,
      label: 'Memory',
      hint: 'In frames. Trail memory is this many to twice this many frames. Cost: playing forward is always 2 passes and 1 input evaluation per frame, with no hiccups. The first frame after a jump in time rebuilds the trail once from up to 2x this many frames. A still input needs no input evaluations at all.',
    },
    decay: { type: 'number', default: 0.92, min: 0, max: 1, step: 0.005, label: 'Gain per frame', hint: 'How much of the previous result survives each frame. 1 never fades.' },
    zoom: { type: 'number', default: 1.02, min: 0.8, max: 1.25, step: 0.001, label: 'Zoom per frame', hint: 'Above 1 the trail grows outward, below 1 it sinks into a tunnel.' },
    rotate: { type: 'number', default: 0, min: -45, max: 45, step: 0.05, unit: 'deg', label: 'Turn per frame' },
    shiftX: { type: 'number', default: 0, min: -200, max: 200, softMax: 50, step: 0.25, unit: 'px', label: 'Shift X per frame' },
    shiftY: { type: 'number', default: 0, min: -200, max: 200, softMax: 50, step: 0.25, unit: 'px', label: 'Shift Y per frame' },
    pivotX: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Pivot X' },
    pivotY: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Pivot Y' },
    hueShift: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Hue shift', hint: 'Per frame.' },
    blur: { type: 'number', default: 0, min: 0, max: 20, softMax: 6, step: 0.1, unit: 'px', label: 'Blur per frame' },
    warpAmount: { type: 'number', default: 8, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'Warp amount', hint: 'Used when an image is wired to Warp: its red and green push the trail around (0.5 = no push).' },
  },
  summary: (p) => `${p.memory} frames · x${p.zoom} · gain ${p.decay}`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const warp = ctx.in.warp ?? null;
    const K = Math.max(1, Math.round(p.memory));
    const rot = (p.rotate * Math.PI) / 180;

    const step = (cur: ImageValue, acc: ImageValue | null): ImageValue =>
      gpu.pass({
        label: 'feedback',
        size: src,
        format: 'rgba16float',
        textures: { cur, acc, warp },
        uniforms: {
          gain: p.decay,
          scl: Math.max(0.05, p.zoom),
          rot,
          shf: [p.shiftX, p.shiftY],
          piv: [p.pivotX, p.pivotY],
          hue: p.hueShift / 360,
          blur: p.blur,
          wamt: p.warpAmount,
        },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(cur, smpNearest, uv, 0.0);
  ${acc ? '' : 'return a;'}
  ${
    acc
      ? `var tuv = uv;
  ${warp ? 'tuv += (textureSampleLevel(warp, smp, uv, 0.0).rg - 0.5) * 2.0 * u.wamt / u.size;' : ''}
  let pp = (tuv - u.piv) * u.size - u.shf;
  let c = cos(-u.rot); let s = sin(-u.rot);
  let r = vec2f(c * pp.x - s * pp.y, s * pp.x + c * pp.y) / u.scl;
  let q = u.piv + r / u.size;
  var e = textureSampleLevel(acc, smp, q, 0.0);
  if (u.blur > 0.3) {
    let t = u.blur / u.size;
    e = e * 0.25
      + (textureSampleLevel(acc, smp, q + vec2f(t.x, 0.0), 0.0) + textureSampleLevel(acc, smp, q - vec2f(t.x, 0.0), 0.0)
       + textureSampleLevel(acc, smp, q + vec2f(0.0, t.y), 0.0) + textureSampleLevel(acc, smp, q - vec2f(0.0, t.y), 0.0)) * 0.1875;
  }
  if (abs(u.hue) > 0.00001) {
    var sc = unpremul(e);
    var hsv = rgbToHsv(clamp(sc.rgb, vec3f(0.0), vec3f(1.0)));
    hsv.x = fract(hsv.x + u.hue + 1.0);
    sc = vec4f(hsvToRgb(hsv), sc.a);
    e = premul(sc);
  }
  let inside = f32(all(q >= vec2f(0.0)) && all(q <= vec2f(1.0)));
  e = e * (u.gain * inside);
  return a + e * (1.0 - a.a);`
      : ''
  }
}`,
      });

    // A still input: the fold of identical frames. No input evaluation beyond the one the kernel already did, and no clock read.
    if (!ctx.inputVaries('image')) {
      let acc: ImageValue | null = null;
      for (let i = 0; i < K; i++) {
        const next: ImageValue = step(src, acc);
        if (acc) gpu.recycle(acc);
        acc = next;
      }
      return { image: acc as ImageValue };
    }

    const t = ctx.time;
    const total = Math.max(1, Math.round(t.duration * t.fps));
    const loop = t.loop;
    const f = loop ? mod(t.frame, total) : Math.max(0, t.frame);

    // Epochs of K frames (with Loop on: floor(N / K) of them, the last one takes the remainder, so the schedule is periodic in N and the loop closes).
    // The output is the fold of the PREVIOUS epoch's start up to f (window A, K to 2K frames); window B starts with the current epoch and becomes
    // the output at the next one. Both advance one pass per frame, so playing forward costs a constant 2 passes and no restart ever happens.
    const epochs = loop ? Math.max(1, Math.floor(total / K)) : Infinity;
    const epochOf = (g: number) => Math.min(epochs - 1, Math.floor(g / K));
    const e = epochOf(f);
    const aStart = loop ? (e >= 1 ? (e - 1) * K : (epochs - 1) * K - total) : Math.max(0, (e - 1) * K);
    const bStart = e * K;
    // A new epoch begins at f (or the loop wraps): A continues from B's state of f - 1, B starts over.
    const restart = loop ? f === 0 || epochOf(f - 1) !== e : f > 0 && epochOf(f - 1) !== e;

    // A wired number (or a warp picture) that moves with time changes the recursion itself: a cached previous frame would be stale.
    const paramsMove = Object.keys(p).some((k) => ctx.inputVaries(k as never)) || ctx.inputVaries('warp');
    const fits = (v: ImageValue | null): v is ImageValue => !!v && v.width === src.width && v.height === src.height;
    if (!paramsMove && (loop ? total > 1 : f > 0)) {
      const prevB = ctx.previous({ wrap: true, carry: true });
      const prevA = restart ? null : ctx.previous({ wrap: true });
      if (fits(prevB) && (restart || fits(prevA))) {
        const a = step(src, restart ? prevB : prevA);
        const b = step(src, restart ? null : prevB);
        return { image: a, carry: b } as never;
      }
    }

    // From scratch: the same folds, A from its start and B from its own, sharing every pulled frame.
    const share = aStart === bStart;
    let accA: ImageValue | null = null;
    let accB: ImageValue | null = null;
    for (let g = aStart; g <= f; g++) {
      let frame: ImageValue = src;
      if (g !== f) {
        const at = loop ? mod(g, total) : g;
        const v = (await ctx.pull('image', { seconds: at / t.fps })) as ImageValue | null;
        if (fits(v)) frame = v;
      }
      const nextA: ImageValue = step(frame, accA);
      if (accA) gpu.recycle(accA);
      accA = nextA;
      if (!share && g >= bStart) {
        const nextB: ImageValue = step(frame, accB);
        if (accB) gpu.recycle(accB);
        accB = nextB;
      }
    }
    return { image: accA as ImageValue, carry: (share ? accA : accB) as ImageValue } as never;
  },
});
