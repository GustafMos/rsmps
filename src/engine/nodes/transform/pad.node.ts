import { defineNode } from '../../define';
import { EDGE_WGSL, premulColor } from '../../lib/util-wgsl';

export default defineNode({
  id: 'pad',
  title: 'Pad Canvas',
  category: 'transform',
  description: 'Make the canvas bigger by adding margins or by reaching a target aspect ratio, and fill the new area.',
  keywords: ['extend', 'canvas', 'border', 'margin', 'letterbox', 'aspect', 'expand'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'margins',
      options: [
        { value: 'margins', label: 'Add margins' },
        { value: 'aspect', label: 'Reach aspect ratio' },
      ],
      label: 'Pad by',
    },
    left: { type: 'number', default: 16, min: 0, max: 8000, unit: 'px', label: 'Left', visibleIf: (p) => p.mode === 'margins' },
    right: { type: 'number', default: 16, min: 0, max: 8000, unit: 'px', label: 'Right', visibleIf: (p) => p.mode === 'margins' },
    top: { type: 'number', default: 16, min: 0, max: 8000, unit: 'px', label: 'Top', visibleIf: (p) => p.mode === 'margins' },
    bottom: { type: 'number', default: 16, min: 0, max: 8000, unit: 'px', label: 'Bottom', visibleIf: (p) => p.mode === 'margins' },
    ratioW: { type: 'number', default: 16, min: 1, max: 100, integer: true, label: 'Aspect width', visibleIf: (p) => p.mode === 'aspect' },
    ratioH: { type: 'number', default: 9, min: 1, max: 100, integer: true, label: 'Aspect height', visibleIf: (p) => p.mode === 'aspect' },
    align: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: 0, max: 1, step: 0.01, label: 'Image position', hint: 'Where the original sits inside the new area. 0.5, 0.5 centers it.', visibleIf: (p) => p.mode === 'aspect' },
    fill: {
      type: 'enum',
      default: 'transparent',
      options: [
        { value: 'transparent', label: 'Transparent' },
        { value: 'color', label: 'Color' },
        { value: 'clamp', label: 'Stretch edge pixels' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'wrap', label: 'Repeat' },
      ],
      label: 'Fill with',
    },
    color: { type: 'color', default: [0, 0, 0, 1], label: 'Color', visibleIf: (p) => p.fill === 'color' },
  },
  summary: (p) => (p.mode === 'aspect' ? `to ${p.ratioW}:${p.ratioH}` : `${p.left}/${p.top}/${p.right}/${p.bottom}`) + ` · ${p.fill}`,
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    let w = src.width;
    let h = src.height;
    let ox = 0;
    let oy = 0;
    if (p.mode === 'aspect') {
      const target = p.ratioW / p.ratioH;
      if (src.width / src.height < target) w = Math.ceil(src.height * target);
      else h = Math.ceil(src.width / target);
      ox = Math.round((w - src.width) * p.align[0]);
      oy = Math.round((h - src.height) * p.align[1]);
    } else {
      ox = Math.round(p.left);
      oy = Math.round(p.top);
      w = src.width + ox + Math.round(p.right);
      h = src.height + oy + Math.round(p.bottom);
    }
    if (w === src.width && h === src.height) return { image: src };
    const mode = p.fill === 'clamp' ? 1 : p.fill === 'wrap' ? 2 : p.fill === 'mirror' ? 3 : 0;
    const image = ctx.gpu.pass({
      label: 'pad',
      size: { width: w, height: h, unit: src.unit },
      textures: { src },
      uniforms: { off: [ox, oy], mode, col: p.fill === 'color' ? premulColor(p.color) : [0, 0, 0, 0] },
      wgsl: /* wgsl */ `
${EDGE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = edgeFetch(src, vec2i(floor(px)) - vec2i(u.off), i32(u.mode));
  return c + u.col * (1.0 - c.a);
}`,
    });
    return { image };
  },
});
