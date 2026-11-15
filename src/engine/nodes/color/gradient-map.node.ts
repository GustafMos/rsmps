import { defineNode } from '../../define';
import { paletteTexture } from '../../lib/fx-util';

export default defineNode({
  id: 'gradient-map',
  title: 'Gradient Map',
  category: 'color',
  description: 'Recolours the image by mapping its brightness through a palette: darkest pixels take the first colour, brightest the last.',
  keywords: ['duotone', 'tritone', 'palette', 'recolor', 'false colour', 'heatmap'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    palette: {
      type: 'palette',
      default: [
        [0.05, 0.02, 0.18],
        [0.62, 0.12, 0.38],
        [0.98, 0.62, 0.22],
        [1, 0.96, 0.82],
      ],
      label: 'Gradient',
      hint: 'Dark to light.',
    },
    stepped: { type: 'bool', default: false, label: 'Hard steps' },
    reverse: { type: 'bool', default: false, label: 'Reverse' },
  },
  summary: (p) => `${p.palette.length} colours${p.stepped ? ' · steps' : ''}`,
  render(ctx) {
    const p = ctx.params;
    if (p.palette.length === 0) return { image: ctx.in.image };
    const image = ctx.gpu.pass({
      label: 'gradient-map',
      size: ctx.in.image,
      textures: { src: ctx.in.image, pal: paletteTexture(ctx.gpu, p.palette) },
      uniforms: { n: p.palette.length, stepped: p.stepped, reverse: p.reverse },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var l = saturate1(luma(s.rgb));
  if (u.reverse > 0.5) { l = 1.0 - l; }
  let n = i32(u.n + 0.5);
  var c: vec3f;
  if (u.stepped > 0.5) {
    c = textureLoad(pal, vec2i(min(i32(floor(l * u.n)), n - 1), 0), 0).rgb;
  } else {
    let t = l * f32(n - 1);
    let i0 = min(i32(floor(t)), max(n - 2, 0));
    let i1 = min(i0 + 1, n - 1);
    c = mix(textureLoad(pal, vec2i(i0, 0), 0).rgb, textureLoad(pal, vec2i(i1, 0), 0).rgb, t - f32(i0));
  }
  return premul(vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
