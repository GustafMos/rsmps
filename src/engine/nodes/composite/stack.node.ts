import { defineNode } from '../../define';

export default defineNode({
  id: 'stack',
  family: 'combine',
  title: 'Stack Layers',
  category: 'composite',
  description: 'Layer many images on top of each other. The list reads like a layer panel: the top row is drawn on top, the bottom row sits underneath and sets the output size. Each upper layer is fitted onto it.',
  keywords: ['layers', 'overlay', 'over', 'composite', 'combine', 'sandwich'],
  inputs: { images: { type: 'image', multi: true, label: 'Layers', order: 'top-first', firstNote: 'sets size' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    fit: {
      type: 'enum',
      default: 'contain',
      options: [
        { value: 'contain', label: 'Fit inside' },
        { value: 'cover', label: 'Fill' },
        { value: 'stretch', label: 'Stretch' },
      ],
      label: 'Top size',
    },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Top opacity' },
  },
  summary: (p) => p.fit,
  render(ctx) {
    const layers = ctx.in.images;
    if (!layers.length) return { image: null };
    const base = layers[0];
    if (layers.length === 1) return { image: base };
    const { fit, opacity } = ctx.params;
    let acc = base;
    for (let i = 1; i < layers.length; i++) {
      const fg = layers[i];
      let sx = 1;
      let sy = 1;
      if (fit === 'stretch') {
        sx = 1;
        sy = 1;
      } else {
        const k = fit === 'contain' ? Math.min(base.width / fg.width, base.height / fg.height) : Math.max(base.width / fg.width, base.height / fg.height);
        sx = (fg.width * k) / base.width;
        sy = (fg.height * k) / base.height;
      }
      const same = fg.width === base.width && fg.height === base.height;
      acc = ctx.gpu.pass({
        label: 'stack',
        size: base,
        textures: { bg: acc, fg },
        uniforms: { fsize: [sx, sy], opacity },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let b = textureSampleLevel(bg, smpNearest, uv, 0.0);
  let fuv = (uv - 0.5) / u.fsize + 0.5;
  if (fuv.x < 0.0 || fuv.y < 0.0 || fuv.x > 1.0 || fuv.y > 1.0) { return b; }
  let f = ${same ? 'textureSampleLevel(fg, smpNearest, fuv, 0.0)' : 'sampleCrisp(fg, fuv, vec2f(textureDimensions(fg)) / (u.fsize * u.size))'} * u.opacity;
  return f + b * (1.0 - f.a);
}`,
      });
    }
    return { image: acc };
  },
});
