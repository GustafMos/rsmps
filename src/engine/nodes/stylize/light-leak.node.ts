import { defineNode } from '../../define';

/**
 * Light leaks: light that gets to the film past the lens, through a bad seal of the camera back or when the roll is
 * loaded and unloaded. It fogs the film from an edge inwards, in the warm colours of light going through the film base,
 * and it changes from frame to frame because every frame was in a different place when the light came in.
 * Drawn as a few soft glows that sit on the edges, wander along them and swell and fade; added like light (screen).
 */
export interface LeakLook {
  label: string;
  amount: number;
  /** Size of a glow, share of the width. */
  size: number;
  /** How often the leaks swell per loop. */
  speed: number;
  /** Colour of the core and of the outer part. */
  core: number[];
  rim: number[];
  /** How many glows (1..4). */
  count: number;
  /** Share of the time a leak is visible (1 = always). */
  duty: number;
}

export const LEAK_LOOKS: Record<string, LeakLook> = {
  subtle: { label: 'Subtle warm', amount: 0.35, size: 0.3, speed: 2, core: [1, 0.75, 0.4], rim: [0.9, 0.25, 0.05], count: 2, duty: 0.5 },
  warm: { label: 'Warm leak', amount: 0.75, size: 0.4, speed: 3, core: [1, 0.85, 0.5], rim: [1, 0.3, 0.05], count: 3, duty: 0.7 },
  red: { label: 'Red burn', amount: 1, size: 0.45, speed: 3, core: [1, 0.5, 0.2], rim: [0.9, 0.05, 0.02], count: 3, duty: 0.75 },
  rollEnd: { label: 'End of the roll', amount: 1.6, size: 0.8, speed: 1, core: [1, 0.95, 0.8], rim: [1, 0.35, 0.05], count: 2, duty: 1 },
  cool: { label: 'Cool blue', amount: 0.7, size: 0.4, speed: 2, core: [0.7, 0.9, 1], rim: [0.1, 0.3, 0.9], count: 2, duty: 0.6 },
  prism: { label: 'Prism', amount: 0.9, size: 0.35, speed: 4, core: [1, 1, 0.6], rim: [0.9, 0.1, 0.8], count: 4, duty: 0.8 },
  flash: { label: 'Flash frames', amount: 2, size: 1.1, speed: 9, core: [1, 1, 0.95], rim: [1, 0.6, 0.2], count: 2, duty: 0.2 },
};

const custom = (p: Record<string, unknown>): boolean => p.look === 'custom';

