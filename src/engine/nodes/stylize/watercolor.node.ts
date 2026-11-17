import { defineNode } from '../../define';
import { SOBEL_WGSL } from '../../lib/fx-util';
import { gaussianBlur } from '../filter/blur.node';
import { kuwaharaFilter } from './kuwahara.node';

export default defineNode({
  id: 'watercolor',
  title: 'Watercolor',
  category: 'stylize',
  description: 'Soft painted look: flattened color washes, darker pigment pooling at edges and a touch of paper grain.',
  keywords: ['paint', 'painting', 'wash', 'artistic', 'paper', 'ink'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    radius: { type: 'number', default: 3, min: 0.5, max: 30, step: 0.5, unit: 'px', label: 'Brush size' },
    softness: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Softness' },
    edges: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Edge darkening', hint: 'Pigment pooling along outlines.' },
    paper: { type: 'number', default: 0.18, min: 0, max: 1, step: 0.01, label: 'Paper texture' },
    paperScale: { type: 'number', default: 3, min: 0.5, max: 40, step: 0.5, unit: 'px', label: 'Paper grain size' },
    strength: { type: 'number', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Strength' },
    seed: { type: 'number', default: 0, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${p.radius} px · ${Math.round(p.strength * 100)}%`,
  render(ctx) {
    const p = ctx.params;
    if (p.strength <= 0) return { image: ctx.in.image };
    const k = kuwaharaFilter(ctx.gpu, ctx.in.image, p.radius);
    const soft = gaussianBlur(ctx.gpu, k, Math.max(0.5, p.radius * p.softness));
    const image = ctx.gpu.pass({
      label: 'watercolor',
      size: ctx.in.image,
      textures: { src: ctx.in.image, k, soft },
      uniforms: {
        softness: p.softness,
        strength: p.strength,
        edges: p.edges,
        paper: p.paper,
        pscale: Math.max(0.5, p.paperScale),
        eoff: Math.max(1, p.radius * 0.5),
        jitter: p.seed * 37.1 + 11.3,
      },
      wgsl: /* wgsl */ `${SOBEL_WGSL}
fn fbm3(p0: vec2f) -> f32 {
  var p = p0; var sum = 0.0; var amp = 0.5;
  for (var i = 0; i < 3; i++) { sum += amp * vnoise(p); amp *= 0.5; p = p * 2.03 + 5.7; }
  return sum / 0.875;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let orig = textureSampleLevel(src, smpNearest, uv, 0.0);
  let kk = textureSampleLevel(k, smp, uv, 0.0);
  let ss = textureSampleLevel(soft, smp, uv, 0.0);
  var base = mix(mix(kk, ss, u.softness * 0.7), orig, 1.0 - u.strength);
  let g = sobel2(soft, uv, vec2f(u.eoff) / u.size);
  let pool = smoothstep(0.03, 0.3, g.x) * u.edges;
  var rgb = unpremul(base).rgb;
  rgb = rgb * (1.0 - 0.45 * pool) * mix(vec3f(1.0), vec3f(0.92, 0.95, 1.05), pool);
  let n = fbm3(px / u.pscale + u.jitter) - 0.5;
  rgb += n * u.paper * 0.27 * u.strength;
  return premul(vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), orig.a));
}`,
    });
    return { image };
  },
});
