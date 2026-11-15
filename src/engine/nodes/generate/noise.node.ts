import { defineNode } from '../../define';

/**
 * EXEMPLAR — animated generator. Shows: optional size reference input, canvas fallback,
 * and looping by construction: animation is driven ONLY by `ctx.time.phase` with whole cycles,
 * so the last frame flows into the first with no maths from the user.
 */
export default defineNode({
  id: 'noise',
  title: 'Noise',
  category: 'generate',
  description: 'Fractal noise texture. Animates and loops seamlessly over the project duration.',
  keywords: ['clouds', 'fbm', 'texture', 'random'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    scale: { type: 'number', default: 200, min: 1, max: 4000, unit: 'px', label: 'Scale' },
    octaves: { type: 'number', default: 4, min: 1, max: 8, integer: true, label: 'Detail' },
    evolution: { type: 'number', default: 1, min: 0, max: 16, step: 0.1, label: 'Evolution per loop', hint: '0 = still.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, integer: true, label: 'Seed' },
    colorA: { type: 'color', default: [0, 0, 0, 1], label: 'Color A' },
    colorB: { type: 'color', default: [1, 1, 1, 1], label: 'Color B' },
  },
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const animated = p.evolution > 0;
    const phase = animated ? ctx.time.phase : 0; // touch the clock only when needed → stays cached when still
    const image = ctx.gpu.pass({
      label: 'noise',
      size,
      uniforms: {
        scale: Math.max(1, p.scale),
        octaves: p.octaves,
        phase,
        evolution: p.evolution,
        seed: p.seed,
        a: p.colorA,
        b: p.colorB,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var p = px / u.scale + vec2f(u.seed * 17.31, u.seed * 5.77);
  var sum = 0.0; var amp = 0.5; var norm = 0.0;
  for (var i = 0; i < i32(u.octaves); i++) {
    sum += amp * loopNoise(p, u.phase, u.evolution * f32(i + 1));
    norm += amp; amp *= 0.5; p = p * 2.0 + 19.19;
  }
  let t = sum / norm;
  return premul(mix(u.a, u.b, t));
}`,
    });
    return { image };
  },
});
