import { defineNode } from '../../define';
import { EDGE_WGSL } from '../../lib/util-wgsl';

export default defineNode({
  id: 'scroll',
  title: 'Scroll',
  category: 'transform',
  description: 'Slide the image sideways or up and down and wrap it around: the classic seamless scrolling background. Loops by construction.',
  keywords: ['pan', 'parallax', 'tile', 'wrap', 'conveyor', 'scrolling', 'background'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    cyclesX: { type: 'number', default: 1, min: -32, max: 32, step: 1, integer: true, unit: 'cycles', label: 'Scroll X', hint: 'Whole image widths traveled each loop. Positive moves right, negative left, 0 = still.' },
    cyclesY: { type: 'number', default: 0, min: -32, max: 32, step: 1, integer: true, unit: 'cycles', label: 'Scroll Y', hint: 'Whole image heights traveled each loop. Positive moves down, negative up.' },
    offset: { type: 'vec2', default: [0, 0], unit: 'norm', min: -1, max: 1, step: 0.005, label: 'Static offset', hint: 'Starting position as a fraction of the image size.' },
    filter: {
      type: 'enum',
      default: 'linear',
      options: [
        { value: 'linear', label: 'Smooth' },
        { value: 'nearest', label: 'Sharp' },
      ],
      label: 'Filter',
    },
  },
  summary: (p) => {
    const bits: string[] = [];
    if (p.cyclesX) bits.push(`${p.cyclesX > 0 ? '→' : '←'} ${Math.abs(p.cyclesX)}× per loop`);
    if (p.cyclesY) bits.push(`${p.cyclesY > 0 ? '↓' : '↑'} ${Math.abs(p.cyclesY)}× per loop`);
    return bits.length ? bits.join(' · ') : 'still';
  },
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    const moving = p.cyclesX !== 0 || p.cyclesY !== 0;
    if (!moving && p.offset[0] === 0 && p.offset[1] === 0) return { image: src };
    const phase = moving ? ctx.time.phase : 0; // only touch the clock when actually moving
    const shift = [p.offset[0] + p.cyclesX * phase, p.offset[1] + p.cyclesY * phase];
    const image = ctx.gpu.pass({
      label: 'scroll',
      size: src,
      textures: { src },
      uniforms: { shift: [shift[0] * src.width, shift[1] * src.height], lin: p.filter === 'linear' },
      wgsl: /* wgsl */ `
${EDGE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return edgeSample(src, px - u.shift, 2, u.lin > 0.5);
}`,
    });
    return { image };
  },
});
