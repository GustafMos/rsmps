import { defineNode } from '../../define';

export default defineNode({
  id: 'set-alpha',
  title: 'Set Alpha',
  category: 'composite',
  description: 'Use a mask as the image transparency: white keeps the image, black makes it see-through.',
  keywords: ['transparency', 'cutout', 'matte', 'opacity', 'alpha', 'key'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    mask: { type: 'mask', label: 'Mask' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'multiply',
      options: [
        { value: 'multiply', label: 'Multiply existing alpha' },
        { value: 'replace', label: 'Replace existing alpha' },
      ],
      label: 'Combine',
    },
    invert: { type: 'bool', default: false, label: 'Invert mask' },
  },
  summary: (p) => `${p.mode}${p.invert ? ' · inverted' : ''}`,
  render(ctx) {
    const { image, mask } = ctx.in;
    if (!mask) return { image };
    const out = ctx.gpu.pass({
      label: 'set-alpha',
      size: image,
      textures: { src: image, m: mask },
      uniforms: { inv: ctx.params.invert, replace: ctx.params.mode === 'replace' },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  var k = textureSampleLevel(m, smp, uv, 0.0).r;
  if (u.inv > 0.5) { k = 1.0 - k; }
  if (u.replace > 0.5) {
    let s = unpremul(c);
    return premul(vec4f(s.rgb, k));
  }
  return c * k;
}`,
    });
    return { image: out };
  },
});
