import { defineNode } from '../../define';

export default defineNode({
  id: 'directional-blur',
  title: 'Directional Blur',
  category: 'filter',
  description: 'Smears the image along a straight line, like motion blur.',
  keywords: ['motion', 'streak', 'smear', 'linear blur', 'speed'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    angle: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Angle', hint: '0 = horizontal.' },
    length: { type: 'number', default: 24, min: 0, max: 400, step: 0.5, unit: 'px', label: 'Length' },
  },
  summary: (p) => `${p.length} px at ${p.angle}°`,
  render(ctx) {
    const p = ctx.params;
    if (p.length < 0.5) return { image: ctx.in.image };
    const a = (p.angle * Math.PI) / 180;
    const image = ctx.gpu.pass({
      label: 'directional-blur',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { dir: [Math.cos(a), Math.sin(a)], length: p.length, taps: Math.min(96, Math.max(3, Math.ceil(p.length))) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let n = i32(u.taps);
  var acc = vec4f(0.0);
  for (var i = 0; i < n; i++) {
    let t = (f32(i) / f32(n - 1) - 0.5) * u.length;
    acc += textureSampleLevel(src, smp, uv + u.dir * t / u.size, 0.0);
  }
  return acc / f32(n);
}`,
    });
    return { image };
  },
});
