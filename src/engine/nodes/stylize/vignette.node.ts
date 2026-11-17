import { defineNode } from '../../define';

export default defineNode({
  id: 'vignette',
  title: 'Vignette',
  category: 'stylize',
  description: 'Darkens (or tints) the corners and edges to draw the eye toward the center.',
  keywords: ['corner', 'lens', 'darken', 'frame', 'focus', 'spotlight'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    amount: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Amount' },
    radius: { type: 'number', default: 0.55, min: 0, max: 1.5, step: 0.01, unit: 'norm', label: 'Radius', hint: '0 = center, 1 = corner of the frame. The vignette starts here.' },
    softness: { type: 'number', default: 0.6, min: 0.01, max: 1.5, step: 0.01, label: 'Softness' },
    roundness: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Roundness', hint: '0 = follows the frame shape, 1 = perfect circle.' },
    color: { type: 'color', default: [0, 0, 0, 1], label: 'Color' },
  },
  summary: (p) => `${Math.round(p.amount * 100)}%`,
  render(ctx) {
    const p = ctx.params;
    if (p.amount <= 0) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'vignette',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { amount: p.amount, radius: p.radius, soft: p.softness, round: p.roundness, color: p.color },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var c = uv - 0.5;
  let aspect = u.size.x / u.size.y;
  // frame-shaped (ellipse fitted to the frame) blended with a true circle
  let fitted = c * 2.0;
  let circle = c * vec2f(aspect, 1.0) * 2.0 / max(aspect, 1.0);
  let q = mix(fitted, circle, u.round);
  let d = length(q) / 1.41421356;
  let v = smoothstep(u.radius, u.radius + u.soft, d) * u.amount * u.color.a;
  return premul(vec4f(mix(s.rgb, u.color.rgb, v), s.a));
}`,
    });
    return { image };
  },
});
