import { defineNode } from '../../define';

const CHANNELS = [
  { value: 'luma', label: 'Brightness' },
  { value: 'alpha', label: 'Alpha' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
] as const;

export default defineNode({
  id: 'image-to-mask',
  title: 'Image to Mask',
  category: 'composite',
  description: 'Use one channel of an image (brightness, alpha, red, green or blue) as a mask.',
  keywords: ['luma', 'luminance', 'channel', 'matte', 'grayscale', 'extract'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    channel: { type: 'enum', default: 'luma', options: CHANNELS, label: 'Channel' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `${p.channel}${p.invert ? ' · inverted' : ''}`,
  render(ctx) {
    const { image } = ctx.in;
    const mask = ctx.gpu.passMask({
      label: 'image-to-mask',
      size: image,
      textures: { src: image },
      uniforms: { ch: CHANNELS.findIndex((c) => c.value === ctx.params.channel), inv: ctx.params.invert },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  let s = unpremul(c);
  var v = luma(s.rgb);
  let ch = i32(u.ch);
  if (ch == 1) { v = c.a; }
  else if (ch == 2) { v = s.r; }
  else if (ch == 3) { v = s.g; }
  else if (ch == 4) { v = s.b; }
  if (u.inv > 0.5) { v = 1.0 - v; }
  return vec4f(v, v, v, 1.0);
}`,
    });
    return { mask };
  },
});
