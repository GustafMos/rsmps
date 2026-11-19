import { defineNode } from '../../define';

/** Reach of the three streak passes in steps: 3 taps a side, spaced 1, 4 and 16 steps. */
const REACH = 3 * (1 + 4 + 16);

const BRIGHT_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let w = smoothstep(u.threshold - u.knee, u.threshold + u.knee, luma(unpremul(s).rgb));
  return s * w * u.keep;
}`;

// One pass of a streak: 7 taps along the line, weighted so that three passes (spacing 1, 4, 16) add up to a long ray
// that fades smoothly from the light outwards.
const STREAK_FN = /* wgsl */ `
fn streak(uv: vec2f) -> vec4f {
  var acc = textureSampleLevel(src, smp, uv, 0.0);
  var sum = 1.0;
  for (var i = 1; i <= 3; i++) {
    let w = pow(u.fade, f32(i) * u.spacing);
    let o = u.dir * (f32(i) * u.spacing * u.step) / u.size;
    acc += (textureSampleLevel(src, smp, uv + o, 0.0) + textureSampleLevel(src, smp, uv - o, 0.0)) * w;
    sum += 2.0 * w;
  }
  return acc / sum;
}`;
const STREAK_WGSL = `${STREAK_FN}
fn fx(uv: vec2f, px: vec2f) -> vec4f { return streak(uv); }`;
const STREAK_ADD_WGSL = `${STREAK_FN}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let b = textureSampleLevel(base, smpNearest, uv, 0.0);
  let g = streak(uv) * u.gain;
  let a = max(b.a, min(g.a, 1.0));
  return vec4f(min(b.rgb + g.rgb * u.tint.rgb, vec3f(a)), a);
}`;

export default defineNode({
  id: 'glints',
  title: 'Glints',
  category: 'filter',
  description: 'Star-shaped rays of light from the brightest points, like a star filter on a lens: sparkles on water, lamps, chrome and jewellery.',
  keywords: ['star', 'star filter', 'sparkle', 'sparky', 'glare', 'streak', 'rays', 'highlights', 'cross filter', 'twinkle', 'shine', 'flare', 'starburst', 'anamorphic'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    threshold: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Threshold', hint: 'Only points brighter than this get rays.' },
    softness: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Softness' },
    points: { type: 'number', default: 4, min: 2, max: 16, step: 2, integer: true, label: 'Star points', hint: '2 is one streak (the anamorphic look), 4 a cross, 6 and 8 a star.' },
    length: { type: 'number', default: 80, min: 2, max: 600, step: 1, unit: 'px', label: 'Length' },
    angle: { type: 'number', default: 30, min: -180, max: 180, step: 1, unit: 'deg', label: 'Angle' },
    intensity: { type: 'number', default: 1, min: 0, max: 8, step: 0.01, label: 'Intensity' },
    tint: { type: 'color', default: [1, 1, 1, 1], label: 'Ray color' },
    only: { type: 'bool', default: false, label: 'Rays only', hint: 'Shows the rays without the picture, to blend them yourself.' },
  },
  summary: (p) => `${p.points} points · ${p.length} px`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src || (p.intensity <= 0 && !p.only)) return { image: src };
    const knee = Math.max(0.001, p.softness * 0.5);
    const bright = ctx.gpu.pass({ label: 'glints-bright', size: src, textures: { src }, uniforms: { threshold: p.threshold, knee, keep: 1 }, wgsl: BRIGHT_WGSL });
    const lines = Math.max(1, Math.round(p.points / 2));
    const step = Math.max(0.05, p.length / REACH);
    // per step, so the ray has faded to 4 % at its full length
    const fade = Math.pow(0.04, 1 / REACH);
    // a ray spreads the light of a point over its length; this brings a small highlight back to a visible level
    const gain = p.intensity * 1.5 * Math.sqrt(Math.max(1, p.length));
    let image = p.only ? ctx.gpu.pass({ label: 'glints-empty', size: src, textures: { src }, uniforms: { threshold: 2, knee, keep: 0 }, wgsl: BRIGHT_WGSL }) : src;
    for (let i = 0; i < lines; i++) {
      const a = (p.angle * Math.PI) / 180 + (i * Math.PI) / lines;
      const dir = [Math.cos(a), Math.sin(a)];
      let s = bright;
      for (const spacing of [1, 4]) s = ctx.gpu.pass({ label: 'glints-streak', size: src, textures: { src: s }, uniforms: { dir, step, fade, spacing }, wgsl: STREAK_WGSL });
      image = ctx.gpu.pass({ label: 'glints-add', size: src, textures: { src: s, base: image }, uniforms: { dir, step, fade, spacing: 16, gain, tint: p.tint }, wgsl: STREAK_ADD_WGSL });
    }
    return { image };
  },
});
