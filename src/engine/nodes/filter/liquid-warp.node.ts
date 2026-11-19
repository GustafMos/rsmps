import { defineNode } from '../../define';

/**
 * Liquid warp: the picture is pushed around by a slowly churning field of noise, and the pushed positions are pushed
 * again by another layer of the same ("domain warping"). One layer looks like looking through water; two or three fold
 * the picture into the swirls of marbled paper or oil on water. The noise travels round a circle in time, so the churn
 * comes back to where it started at the end of the loop.
 */
export default defineNode({
  id: 'liquid-warp',
  title: 'Liquid Warp',
  category: 'filter',
  description: 'Melts the picture into flowing swirls: from a gentle underwater wobble to marbled paper and oil on water. The flow loops.',
  keywords: ['liquid', 'marble', 'marbling', 'melt', 'swirl', 'flow', 'water', 'oil', 'warp', 'distort', 'trippy', 'psychedelic', 'lava lamp', 'fluid', 'domain warp', 'acid', 'visuals', 'vj'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    look: {
      type: 'enum',
      default: 'marble',
      options: [
        { value: 'water', label: 'Under water' },
        { value: 'melt', label: 'Melting' },
        { value: 'marble', label: 'Marble' },
        { value: 'acid', label: 'Acid trip' },
        { value: 'custom', label: 'Custom' },
      ],
      label: 'Look',
    },
    amount: { type: 'number', default: 0.25, min: 0, max: 1.5, step: 0.005, label: 'Amount', hint: 'How far the picture is pushed, as a share of its height.', visibleIf: (p) => p.look === 'custom' },
    scale: { type: 'number', default: 2, min: 0.3, max: 12, step: 0.05, label: 'Swirl count', hint: 'Low: a few large swirls. High: many small ones.', visibleIf: (p) => p.look === 'custom' },
    layers: { type: 'number', default: 2, min: 1, max: 4, step: 1, integer: true, label: 'Folds', hint: 'How many times the push is pushed again. 1 = wobble, 3 = marble.', visibleIf: (p) => p.look === 'custom' },
    strength: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Strength', hint: 'Multiplies the look.' },
    flow: { type: 'number', default: 1, min: 0, max: 6, step: 0.05, label: 'Flow', hint: 'How far the liquid churns during one loop. 0 = frozen.' },
    hue: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Color swirl', hint: 'Shifts the colours along the flow, like oil on water.' },
    seed: { type: 'number', default: 1, min: 0, max: 999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${p.look}${p.strength !== 1 ? ` × ${p.strength}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src || p.strength <= 0) return { image: src };
    const LOOKS: Record<string, { amount: number; scale: number; layers: number }> = {
      water: { amount: 0.04, scale: 4, layers: 1 },
      melt: { amount: 0.18, scale: 1.6, layers: 2 },
      marble: { amount: 0.3, scale: 2.2, layers: 3 },
      acid: { amount: 0.38, scale: 1.8, layers: 4 },
    };
    const look = LOOKS[p.look as string] ?? { amount: p.amount, scale: p.scale, layers: p.layers };
    const image = ctx.gpu.pass({
      label: 'liquid-warp',
      size: src,
      textures: { src },
      uniforms: { amount: look.amount * p.strength, scale: look.scale, layers: look.layers, phase: ctx.time.phase, flow: p.flow, hue: p.hue, seed: p.seed * 17.3 },
      wgsl: /* wgsl */ `
fn push(p: vec2f, k: f32) -> vec2f {
  let o = vec2f(u.seed + k * 31.7, u.seed * 0.7 - k * 12.9);
  return vec2f(loopNoise(p + o, u.phase, u.flow), loopNoise(p + o + vec2f(19.1, 47.3), u.phase, u.flow)) * 2.0 - 1.0;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let p0 = (uv - 0.5) * vec2f(aspect, 1.0);
  var p = p0;
  let n = i32(u.layers);
  var amt = u.amount;
  for (var i = 0; i < n; i++) {
    // each fold reads the noise at the place the fold before pushed to
    p = p0 + amt * push(p * u.scale * (1.0 + 0.5 * f32(i)), f32(i));
  }
  var st = p / vec2f(aspect, 1.0) + 0.5;
  st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0);
  var c = textureSampleLevel(src, smp, st, 0.0);
  if (u.hue > 0.0) {
    // colours shifted by how far this point travelled
    let s = unpremul(c);
    var hsv = rgbToHsv(s.rgb);
    hsv.x = fract(hsv.x + u.hue * length(p - p0) * 1.5);
    c = premul(vec4f(hsvToRgb(hsv), s.a));
  }
  return c;
}`,
    });
    return { image };
  },
});
