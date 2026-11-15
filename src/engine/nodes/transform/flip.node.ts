import { defineNode } from '../../define';

export default defineNode({
  id: 'flip',
  title: 'Flip & Rotate 90°',
  category: 'transform',
  description: 'Mirror the image horizontally or vertically, or turn it by 90, 180 or 270 degrees. Lossless.',
  keywords: ['mirror', 'flip', 'rotate', 'turn', 'orientation'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    rotate: {
      type: 'enum',
      default: '0',
      options: [
        { value: '0', label: 'No turn' },
        { value: '90', label: '90° clockwise' },
        { value: '180', label: '180°' },
        { value: '270', label: '90° counter-clockwise' },
      ],
      label: 'Turn',
    },
    horizontal: { type: 'bool', default: false, label: 'Flip horizontally' },
    vertical: { type: 'bool', default: false, label: 'Flip vertically' },
  },
  summary: (p) => {
    const bits: string[] = [];
    if (p.rotate !== '0') bits.push(`turn ${p.rotate}°`);
    if (p.horizontal) bits.push('flip H');
    if (p.vertical) bits.push('flip V');
    return bits.length ? bits.join(' · ') : 'no change';
  },
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    const rot = Number(p.rotate);
    if (rot === 0 && !p.horizontal && !p.vertical) return { image: src };
    const swap = rot === 90 || rot === 270;
    const image = ctx.gpu.pass({
      label: 'flip',
      size: { width: swap ? src.height : src.width, height: swap ? src.width : src.height, unit: src.unit },
      textures: { src },
      uniforms: { rot, fh: p.horizontal, fv: p.vertical },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var o = vec2i(floor(px));
  let osz = vec2i(u.size);
  if (u.fh > 0.5) { o.x = osz.x - 1 - o.x; }
  if (u.fv > 0.5) { o.y = osz.y - 1 - o.y; }
  let sz = vec2i(textureDimensions(src));
  var s = o;
  if (u.rot == 90.0) { s = vec2i(o.y, sz.y - 1 - o.x); }
  else if (u.rot == 180.0) { s = vec2i(sz.x - 1 - o.x, sz.y - 1 - o.y); }
  else if (u.rot == 270.0) { s = vec2i(sz.x - 1 - o.y, o.x); }
  return textureLoad(src, s, 0);
}`,
    });
    return { image };
  },
});
