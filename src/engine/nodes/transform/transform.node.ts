import { defineNode } from '../../define';
import { EDGE_MODES, EDGE_WGSL, edgeModeIndex } from '../../lib/util-wgsl';

export default defineNode({
  id: 'transform',
  title: 'Transform',
  category: 'transform',
  description: 'Move, rotate and scale an image around a pivot point. The image keeps its size.',
  keywords: ['move', 'translate', 'rotate', 'scale', 'zoom', 'pivot', 'position', 'tile', 'wrap', 'repeat', 'mirror repeat', 'clamp', 'offset', 'wrap around'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    translate: { type: 'vec2', default: [0, 0], unit: 'norm', min: -2, max: 2, step: 0.005, label: 'Move', hint: 'Fraction of the image size. Positive moves right and down.' },
    rotate: { type: 'number', default: 0, min: -3600, max: 3600, step: 0.5, unit: 'deg', label: 'Rotate', hint: 'Degrees, clockwise.' },
    scale: { type: 'number', default: 1, min: 0.01, max: 50, step: 0.01, label: 'Scale' },
    stretch: { type: 'vec2', default: [1, 1], min: 0.01, max: 50, step: 0.01, label: 'Stretch', hint: 'Extra width / height multiplier on top of Scale.' },
    pivot: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -1, max: 2, step: 0.005, label: 'Pivot', hint: 'Center of rotation and scaling. 0.5, 0.5 is the middle.' },
    edge: { type: 'enum', default: 'transparent', options: EDGE_MODES, label: 'Outside the image' },
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
    if (p.translate[0] || p.translate[1]) bits.push(`move ${p.translate[0].toFixed(2)}, ${p.translate[1].toFixed(2)}`);
    if (p.rotate) bits.push(`${p.rotate}°`);
    if (p.scale !== 1 || p.stretch[0] !== 1 || p.stretch[1] !== 1) bits.push(`×${p.scale}`);
    return bits.length ? bits.join(' · ') : 'no change';
  },
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    const identity = p.translate[0] === 0 && p.translate[1] === 0 && p.rotate === 0 && p.scale === 1 && p.stretch[0] === 1 && p.stretch[1] === 1;
    if (identity) return { image: src };
    const rad = (p.rotate * Math.PI) / 180;
    const image = ctx.gpu.pass({
      label: 'transform',
      size: src,
      textures: { src },
      uniforms: {
        piv: [p.pivot[0] * src.width, p.pivot[1] * src.height],
        tr: [p.translate[0] * src.width, p.translate[1] * src.height],
        sc: [Math.max(1e-4, p.scale * p.stretch[0]), Math.max(1e-4, p.scale * p.stretch[1])],
        cs: [Math.cos(rad), Math.sin(rad)],
        mode: edgeModeIndex(p.edge),
        lin: p.filter === 'linear',
      },
      wgsl: /* wgsl */ `
${EDGE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = (px - u.piv - u.tr) / u.sc;
  let r = vec2f(d.x * u.cs.x + d.y * u.cs.y, -d.x * u.cs.y + d.y * u.cs.x);
  return edgeSample(src, u.piv + r, i32(u.mode), u.lin > 0.5);
}`,
    });
    return { image };
  },
});
