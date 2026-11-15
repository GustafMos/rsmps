import { defineNode } from '../../define';

export default defineNode({
  id: 'levels',
  title: 'Levels',
  category: 'color',
  description: 'Sets the black point, white point and midtones, and limits the output range.',
  keywords: ['contrast', 'histogram', 'black point', 'white point', 'gamma', 'curves'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    inBlack: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Input black', group: 'Input' },
    inWhite: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'Input white', group: 'Input' },
    gamma: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.01, label: 'Midtones (gamma)', group: 'Input', hint: 'Above 1 brightens the midtones.' },
    outBlack: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Output black', group: 'Output' },
    outWhite: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'Output white', group: 'Output' },
  },
  summary: (p) => `${p.inBlack.toFixed(2)}–${p.inWhite.toFixed(2)} · γ ${p.gamma.toFixed(2)}`,
  render(ctx) {
    const p = ctx.params;
    if (p.inBlack === 0 && p.inWhite === 1 && p.gamma === 1 && p.outBlack === 0 && p.outWhite === 1) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'levels',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { inB: p.inBlack, inW: Math.max(p.inWhite, p.inBlack + 0.001), invGamma: 1 / p.gamma, outB: p.outBlack, outW: p.outWhite },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let x = clamp((s.rgb - vec3f(u.inB)) / (u.inW - u.inB), vec3f(0.0), vec3f(1.0));
  let g = pow(x, vec3f(u.invGamma));
  return premul(vec4f(mix(vec3f(u.outB), vec3f(u.outW), g), s.a));
}`,
    });
    return { image };
  },
});
