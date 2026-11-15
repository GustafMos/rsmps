import { defineNode } from '../../define';

export default defineNode({
  id: 'mix',
  title: 'Mix Images',
  category: 'composite',
  description: 'Cross-fade between two images. If they differ in size, image B is stretched to the size of A.',
  keywords: ['blend', 'cross dissolve', 'fade', 'lerp', 'crossfade', 'transition'],
  inputs: {
    a: { type: 'image', required: true, label: 'A' },
    b: { type: 'image', label: 'B' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    factor: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Factor', hint: '0 = only A, 1 = only B. Wire a number (e.g. Animate) to fade over time.' },
  },
  summary: (p) => `${Math.round((1 - p.factor) * 100)}% A · ${Math.round(p.factor * 100)}% B`,
  render(ctx) {
    const { a, b } = ctx.in;
    const k = ctx.params.factor;
    if (!b || k <= 0) return { image: a };
    if (k >= 1 && b.width === a.width && b.height === a.height) return { image: b };
    const same = b.width === a.width && b.height === a.height;
    const image = ctx.gpu.pass({
      label: 'mix',
      size: a,
      textures: { ta: a, tb: b },
      uniforms: { k },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(ta, smpNearest, uv, 0.0);
  let b = ${same ? 'textureSampleLevel(tb, smpNearest, uv, 0.0)' : 'sampleCrisp(tb, uv, vec2f(textureDimensions(tb)) / u.size)'};
  return mix(a, b, u.k);
}`,
    });
    return { image };
  },
});
