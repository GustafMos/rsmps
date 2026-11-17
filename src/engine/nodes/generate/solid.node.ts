import { defineNode } from '../../define';
import { rgba } from '../../lib/gen-common';

export default defineNode({
  id: 'solid',
  title: 'Solid Color',
  category: 'generate',
  description: 'A flat color filling the whole frame (or the size of a connected image).',
  keywords: ['color', 'colour', 'fill', 'flat', 'background'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    color: { type: 'color', default: [0.18, 0.2, 0.28, 1], label: 'Color' },
  },
  summary: (p) => `RGBA ${p.color.map((v) => Math.round(v * 255)).join(', ')}`,
  render(ctx) {
    const image = ctx.gpu.pass({
      label: 'solid',
      size: ctx.in.size ?? ctx.canvas,
      uniforms: { c: rgba(ctx.params.color) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f { return premul(u.c); }`,
    });
    return { image };
  },
});
