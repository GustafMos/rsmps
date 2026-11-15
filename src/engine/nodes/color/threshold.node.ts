import { defineNode } from '../../define';

export default defineNode({
  id: 'threshold',
  title: 'Threshold',
  category: 'color',
  description: 'Turns the image into two tones depending on brightness, and also outputs the result as a mask.',
  keywords: ['black and white', 'binary', 'cutoff', 'key', 'luma mask'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' }, mask: { type: 'mask', label: 'Mask' } },
  maskable: true,
  params: {
    level: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Level' },
    softness: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.005, label: 'Softness', hint: '0 = hard edge between the two tones.' },
    dark: { type: 'color', default: [0, 0, 0, 1], label: 'Dark color' },
    light: { type: 'color', default: [1, 1, 1, 1], label: 'Light color' },
  },
  summary: (p) => `Level ${p.level.toFixed(2)}`,
  render(ctx) {
    const p = ctx.params;
    const body = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let l = luma(s.rgb);
  var v = step(u.level, l);
  if (u.soft > 0.0001) { v = smoothstep(u.level - u.soft, u.level + u.soft, l); }
  MODE
}`;
    const opts = { size: ctx.in.image, textures: { src: ctx.in.image }, uniforms: { level: p.level, soft: p.softness, dark: p.dark, light: p.light } };
    const image = ctx.gpu.pass({ ...opts, label: 'threshold', wgsl: body.replace('MODE', 'return premul(vec4f(mix(u.dark.rgb, u.light.rgb, v), s.a));') });
    const mask = ctx.gpu.passMask({ ...opts, label: 'threshold-mask', wgsl: body.replace('MODE', 'let m = v * s.a; return vec4f(m, m, m, 1.0);') });
    return { image, mask };
  },
});
