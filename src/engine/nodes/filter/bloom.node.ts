import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

export default defineNode({
  id: 'bloom',
  title: 'Bloom',
  category: 'filter',
  description: 'Makes bright areas glow by blurring them and adding the light back on top.',
  keywords: ['glow', 'halo', 'light bleed', 'glare', 'dreamy'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    threshold: { type: 'number', default: 0.65, min: 0, max: 1, step: 0.01, label: 'Threshold', hint: 'Only areas brighter than this glow.' },
    softness: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Softness' },
    radius: { type: 'number', default: 24, min: 0, max: 300, step: 0.5, unit: 'px', label: 'Radius' },
    intensity: { type: 'number', default: 0.8, min: 0, max: 4, step: 0.01, label: 'Intensity' },
    tint: { type: 'color', default: [1, 1, 1, 1], label: 'Glow color' },
  },
  summary: (p) => `${p.radius} px · ${p.intensity}`,
  render(ctx) {
    const p = ctx.params;
    if (p.intensity <= 0 || p.radius < 0.5) return { image: ctx.in.image };
    const bright = ctx.gpu.pass({
      label: 'bloom-bright',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { threshold: p.threshold, knee: Math.max(0.001, p.softness * 0.5) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let w = smoothstep(u.threshold - u.knee, u.threshold + u.knee, luma(unpremul(s).rgb));
  return s * w;
}`,
    });
    const tight = gaussianBlur(ctx.gpu, bright, p.radius);
    const wide = gaussianBlur(ctx.gpu, bright, p.radius * 2.5);
    const image = ctx.gpu.pass({
      label: 'bloom-add',
      size: ctx.in.image,
      textures: { src: ctx.in.image, tight, wide },
      uniforms: { intensity: p.intensity, tint: p.tint },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let g = (textureSampleLevel(tight, smp, uv, 0.0) * 0.6 + textureSampleLevel(wide, smp, uv, 0.0) * 0.5) * u.intensity;
  let a = max(s.a, min(g.a, 1.0));
  let rgb = min(s.rgb + g.rgb * u.tint.rgb, vec3f(a));
  return vec4f(rgb, a);
}`,
    });
    return { image };
  },
});
