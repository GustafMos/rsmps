import { defineNode } from '../../define';

export default defineNode({
  id: 'outline',
  title: 'Sprite Outline',
  category: 'stylize',
  description: 'Draws an outline around the opaque shape of a sprite, based on its alpha: outside, inside or centerd on the edge.',
  keywords: ['stroke', 'border', 'edge', 'sticker', 'contour', 'silhouette', 'sprite'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    thickness: { type: 'number', default: 2, min: 0, max: 60, step: 0.5, unit: 'px', label: 'Thickness' },
    color: { type: 'color', default: [0, 0, 0, 1], label: 'Color' },
    position: {
      type: 'enum',
      default: 'outside',
      label: 'Position',
      options: [
        { value: 'outside', label: 'Outside' },
        { value: 'inside', label: 'Inside' },
        { value: 'center', label: 'Centerd on the edge' },
      ],
    },
    sharp: { type: 'bool', default: false, label: 'Hard edge', hint: 'No anti-aliasing.' },
  },
  summary: (p) => `${p.thickness} px ${p.position}`,
  render(ctx) {
    const p = ctx.params;
    if (p.thickness < 0.25 || p.color[3] <= 0) return { image: ctx.in.image };
    const half = p.position === 'center' ? p.thickness / 2 : p.thickness;
    const image = ctx.gpu.pass({
      label: 'outline',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: {
        radius: half,
        steps: Math.max(1, Math.min(8, Math.ceil(half))),
        color: p.color,
        outer: p.position !== 'inside',
        inner: p.position !== 'outside',
        sharp: p.sharp,
      },
      wgsl: /* wgsl */ `
// max (dilate) or min (erode) of alpha within the radius
fn reach(uv: vec2f, wantMax: bool) -> f32 {
  var m = textureSampleLevel(src, smp, uv, 0.0).a;
  let n = i32(u.steps);
  for (var k = 1; k <= n; k++) {
    let r = u.radius * f32(k) / f32(n);
    for (var j = 0; j < 24; j++) {
      let a = TAU * f32(j) / 24.0;
      let t = textureSampleLevel(src, smp, uv + vec2f(cos(a), sin(a)) * r / u.size, 0.0).a;
      m = select(min(m, t), max(m, t), wantMax);
    }
  }
  return m;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  var out = s;
  var cover = 0.0;
  if (u.outer > 0.5) {
    cover = clamp(reach(uv, true) - s.a, 0.0, 1.0);
    if (u.sharp > 0.5) { cover = step(0.5, cover); }
    let layer = vec4f(u.color.rgb * u.color.a, u.color.a) * cover;
    out = s + layer * (1.0 - s.a);
  }
  if (u.inner > 0.5 && s.a > 0.0) {
    var ic = clamp(s.a - reach(uv, false), 0.0, 1.0);
    if (u.sharp > 0.5) { ic = step(0.5, ic); }
    let st = unpremul(out);
    out = premul(vec4f(mix(st.rgb, u.color.rgb, ic * u.color.a), st.a));
  }
  return out;
}`,
    });
    return { image };
  },
});
