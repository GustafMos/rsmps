import { defineNode } from '../../define';

export default defineNode({
  id: 'crop',
  title: 'Crop',
  category: 'transform',
  description: 'Cut the image down to a rectangle. The output is smaller; pixels are not resampled.',
  keywords: ['cut', 'trim', 'rectangle', 'margin', 'region'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'rect',
      options: [
        { value: 'rect', label: 'Rectangle' },
        { value: 'margins', label: 'Trim edges' },
      ],
      label: 'Crop by',
    },
    position: { type: 'vec2', default: [0, 0], unit: 'norm', min: 0, max: 1, step: 0.005, label: 'Top-left', visibleIf: (p) => p.mode === 'rect' },
    size: { type: 'vec2', default: [1, 1], unit: 'norm', min: 0, max: 1, step: 0.005, label: 'Size', visibleIf: (p) => p.mode === 'rect' },
    left: { type: 'number', default: 0, min: 0, max: 8000, unit: 'px', label: 'Trim left', visibleIf: (p) => p.mode === 'margins' },
    right: { type: 'number', default: 0, min: 0, max: 8000, unit: 'px', label: 'Trim right', visibleIf: (p) => p.mode === 'margins' },
    top: { type: 'number', default: 0, min: 0, max: 8000, unit: 'px', label: 'Trim top', visibleIf: (p) => p.mode === 'margins' },
    bottom: { type: 'number', default: 0, min: 0, max: 8000, unit: 'px', label: 'Trim bottom', visibleIf: (p) => p.mode === 'margins' },
  },
  summary: (p) => (p.mode === 'rect' ? `${Math.round(p.size[0] * 100)}% × ${Math.round(p.size[1] * 100)}%` : `trim ${p.left}/${p.top}/${p.right}/${p.bottom}`),
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    let x0: number;
    let y0: number;
    let x1: number;
    let y1: number;
    if (p.mode === 'rect') {
      x0 = Math.round(p.position[0] * src.width);
      y0 = Math.round(p.position[1] * src.height);
      x1 = Math.round((p.position[0] + p.size[0]) * src.width);
      y1 = Math.round((p.position[1] + p.size[1]) * src.height);
    } else {
      x0 = Math.round(p.left);
      y0 = Math.round(p.top);
      x1 = src.width - Math.round(p.right);
      y1 = src.height - Math.round(p.bottom);
    }
    x0 = Math.min(Math.max(0, x0), src.width - 1);
    y0 = Math.min(Math.max(0, y0), src.height - 1);
    x1 = Math.min(Math.max(x0 + 1, x1), src.width);
    y1 = Math.min(Math.max(y0 + 1, y1), src.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w === src.width && h === src.height) return { image: src };
    const image = ctx.gpu.pass({
      label: 'crop',
      size: { width: w, height: h, unit: src.unit },
      textures: { src },
      uniforms: { off: [x0, y0] },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return textureLoad(src, vec2i(floor(px + u.off)), 0);
}`,
    });
    return { image };
  },
});
