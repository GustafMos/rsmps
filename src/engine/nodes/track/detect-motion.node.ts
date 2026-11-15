import { defineNode } from '../../define';
import { DETECT_PARAMS } from '../../lib/track-core';
import { regionsFromStrength } from '../../lib/track-detect';
import { wrapSeconds } from '../../lib/util-time';
import { gaussianBlur } from '../filter/blur.node';

export default defineNode({
  id: 'detect-motion',
  title: 'Detect Motion',
  category: 'track',
  description:
    'Finds the areas that move, by comparing the current frame with the frame a few frames earlier. Works best with a steady camera. In a looping project the comparison wraps around the loop.',
  keywords: ['detect', 'motion', 'movement', 'difference', 'moving', 'track', 'find'],
  cpu: true,
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { regions: { type: 'regions', label: 'Regions' }, mask: { type: 'mask', label: 'Moving pixels' } },
  params: {
    frames: { type: 'number', default: 2, min: 1, max: 30, step: 1, integer: true, label: 'Compare with N frames ago', hint: 'Larger values catch slow movement but make boxes lag.' },
    threshold: { type: 'number', default: 0.1, min: 0.005, max: 1, step: 0.005, label: 'Change needed', hint: 'Smaller = more sensitive.' },
    softness: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, label: 'Softness' },
    blur: { type: 'number', default: 3, min: 0, max: 50, step: 0.5, unit: 'px', label: 'Smooth first', hint: 'Blurs both frames before comparing to ignore noise and grain.' },
    label: { type: 'string', default: 'motion', label: 'Label' },
    ...DETECT_PARAMS,
    mergeDistance: { ...DETECT_PARAMS.mergeDistance, default: 0.1 },
  },
  summary: (p) => `vs ${p.frames} frame${p.frames === 1 ? '' : 's'} ago · > ${p.threshold}`,
  async render(ctx) {
    const p = ctx.params;
    const { fps, duration, loop, seconds } = ctx.time;
    const dt = p.frames / fps;
    let target = seconds - dt;
    if (loop) target = wrapSeconds(target, duration, fps);
    else if (target < -1e-6) target = seconds + dt; // first frames: compare with the future instead of nothing
    const past = await ctx.pull('image', { seconds: Math.max(0, target) });
    const cur = gaussianBlur(ctx.gpu, ctx.in.image, p.blur);
    const prev = past && past.width === ctx.in.image.width && past.height === ctx.in.image.height ? gaussianBlur(ctx.gpu, past, p.blur) : cur;
    const mask = ctx.gpu.passMask({
      label: 'detect-motion',
      size: ctx.in.image,
      textures: { cur, prev },
      uniforms: { thr: p.threshold, soft: Math.max(p.threshold * p.softness, 0.002) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(cur, smp, uv, 0.0);
  let b = textureSampleLevel(prev, smp, uv, 0.0);
  let d = abs(a - b);
  let v = max(max(d.r, d.g), max(d.b, d.a));
  let s = clamp(0.5 + (v - u.thr) / (2.0 * u.soft), 0.0, 1.0);
  return vec4f(s, s, s, 1.0);
}`,
    });
    const items = await regionsFromStrength(ctx.gpu, mask, p, p.label);
    return { regions: { kind: 'regions', items }, mask };
  },
});
