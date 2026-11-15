import { defineNode } from '../../define';

export default defineNode({
  id: 'alpha-to-mask',
  title: 'Alpha to Mask',
  category: 'composite',
  description: "Turn an image's transparency into a mask: opaque areas become white, see-through areas black.",
  keywords: ['matte', 'silhouette', 'cutout', 'transparency', 'alpha'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    threshold: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Hard cutoff', hint: '0 = keep soft edges. Above 0, anything more opaque than this becomes solid white, the rest black.' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `${p.threshold > 0 ? `cutoff ${p.threshold}` : 'soft'}${p.invert ? ' · inverted' : ''}`,
  render(ctx) {
    const { image } = ctx.in;
    const mask = ctx.gpu.passMask({
      label: 'alpha-to-mask',
      size: image,
      textures: { src: image },
      uniforms: { cut: ctx.params.threshold, inv: ctx.params.invert },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var v = textureSampleLevel(src, smpNearest, uv, 0.0).a;
  if (u.cut > 0.0) { v = select(0.0, 1.0, v >= u.cut); }
  if (u.inv > 0.5) { v = 1.0 - v; }
  return vec4f(v, v, v, 1.0);
}`,
    });
    return { mask };
  },
});
