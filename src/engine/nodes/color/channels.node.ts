import { defineNode } from '../../define';

const SOURCES = [
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
  { value: 'a', label: 'Alpha' },
  { value: 'luma', label: 'Brightness' },
  { value: 'zero', label: 'Black' },
  { value: 'one', label: 'White' },
] as const;
const INDEX: Record<string, number> = { r: 0, g: 1, b: 2, a: 3, luma: 4, zero: 5, one: 6 };
const SWAPS = ['rgb', 'rbg', 'grb', 'gbr', 'brg', 'bgr'] as const;

export default defineNode({
  id: 'channels',
  title: 'Channels',
  category: 'color',
  description: 'Shows, swaps or repacks the red, green, blue, alpha and brightness channels of an image.',
  keywords: ['extract', 'swap', 'rgb', 'alpha', 'luma to alpha', 'alpha to luma', 'pack', 'split'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    operation: {
      type: 'enum',
      default: 'extract',
      label: 'Operation',
      options: [
        { value: 'extract', label: 'Show one channel as gray' },
        { value: 'swap', label: 'Swap color channels' },
        { value: 'luma-to-alpha', label: 'Brightness to alpha' },
        { value: 'alpha-to-luma', label: 'Alpha to gray image' },
        { value: 'pack', label: 'Custom' },
      ],
    },
    channel: {
      type: 'enum',
      default: 'luma',
      label: 'Channel',
      options: SOURCES.filter((s) => s.value !== 'zero' && s.value !== 'one'),
      visibleIf: (p) => p.operation === 'extract',
    },
    swap: {
      type: 'enum',
      default: 'bgr',
      label: 'Order',
      options: SWAPS.map((s) => ({ value: s, label: s.toUpperCase() })),
      visibleIf: (p) => p.operation === 'swap',
    },
    invert: { type: 'bool', default: false, label: 'Invert alpha', visibleIf: (p) => p.operation === 'luma-to-alpha' },
    outR: { type: 'enum', default: 'r', label: 'Red from', options: SOURCES, visibleIf: (p) => p.operation === 'pack' },
    outG: { type: 'enum', default: 'g', label: 'Green from', options: SOURCES, visibleIf: (p) => p.operation === 'pack' },
    outB: { type: 'enum', default: 'b', label: 'Blue from', options: SOURCES, visibleIf: (p) => p.operation === 'pack' },
    outA: { type: 'enum', default: 'a', label: 'Alpha from', options: SOURCES, visibleIf: (p) => p.operation === 'pack' },
  },
  summary: (p) => (p.operation === 'extract' ? `Show ${p.channel}` : p.operation === 'swap' ? p.swap.toUpperCase() : p.operation),
  render(ctx) {
    const p = ctx.params;
    let m: string[] = ['r', 'g', 'b', 'a'];
    switch (p.operation) {
      case 'extract':
        m = [p.channel, p.channel, p.channel, p.channel === 'a' ? 'one' : 'a'];
        break;
      case 'swap':
        m = [...p.swap.split(''), 'a'];
        break;
      case 'luma-to-alpha':
        m = ['r', 'g', 'b', 'luma'];
        break;
      case 'alpha-to-luma':
        m = ['a', 'a', 'a', 'one'];
        break;
      default:
        m = [p.outR, p.outG, p.outB, p.outA];
    }
    const invertA = p.operation === 'luma-to-alpha' && p.invert;
    if (m.join() === 'r,g,b,a' && !invertA) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'channels',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { map: m.map((s) => INDEX[s]), invertA },
      wgsl: /* wgsl */ `
fn pick(c: vec4f, i: i32) -> f32 {
  switch (i) {
    case 0: { return c.r; }
    case 1: { return c.g; }
    case 2: { return c.b; }
    case 3: { return c.a; }
    case 4: { return luma(c.rgb); }
    case 5: { return 0.0; }
    default: { return 1.0; }
  }
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let m = vec4i(u.map + vec4f(0.1));
  var a = pick(s, m.w);
  if (u.invertA > 0.5) { a = 1.0 - a; }
  return premul(vec4f(pick(s, m.x), pick(s, m.y), pick(s, m.z), a));
}`,
    });
    return { image };
  },
});
