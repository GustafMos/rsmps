import { defineNode } from '../../define';

export default defineNode({
  id: 'invert',
  title: 'Invert',
  category: 'color',
  description: 'Turns colours into their opposites, like a photographic negative.',
  keywords: ['negative', 'opposite', 'reverse'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'rgb',
      label: 'Mode',
      options: [
        { value: 'rgb', label: 'Negative' },
        { value: 'lightness', label: 'Lightness only' },
      ],
    },
    amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' },
  },
  summary: (p) => (p.mode === 'rgb' ? 'Negative' : 'Lightness') + (p.amount < 1 ? ` · ${Math.round(p.amount * 100)}%` : ''),
  render(ctx) {
    const p = ctx.params;
    if (p.amount <= 0) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'invert',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { amount: p.amount, lightness: p.mode === 'lightness' },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var inv = vec3f(1.0) - s.rgb;
  if (u.lightness > 0.5) {
    var lab = srgbToOklab(s.rgb);
    lab.x = 1.0 - lab.x;
    inv = clamp(oklabToSrgb(lab), vec3f(0.0), vec3f(1.0));
  }
  return premul(vec4f(mix(s.rgb, inv, u.amount), s.a));
}`,
    });
    return { image };
  },
});
