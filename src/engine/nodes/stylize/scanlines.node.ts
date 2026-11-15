import { defineNode } from '../../define';

export default defineNode({
  id: 'scanlines',
  title: 'Scanlines',
  category: 'stylize',
  description: 'Draws evenly spaced dark lines across the image, optionally scrolling like an old monitor.',
  keywords: ['crt', 'lines', 'television', 'retro', 'interlace', 'stripes'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    spacing: { type: 'number', default: 4, min: 1.5, max: 100, step: 0.5, unit: 'px', label: 'Line spacing' },
    strength: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Strength' },
    thickness: { type: 'number', default: 0.5, min: 0.05, max: 0.95, step: 0.01, label: 'Line thickness', hint: 'Fraction of each row taken by the dark line.' },
    softness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Softness' },
    vertical: { type: 'bool', default: false, label: 'Vertical lines' },
    cycles: { type: 'number', default: 0, min: -32, max: 32, step: 1, integer: true, unit: 'cycles', label: 'Scroll (lines per loop)', hint: 'Whole number of line spacings the pattern moves in one loop. 0 = still.' },
  },
  summary: (p) => `${p.spacing} px · ${Math.round(p.strength * 100)}%${p.cycles ? ' · scrolling' : ''}`,
  render(ctx) {
    const p = ctx.params;
    if (p.strength <= 0) return { image: ctx.in.image };
    const scroll = p.cycles !== 0 ? Math.round(p.cycles) * ctx.time.phase : 0;
    const image = ctx.gpu.pass({
      label: 'scanlines',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { spacing: p.spacing, strength: p.strength, thickness: p.thickness, soft: Math.max(0.02, p.softness * 0.5), vertical: p.vertical, scroll },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let coord = select(px.y, px.x, u.vertical > 0.5);
  let f = fract(coord / u.spacing - u.scroll);
  // distance from the line centre (0 at centre of the dark band, 0.5 at the far edge of the row)
  let d = abs(f - 0.5) * 2.0;
  let dark = 1.0 - smoothstep(u.thickness - u.soft, u.thickness + u.soft, d);
  return premul(vec4f(s.rgb * (1.0 - u.strength * dark), s.a));
}`,
    });
    return { image };
  },
});
