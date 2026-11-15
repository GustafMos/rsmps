import { defineNode } from '../../define';
import type { ImageValue, NodeGpu } from '../../types';

/** Separable gaussian blur. Exported so other nodes (bloom, glow, feather) reuse it instead of re-implementing. */
export function gaussianBlur(gpu: NodeGpu, src: ImageValue, radiusTexels: number): ImageValue {
  if (radiusTexels < 0.05) return src;
  // Large radii: blur a downscaled copy (linear sampling) so cost stays flat.
  const down = Math.max(1, Math.floor(radiusTexels / 8));
  const w = Math.max(1, Math.round(src.width / down));
  const h = Math.max(1, Math.round(src.height / down));
  const sigma = radiusTexels / down / 2;
  const wgsl = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = u.dir / vec2f(textureDimensions(src));
  var acc = textureSampleLevel(src, smp, uv, 0.0);
  var total = 1.0;
  let n = i32(ceil(u.sigma * 3.0));
  for (var i = 1; i <= n; i += 2) {
    // two taps per fetch using linear filtering
    let w1 = exp(-0.5 * f32(i * i) / (u.sigma * u.sigma));
    let w2 = exp(-0.5 * f32((i + 1) * (i + 1)) / (u.sigma * u.sigma));
    let wsum = w1 + w2;
    let off = (f32(i) * w1 + f32(i + 1) * w2) / wsum;
    acc += (textureSampleLevel(src, smp, uv + texel * off, 0.0) + textureSampleLevel(src, smp, uv - texel * off, 0.0)) * wsum;
    total += 2.0 * wsum;
  }
  return acc / total;
}`;
  const size = { width: w, height: h, unit: src.unit / down };
  const horizontal = gpu.pass({ label: 'blur-h', size, textures: { src }, uniforms: { dir: [1, 0], sigma }, wgsl });
  const vertical = gpu.pass({ label: 'blur-v', size, textures: { src: horizontal }, uniforms: { dir: [0, 1], sigma }, wgsl });
  if (down === 1) return vertical;
  return gpu.pass({
    label: 'blur-up',
    size: src,
    textures: { src: vertical },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }',
  });
}

/**
 * EXEMPLAR — multi-pass filter with a length param. Shows: `unit: 'px'` (arrives in texels,
 * so a 480p and a 4K source blur identically), temporaries are recycled automatically.
 */
export default defineNode({
  id: 'blur',
  title: 'Blur',
  category: 'filter',
  description: 'Gaussian blur. The radius scales with the media, so batches of different resolutions match.',
  keywords: ['gaussian', 'soften', 'defocus'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    radius: { type: 'number', default: 8, min: 0, max: 400, step: 0.5, unit: 'px', label: 'Radius' },
  },
  summary: (p) => `${p.radius} px`,
  render(ctx) {
    return { image: gaussianBlur(ctx.gpu, ctx.in.image, ctx.params.radius) };
  },
});
