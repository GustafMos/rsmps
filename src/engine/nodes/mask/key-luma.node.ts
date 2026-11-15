import { defineNode } from '../../define';

const CHANNELS = [
  { value: 'luma', label: 'Luma' },
  { value: 'lightness', label: 'Lightness (OKLab)' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
] as const;

export default defineNode({
  id: 'key-luma',
  title: 'Key Luma',
  category: 'mask',
  description: 'Selects pixels whose brightness (or another channel) lies between a low and a high value, with soft edges.',
  keywords: ['luminance', 'brightness', 'highlights', 'shadows', 'threshold', 'range'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    channel: { type: 'enum', default: 'luma', options: CHANNELS, label: 'Channel' },
    low: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Low' },
    high: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'High' },
    softness: { type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.005, label: 'Softness' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `${p.channel} ${p.low.toFixed(2)}-${p.high.toFixed(2)}`,
  render(ctx) {
    const p = ctx.params;
    const mask = ctx.gpu.passMask({
      label: 'key-luma',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { ch: CHANNELS.findIndex((c) => c.value === p.channel), lo: p.low, hi: Math.max(p.high, p.low), soft: Math.max(p.softness, 0.0005), inv: p.invert },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var v: f32;
  switch i32(u.ch) {
    case 1 { v = srgbToOklab(c.rgb).x; }
    case 2 { v = rgbToHsv(c.rgb).y; }
    case 3 { v = c.r; }
    case 4 { v = c.g; }
    case 5 { v = c.b; }
    default { v = luma(c.rgb); }
  }
  var m = smoothstep(u.lo - u.soft, u.lo, v) * (1.0 - smoothstep(u.hi, u.hi + u.soft, v));
  if (u.inv > 0.5) { m = 1.0 - m; }
  return vec4f(vec3f(m * c.a), 1.0);
}`,
    });
    return { mask };
  },
});
