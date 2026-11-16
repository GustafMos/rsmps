import { defineNode } from '../../define';

const SWAPS = ['none', 'rbg', 'grb', 'gbr', 'brg', 'bgr'];

export default defineNode({
  id: 'bit-crush',
  title: 'Colour Crush',
  category: 'color',
  description:
    'Throws colour precision away: a different bit depth per channel with optional dither noise, plus broken-hardware tricks like swapping channels and XOR-ing bits of each channel (emulated exactly on 8-bit values).',
  keywords: ['bit crush', 'posterize', 'bit depth', 'quantize', 'xor', 'channel swap', 'glitch', 'retro', '8-bit', 'corrupt', 'banding', 'dither noise'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    bitsR: { type: 'number', default: 3, min: 1, max: 8, step: 1, integer: true, label: 'Red bits', group: 'Bit depth' },
    bitsG: { type: 'number', default: 3, min: 1, max: 8, step: 1, integer: true, label: 'Green bits', group: 'Bit depth' },
    bitsB: { type: 'number', default: 2, min: 1, max: 8, step: 1, integer: true, label: 'Blue bits', group: 'Bit depth' },
    dither: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Dither noise', group: 'Bit depth', hint: '0 = hard bands, 1 = noise spread over one full step, which hides the banding.' },
    ditherKind: {
      type: 'enum',
      default: 'bayer',
      label: 'Noise type',
      group: 'Bit depth',
      options: [
        { value: 'bayer', label: 'Ordered (Bayer 4x4)' },
        { value: 'white', label: 'Random' },
      ],
      visibleIf: (p) => (p.dither as number) > 0,
    },
    swap: {
      type: 'enum',
      default: 'none',
      label: 'Swap channels',
      group: 'Broken hardware',
      options: [
        { value: 'none', label: 'Keep order' },
        { value: 'rbg', label: 'R B G' },
        { value: 'grb', label: 'G R B' },
        { value: 'gbr', label: 'G B R' },
        { value: 'brg', label: 'B R G' },
        { value: 'bgr', label: 'B G R' },
      ],
    },
    xorR: { type: 'number', default: 0, min: 0, max: 255, step: 1, integer: true, label: 'XOR red with', group: 'Broken hardware', hint: 'Flips these bits of the 8-bit red value (0 = off). 128 inverts the top half.' },
    xorG: { type: 'number', default: 0, min: 0, max: 255, step: 1, integer: true, label: 'XOR green with', group: 'Broken hardware' },
    xorB: { type: 'number', default: 0, min: 0, max: 255, step: 1, integer: true, label: 'XOR blue with', group: 'Broken hardware' },
    rotate: { type: 'number', default: 0, min: 0, max: 7, step: 1, integer: true, label: 'Rotate bits by', group: 'Broken hardware', hint: 'Rolls the 8 bits of every channel to the left.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', visibleIf: (p) => p.ditherKind === 'white' },
  },
  summary: (p) => `${p.bitsR}/${p.bitsG}/${p.bitsB} bits`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const clean = p.bitsR >= 8 && p.bitsG >= 8 && p.bitsB >= 8 && p.swap === 'none' && p.xorR === 0 && p.xorG === 0 && p.xorB === 0 && p.rotate === 0;
    if (clean) return { image: src };
    const image = ctx.gpu.pass({
      label: 'bit-crush',
      size: src,
      textures: { src },
      uniforms: {
        levels: [2 ** p.bitsR - 1, 2 ** p.bitsG - 1, 2 ** p.bitsB - 1],
        dither: p.dither,
        white: p.ditherKind === 'white',
        swap: Math.max(0, SWAPS.indexOf(p.swap)),
        xorm: [p.xorR, p.xorG, p.xorB],
        rot: p.rotate,
        seed: p.seed * 5.1,
      },
      wgsl: /* wgsl */ `
const BAYER4 = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var c = s.rgb;
  let ip = vec2i(floor(px));
  var bay = BAYER4;
  var t = (bay[(ip.y & 3) * 4 + (ip.x & 3)] + 0.5) / 16.0;
  if (u.white > 0.5) { t = hash21(floor(px) + vec2f(u.seed)); }
  let noise = (t - 0.5) * u.dither;
  c = clamp(floor(c * u.levels + 0.5 + noise) / u.levels, vec3f(0.0), vec3f(1.0));
  // 8-bit integer tricks
  var v = vec3u(round(c * 255.0));
  v = v ^ vec3u(u.xorm);
  let r = u32(u.rot);
  if (r > 0u) { v = ((v << vec3u(r)) | (v >> vec3u(8u - r))) & vec3u(255u); }
  c = vec3f(v) / 255.0;
  switch (i32(u.swap)) {
    case 1: { c = c.rbg; }
    case 2: { c = c.grb; }
    case 3: { c = c.gbr; }
    case 4: { c = c.brg; }
    case 5: { c = c.bgr; }
    default: {}
  }
  return premul(vec4f(c, s.a));
}`,
    });
    return { image };
  },
});
