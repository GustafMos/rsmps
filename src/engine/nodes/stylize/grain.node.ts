import { defineNode } from '../../define';
import { loopFrame } from '../../lib/fx-util';

export default defineNode({
  id: 'grain',
  title: 'Film Grain',
  category: 'stylize',
  description: 'Adds film grain. The grain changes every frame but repeats exactly at the end of the loop.',
  keywords: ['noise', 'film', 'texture', 'dirt', 'analog', 'sensor'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    amount: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Amount' },
    size: { type: 'number', default: 1.5, min: 0.5, max: 20, step: 0.1, unit: 'px', label: 'Grain size' },
    monochrome: { type: 'bool', default: true, label: 'Monochrome' },
    animated: { type: 'bool', default: true, label: 'Animated' },
    hold: { type: 'number', default: 1, min: 1, max: 12, step: 1, integer: true, label: 'Change every N frames', visibleIf: (p) => p.animated === true },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${Math.round(p.amount * 100)}% · ${p.size} px${p.animated ? ' · animated' : ''}`,
  render(ctx) {
    const p = ctx.params;
    if (p.amount <= 0) return { image: ctx.in.image };
    const frame = p.animated ? loopFrame(ctx.time, p.hold) : 0;
    const image = ctx.gpu.pass({
      label: 'grain',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { amount: p.amount, gsize: Math.max(0.25, p.size), mono: p.monochrome, seed: p.seed * 7.31 + frame * 1.618 },
      wgsl: /* wgsl */ `
fn tri(c: vec2f, z: f32, k: f32) -> f32 {
  return hash31(vec3f(c, z + k * 13.7)) + hash31(vec3f(c + 7.7, z + k * 13.7 + 3.1)) - 1.0;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let cell = floor(px / u.gsize);
  var n = vec3f(tri(cell, u.seed, 0.0));
  if (u.mono < 0.5) { n = vec3f(tri(cell, u.seed, 0.0), tri(cell, u.seed, 1.0), tri(cell, u.seed, 2.0)); }
  let l = luma(s.rgb);
  let response = 1.0 - 0.6 * pow(abs(2.0 * l - 1.0), 3.0);
  return premul(vec4f(clamp(s.rgb + n * u.amount * 0.5 * response, vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
