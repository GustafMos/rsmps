import { defineNode } from '../../define';

export default defineNode({
  id: 'displace',
  title: 'Noise Displace',
  category: 'filter',
  description: 'Warps the image with a flowing noise field: heat haze, water ripple, wobbly hand-drawn edges. Loops seamlessly when animated. To warp with a picture instead of noise (a displacement map, refraction through a bump map, footage motion), use Displace by Map.',
  keywords: ['warp', 'distort', 'wobble', 'heat', 'wave', 'ripple', 'turbulence', 'boil'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    amount: { type: 'number', default: 12, min: 0, max: 200, step: 0.5, unit: 'px', label: 'Amount', hint: 'Maximum shift in pixels.' },
    scale: { type: 'number', default: 80, min: 2, max: 1000, step: 1, unit: 'px', label: 'Feature size' },
    detail: { type: 'number', default: 2, min: 1, max: 4, step: 1, integer: true, label: 'Detail' },
    evolution: { type: 'number', default: 1, min: 0, max: 16, step: 0.1, label: 'Evolution per loop', hint: '0 = still warp. Higher = the pattern changes more over one loop.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${p.amount} px${p.evolution > 0 ? ' · animated' : ''}`,
  render(ctx) {
    const p = ctx.params;
    if (p.amount < 0.05) return { image: ctx.in.image };
    const phase = p.evolution > 0 ? ctx.time.phase : 0;
    const image = ctx.gpu.pass({
      label: 'displace',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { amount: p.amount, scale: Math.max(1, p.scale), detail: p.detail, evo: p.evolution, phase, seed: p.seed },
      wgsl: /* wgsl */ `
fn field(p0: vec2f) -> f32 {
  var p = p0; var sum = 0.0; var amp = 0.5; var norm = 0.0;
  for (var i = 0; i < i32(u.detail + 0.5); i++) {
    sum += amp * loopNoise(p, u.phase, u.evo * f32(i + 1));
    norm += amp; amp *= 0.5; p = p * 2.0 + 11.3;
  }
  return sum / norm;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = px / u.scale + vec2f(u.seed * 17.31, u.seed * 5.77);
  let d = vec2f(field(p), field(p + vec2f(53.1, 27.7))) * 2.0 - 1.0;
  return textureSampleLevel(src, smp, uv + d * 1.6 * u.amount / u.size, 0.0);
}`,
    });
    return { image };
  },
});
