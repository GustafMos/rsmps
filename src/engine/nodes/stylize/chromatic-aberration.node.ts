import { defineNode } from '../../define';

export default defineNode({
  id: 'chromatic-aberration',
  title: 'Chromatic Aberration',
  category: 'stylize',
  description: 'Splits the red and blue channels apart like a cheap lens, either growing toward the edges or along a fixed direction.',
  keywords: ['rgb split', 'glitch', 'lens', 'fringe', 'color shift', 'misregistration'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    amount: { type: 'number', default: 4, min: 0, max: 100, step: 0.1, unit: 'px', label: 'Amount', hint: 'Shift of red and blue (at the frame edge when radial).' },
    radial: { type: 'bool', default: true, label: 'Radial (from centre)' },
    angle: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Direction', visibleIf: (p) => p.radial === false },
  },
  summary: (p) => `${p.amount} px ${p.radial ? 'radial' : `at ${p.angle}°`}`,
  render(ctx) {
    const p = ctx.params;
    if (p.amount < 0.05) return { image: ctx.in.image };
    const a = (p.angle * Math.PI) / 180;
    const image = ctx.gpu.pass({
      label: 'chromatic-aberration',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { amount: p.amount, radial: p.radial, dir: [Math.cos(a), Math.sin(a)] },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var off = u.dir;
  if (u.radial > 0.5) { off = (uv - 0.5) * 2.0; }
  let o = off * u.amount / u.size;
  let g = textureSampleLevel(src, smp, uv, 0.0);
  let r = textureSampleLevel(src, smp, uv + o, 0.0);
  let b = textureSampleLevel(src, smp, uv - o, 0.0);
  return vec4f(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`,
    });
    return { image };
  },
});
