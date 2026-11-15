import { defineNode } from '../../define';
import { SOBEL_WGSL } from '../../lib/fx-util';

export default defineNode({
  id: 'edge-detect',
  title: 'Edge Detect',
  category: 'filter',
  description: 'Finds outlines where brightness or transparency changes sharply (Sobel). Also outputs the edges as a mask.',
  keywords: ['sobel', 'outline', 'lines', 'contour', 'sketch', 'edges'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' }, mask: { type: 'mask', label: 'Edges' } },
  maskable: true,
  params: {
    look: {
      type: 'enum',
      default: 'on-black',
      label: 'Result',
      options: [
        { value: 'on-black', label: 'Lines on black' },
        { value: 'on-image', label: 'Lines over the image' },
        { value: 'lines-only', label: 'Lines only (transparent)' },
      ],
    },
    strength: { type: 'number', default: 2, min: 0, max: 10, step: 0.05, label: 'Strength' },
    threshold: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Threshold', hint: 'Edges weaker than this are ignored.' },
    thickness: { type: 'number', default: 1, min: 0.5, max: 12, step: 0.1, unit: 'px', label: 'Thickness' },
    color: { type: 'color', default: [1, 1, 1, 1], label: 'Line color' },
  },
  summary: (p) => `Sobel · ${p.thickness} px`,
  render(ctx) {
    const p = ctx.params;
    const wgsl = (body: string) => /* wgsl */ `${SOBEL_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let g = sobel2(src, uv, vec2f(u.thickness) / u.size);
  let e = smoothstep(u.threshold, u.threshold + 0.15, max(g.x, g.y) * u.strength);
  ${body}
}`;
    const opts = {
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { strength: p.strength, threshold: p.threshold, thickness: p.thickness, color: p.color, look: ['on-black', 'on-image', 'lines-only'].indexOf(p.look) },
    };
    const image = ctx.gpu.pass({
      ...opts,
      label: 'edge-detect',
      wgsl: wgsl(`
  let c = u.color.rgb;
  if (u.look < 0.5) { return vec4f(c * e, 1.0); }
  if (u.look < 1.5) { return premul(vec4f(mix(unpremul(s).rgb, c, e * u.color.a), s.a)); }
  return premul(vec4f(c, e * u.color.a));`),
    });
    const mask = ctx.gpu.passMask({ ...opts, label: 'edge-mask', wgsl: wgsl('return vec4f(e, e, e, 1.0);') });
    return { image, mask };
  },
});
