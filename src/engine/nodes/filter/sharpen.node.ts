import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

export default defineNode({
  id: 'sharpen',
  title: 'Sharpen',
  category: 'filter',
  description: 'Unsharp mask: boosts local contrast around edges to make details crisper.',
  keywords: ['unsharp', 'crisp', 'detail', 'clarity', 'focus'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    amount: { type: 'number', default: 1, min: 0, max: 5, step: 0.05, label: 'Amount' },
    radius: { type: 'number', default: 1.5, min: 0.5, max: 50, step: 0.1, unit: 'px', label: 'Radius' },
    threshold: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.005, label: 'Threshold', hint: 'Ignore differences smaller than this, so flat areas and noise stay untouched.' },
  },
  summary: (p) => `${p.amount} × ${p.radius} px`,
  render(ctx) {
    const p = ctx.params;
    if (p.amount <= 0) return { image: ctx.in.image };
    const blurred = gaussianBlur(ctx.gpu, ctx.in.image, p.radius);
    const image = ctx.gpu.pass({
      label: 'sharpen',
      size: ctx.in.image,
      textures: { src: ctx.in.image, blurred },
      uniforms: { amount: p.amount, threshold: p.threshold },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let b = textureSampleLevel(blurred, smp, uv, 0.0);
  var d = s.rgb - b.rgb;
  let m = max(abs(d.r), max(abs(d.g), abs(d.b)));
  d = d * smoothstep(u.threshold, u.threshold + 0.02 + u.threshold * 0.5, m);
  return vec4f(clamp(s.rgb + d * u.amount, vec3f(0.0), vec3f(s.a)), s.a);
}`,
    });
    return { image };
  },
});
