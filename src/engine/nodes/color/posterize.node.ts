import { defineNode } from '../../define';

export default defineNode({
  id: 'posterize',
  title: 'Posterize',
  category: 'color',
  description: 'Reduces each colour channel to a few flat steps for a poster or comic look.',
  keywords: ['quantize', 'steps', 'levels', 'flat', 'reduce colours'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    steps: { type: 'number', default: 4, min: 2, max: 32, step: 1, integer: true, label: 'Steps per channel' },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength' },
  },
  summary: (p) => `${p.steps} steps`,
  render(ctx) {
    const p = ctx.params;
    if (p.strength <= 0) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'posterize',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { n: Math.max(2, Math.round(p.steps)) - 1, strength: p.strength },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let q = floor(s.rgb * u.n + 0.5) / u.n;
  return premul(vec4f(mix(s.rgb, q, u.strength), s.a));
}`,
    });
    return { image };
  },
});
