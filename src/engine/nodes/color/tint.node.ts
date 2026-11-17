import { defineNode } from '../../define';

export default defineNode({
  id: 'tint',
  title: 'Tint',
  category: 'color',
  description: 'Washes the image toward a chosen color while keeping its detail, optionally keeping the original brightness (sepia, cyanotype, night look). To replace colors outright (a black logo to white, one color for another) use Recolor.',
  keywords: ['colorize', 'sepia', 'wash', 'overlay color', 'monotone', 'cyanotype', 'color cast'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    color: { type: 'color', default: [0.95, 0.65, 0.35, 1], label: 'Color' },
    amount: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Amount' },
    preserveLuma: { type: 'bool', default: true, label: 'Keep brightness' },
  },
  summary: (p) => `${Math.round(p.amount * 100)}%${p.preserveLuma ? ' · keep brightness' : ''}`,
  render(ctx) {
    const p = ctx.params;
    if (p.amount <= 0) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'tint',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { color: p.color, amount: p.amount, keep: p.preserveLuma },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var tgt = u.color.rgb;
  if (u.keep > 0.5) {
    tgt = clamp(tgt * (luma(s.rgb) / max(luma(tgt), 0.02)), vec3f(0.0), vec3f(1.0));
  }
  return premul(vec4f(mix(s.rgb, tgt, u.amount), s.a));
}`,
    });
    return { image };
  },
});