export default defineNode({
  id: 'light-leak',
  title: 'Light Leak',
  category: 'stylize',
  description: 'Warm glows that creep in from the edges, like light reaching the film through a leaky camera back or at the end of a roll. They wander, swell and fade, and repeat with the loop.',
  keywords: ['film', 'leak', 'light leak', 'burn', 'film burn', 'flash', 'flare', 'glow', 'vintage', 'lomo', 'analog', 'end of roll', 'fog', 'film look', 'super 8', 'overlay'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    look: { type: 'enum', default: 'warm', options: [...Object.entries(LEAK_LOOKS).map(([value, v]) => ({ value, label: v.label })), { value: 'custom', label: 'Custom' }], label: 'Look', hint: 'Custom shows every control.' },
    strength: { type: 'number', default: 1, min: 0, max: 4, step: 0.01, label: 'Strength' },
    amount: { type: 'number', default: 0.75, min: 0, max: 4, step: 0.01, label: 'Brightness', visibleIf: custom },
    size: { type: 'number', default: 0.4, min: 0.05, max: 2, step: 0.01, label: 'Size', visibleIf: custom, hint: 'Share of the picture width.' },
    speed: { type: 'number', default: 3, min: 0, max: 24, step: 1, integer: true, label: 'Swells per loop', visibleIf: custom },
    count: { type: 'number', default: 3, min: 1, max: 4, step: 1, integer: true, label: 'Leaks', visibleIf: custom },
    duty: { type: 'number', default: 0.7, min: 0.05, max: 1, step: 0.01, label: 'Time visible', visibleIf: custom, hint: '1 = always there. Low values give short flashes.' },
    core: { type: 'color', default: [1, 0.85, 0.5, 1], label: 'Core color', visibleIf: custom },
    rim: { type: 'color', default: [1, 0.3, 0.05, 1], label: 'Outer color', visibleIf: custom },
    animated: { type: 'bool', default: true, label: 'Animated' },
    only: { type: 'bool', default: false, label: 'Leak only', hint: 'Shows the light without the picture.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', hint: 'Another number, other leaks.' },
  },
  summary: (p) => `${LEAK_LOOKS[p.look as string]?.label ?? 'custom'}${p.strength !== 1 ? ` × ${p.strength}` : ''}`,
  render(ctx) {
    const raw = ctx.params;
    const src = ctx.in.image;
    if (!src || (raw.strength <= 0 && !raw.only)) return { image: src };
    const c = raw.core as number[];
    const r = raw.rim as number[];
    const look: LeakLook = LEAK_LOOKS[raw.look as string] ?? { label: 'Custom', amount: raw.amount, size: raw.size, speed: raw.speed, core: [c[0], c[1], c[2]], rim: [r[0], r[1], r[2]], count: raw.count, duty: raw.duty };
    const image = ctx.gpu.pass({
      label: 'light-leak',
      size: src,
      textures: { src },
      uniforms: {
        amount: look.amount * raw.strength,
        lsize: look.size,
        phase: raw.animated ? ctx.time.phase : 0.37,
        speed: Math.max(1, Math.round(look.speed)),
        core: look.core,
        rim: look.rim,
        count: look.count,
        duty: look.duty,
        seed: raw.seed * 3.71,
        only: raw.only,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let aspect = u.size.x / u.size.y;
  var light = vec3f(0.0);
  for (var i = 0; i < 4; i++) {
    if (f32(i) >= u.count) { break; }
    let fi = f32(i) + u.seed;
    // which edge, and where along it; the place wanders once round per loop
    let side = floor(hash21(vec2f(fi, 1.0)) * 4.0);
    let along = fract(hash21(vec2f(fi, 2.0)) + 0.18 * sin(u.phase * TAU + fi * 2.1));
    var centre = vec2f(along, 0.0);
    if (side == 1.0) { centre = vec2f(1.0, along); }
    if (side == 2.0) { centre = vec2f(along, 1.0); }
    if (side == 3.0) { centre = vec2f(0.0, along); }
    // each leak is longer along its edge than it reaches into the picture
    var d = (uv - centre) * vec2f(1.0, 1.0 / aspect);
    let stretch = mix(vec2f(0.55, 1.0), vec2f(1.0, 0.55), step(0.5, f32(i32(side) % 2)));
    d = d * stretch / (u.lsize * (0.7 + 0.6 * hash21(vec2f(fi, 3.0))));
    // an uneven edge, like light through a gap
    let wob = 0.75 + 0.5 * vnoise(uv * 3.0 + vec2f(fi * 4.0, u.phase * 2.0 * f32(i + 1)));
    let fall = exp(-dot(d, d) * 2.2 / wob);
    // swell and fade, a whole number of times per loop so the loop joins
    let wave = 0.5 + 0.5 * sin(u.phase * TAU * u.speed + hash21(vec2f(fi, 4.0)) * TAU);
    let on = smoothstep(1.0 - u.duty, min(1.0, 1.0 - u.duty + 0.35), wave);
    let colour = mix(u.rim, u.core, fall * fall);
    light += colour * fall * on;
  }
  light *= u.amount;
  if (u.only > 0.5) { return vec4f(clamp(light, vec3f(0.0), vec3f(1.0)), 1.0); }
  let rgb = unpremul(s).rgb;
  // added like light on film: it cannot go past white, and it lifts the dark parts most
  let outc = 1.0 - (1.0 - rgb) * (1.0 - clamp(light, vec3f(0.0), vec3f(1.0)));
  let a = max(s.a, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));
  return premul(vec4f(outc, a));
}`,
    });
    return { image };
  },
});
