import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

export default defineNode({
  id: 'despeckle',
  title: 'Despeckle',
  category: 'filter',
  description:
    'Removes isolated dust and specks from a cleaned drawing while leaving connected line art alone. A mark is a speck when it is no bigger than the size below and has no other ink nearby.',
  keywords: ['dust', 'speck', 'noise', 'scan', 'clean', 'spots', 'remove dots', 'denoise', 'dirt', 'artifacts'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    size: { type: 'number', default: 4, min: 0.5, max: 60, softMax: 30, step: 0.5, unit: 'px', label: 'Largest speck', hint: 'Marks up to this wide are removed when nothing else is around them.' },
    threshold: { type: 'number', default: 0.3, min: 0.02, max: 0.95, step: 0.01, label: 'Ink threshold', hint: 'How dark a pixel must be to count as a mark.' },
    lightSpecks: { type: 'bool', default: false, label: 'Also fill light pinholes', hint: 'Small paper-coloured holes inside dark areas are filled in.' },
  },
  summary: (p) => `specks up to ${p.size} px`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const run = (img: typeof src, invert: boolean) => {
      const mask = gpu.pass({
        label: 'despeckle-mask',
        size: img,
        textures: { src: img },
        uniforms: { thr: p.threshold, invert },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  var m = f32((1.0 - (luma(s.rgb) + (1.0 - s.a))) > u.thr);
  if (u.invert > 0.5) { m = 1.0 - m; }
  return vec4f(m, m, m, 1.0);
}`,
      });
      const soft = gaussianBlur(gpu, mask, Math.max(0.5, p.size * 0.45));
      return gpu.pass({
        label: 'despeckle',
        size: img,
        textures: { src: img, mask, soft },
        uniforms: { s: p.size },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let me = textureSampleLevel(src, smpNearest, uv, 0.0);
  if (textureSampleLevel(mask, smpNearest, uv, 0.0).r < 0.5) { return me; }
  var acc = vec4f(0.0);
  var n = 0.0;
  for (var j = 0; j < 3; j++) {
    let r = u.s * (1.4 + 0.8 * f32(j));
    for (var i = 0; i < 24; i++) {
      let a = TAU * (f32(i) + 0.5 * f32(j)) / 24.0;
      let tuv = uv + vec2f(cos(a), sin(a)) * r / u.size;
      if (textureSampleLevel(soft, smp, tuv, 0.0).r > 0.1) { return me; }   // ink nearby: part of the drawing
      if (textureSampleLevel(mask, smpNearest, tuv, 0.0).r < 0.5) { acc += textureSampleLevel(src, smpNearest, tuv, 0.0); n += 1.0; }
    }
  }
  if (n < 1.0) { return me; }
  return acc / n;
}`,
      });
    };
    let img = run(src, false);
    if (p.lightSpecks) img = run(img, true);
    return { image: img };
  },
});
