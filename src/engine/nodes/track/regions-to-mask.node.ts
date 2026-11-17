import { defineNode } from '../../define';
import { validRegions } from '../../lib/track-core';
import { MAX_REGIONS, REGION_WGSL, regionTable } from '../../lib/track-gpu';

const SHAPES = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'rounded', label: 'Rounded rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
] as const;

export default defineNode({
  id: 'regions-to-mask',
  title: 'Regions To Mask',
  category: 'track',
  description:
    'Draws the regions as a mask (white inside). Plug the mask into the Mask socket of ANY effect node to apply that effect only to the tracked parts of the image.',
  keywords: ['mask', 'regions', 'apply', 'effect', 'only', 'tracked', 'rasterise', 'rasterize', 'shape', 'matte'],
  inputs: {
    image: { type: 'image', required: true, label: 'Size from' },
    regions: { type: 'regions', required: true, label: 'Regions' },
  },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    shape: { type: 'enum', default: 'rect', options: SHAPES, label: 'Shape' },
    corner: { type: 'number', default: 24, min: 0, max: 500, step: 1, unit: 'px', label: 'Corner radius', visibleIf: (p) => p.shape === 'rounded' },
    feather: { type: 'number', default: 0, min: 0, max: 300, step: 0.5, unit: 'px', label: 'Feather', hint: 'Softens the edge, centerd on the box edge.' },
    limit: { type: 'number', default: 0, min: 0, max: MAX_REGIONS, step: 1, integer: true, label: 'First N', hint: '0 = all.' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `${p.shape}${p.feather > 0 ? ` · feather ${p.feather}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const img = ctx.in.image;
    let items = validRegions(ctx.in.regions.items);
    if (p.limit > 0) items = items.slice(0, p.limit);
    items = items.slice(0, MAX_REGIONS);
    const regs = regionTable(ctx.gpu, items.map((r) => r.box));
    const mask = ctx.gpu.passMask({
      label: 'regions-to-mask',
      size: img,
      textures: { regs },
      uniforms: { n: items.length, shape: p.shape === 'rect' ? 0 : p.shape === 'rounded' ? 1 : 2, corner: p.corner, feather: Math.max(p.feather, 1), inv: p.invert },
      wgsl: /* wgsl */ `
${REGION_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var m = 0.0;
  let count = i32(u.n);
  for (var i = 0; i < count; i++) {
    let b = regBox(i) * vec4f(u.size, u.size);
    let c = (b.xy + b.zw) * 0.5;
    let hs = max((b.zw - b.xy) * 0.5, vec2f(0.0));
    let p = px - c;
    var d = 0.0;
    if (u.shape < 0.5) { d = sdBox(p, hs); }
    else if (u.shape < 1.5) { d = sdRoundBox(p, hs, u.corner); }
    else { d = sdEllipse(p, hs); }
    m = max(m, clamp(0.5 - d / u.feather, 0.0, 1.0));
  }
  if (u.inv > 0.5) { m = 1.0 - m; }
  return vec4f(m, m, m, 1.0);
}`,
    });
    return { mask };
  },
});
