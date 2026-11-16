import { defineNode } from '../../define';
import { mod } from '../../lib/util-time';
import type { ImageValue } from '../../types';

/**
 * Video feedback: out[n] = over(in[n], T(out[n-1])), T = warp + zoom + rotate + shift + hue + blur + gain.
 *
 * Nodes are stateless, so the recursion is a BOUNDED FOLD that is a pure function of the frame number:
 * out[f] folds the input frames start(f)..f, starting from transparent, where start(f) = (floor(f / K) - 1) * K (clamped at 0
 * when the project does not loop). The trail therefore remembers K to 2K frames, and out[f] = step(in[f], out[f-1]) whenever
 * start(f) == start(f-1). That identity is what the kernel seam `ctx.previous()` exploits: playing forward costs ONE pass and
 * ONE input evaluation per frame; after a scrub (previous frame not cached) the same pixels come from the fold, which costs up
 * to 2K passes and pulls. Results are identical either way (tested), so the cache is purely an optimisation.
 * A still input needs no pulls and no clock: the fold of identical frames, K passes, cached like any static result.
 */
export default defineNode({
  id: 'feedback',
  title: 'Feedback',
  category: 'time',
  description:
    'Endless video feedback: every frame is laid over a zoomed, turned, shifted, recoloured and softened copy of the previous result, so trails spiral into tunnels. Memory is a bounded number of frames, so any frame renders the same in any order, and a looping project loops. For a fixed number of fading copies use Frame Echo or Warped Echo.',
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
      hint: 'In frames. Trail memory is this many to twice this many frames. Cost: playing forward = 1 pass and 1 input evaluation per frame (the previous result is reused). The first frame after a jump in time rebuilds the trail from up to 2x this many frames (that many passes and input evaluations). A still input needs no input evaluations at all.',
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
    const f = t.loop ? mod(t.frame, total) : Math.max(0, t.frame);
    const start = (g: number) => (t.loop ? (Math.floor(g / K) - 1) * K : Math.max(0, (Math.floor(g / K) - 1) * K));

    // A wired number that moves with time changes the recursion itself: the cached previous frame would be stale.
    const paramsMove = Object.keys(p).some((k) => ctx.inputVaries(k as never));
    const chain = f > 0 && start(f) === start(f - 1) && !paramsMove;
    const prev = chain ? ctx.previous() : null;
    if (prev && prev.width === src.width && prev.height === src.height) return { image: step(src, prev) };

    let acc: ImageValue | null = null;
    for (let g = start(f); g <= f; g++) {
      let frame: ImageValue = src;
      if (g !== f) {
        const at = t.loop ? mod(g, total) : g;
        const v = (await ctx.pull('image', { seconds: at / t.fps })) as ImageValue | null;
        if (v && v.width === src.width && v.height === src.height) frame = v;
      }
      const next: ImageValue = step(frame, acc);
      if (acc) gpu.recycle(acc);
      acc = next;
    }
    return { image: acc as ImageValue };
  },
});
