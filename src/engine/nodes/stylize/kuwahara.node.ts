import { defineNode } from '../../define';
import type { ImageValue, NodeGpu } from '../../types';

/** Kuwahara painterly smoothing: flattens regions while keeping edges sharp. Exported so watercolor can reuse it. */
export function kuwaharaFilter(gpu: NodeGpu, src: ImageValue, radiusTexels: number): ImageValue {
  if (radiusTexels < 1) return src;
  const stride = Math.max(1, Math.ceil(radiusTexels / 6));
  const steps = Math.max(1, Math.min(6, Math.round(radiusTexels / stride)));
  return gpu.pass({
    label: 'kuwahara',
    size: src,
    textures: { src },
    uniforms: { stride, steps },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src));
  let n = i32(u.steps);
  let center = textureSampleLevel(src, smpNearest, uv, 0.0);
  var bestVar = 1e9;
  var bestRgb = vec3f(0.0);
  var bestA = 0.0;
  for (var q = 0; q < 4; q++) {
    let sx = select(-1.0, 1.0, (q & 1) == 1);
    let sy = select(-1.0, 1.0, q >= 2);
    var sum = vec3f(0.0); var sumA = 0.0; var sumL = 0.0; var sumL2 = 0.0;
    for (var j = 0; j <= n; j++) {
      for (var i = 0; i <= n; i++) {
        let o = vec2f(f32(i) * sx, f32(j) * sy) * u.stride;
        let s = textureSampleLevel(src, smpNearest, uv + o * texel, 0.0);
        let l = luma(s.rgb);
        sum += s.rgb; sumA += s.a; sumL += l; sumL2 += l * l;
      }
    }
    let cnt = f32((n + 1) * (n + 1));
    let m = sumL / cnt;
    let v = sumL2 / cnt - m * m;
    if (v < bestVar) { bestVar = v; bestRgb = sum; bestA = sumA; }
  }
  var straight = unpremul(center).rgb;
  if (bestA > 0.0001) { straight = bestRgb / bestA; }
  return premul(vec4f(clamp(straight, vec3f(0.0), vec3f(1.0)), center.a));
}`,
  });
}

export default defineNode({
  id: 'kuwahara',
  title: 'Oil Paint (Kuwahara)',
  category: 'stylize',
  description: 'Painterly smoothing that flattens detail into brush-like patches while keeping edges sharp.',
  keywords: ['painterly', 'oil', 'paint', 'brush', 'smooth', 'artistic', 'cartoon'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    radius: { type: 'number', default: 4, min: 0, max: 40, step: 0.5, unit: 'px', label: 'Brush size' },
  },
  summary: (p) => `${p.radius} px`,
  render(ctx) {
    return { image: kuwaharaFilter(ctx.gpu, ctx.in.image, ctx.params.radius) };
  },
});
