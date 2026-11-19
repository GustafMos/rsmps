import { defineNode } from '../../define';
import type { ImageValue, NodeGpu } from '../../types';

/**
 * Halation: light that goes through the emulsion, scatters in the film base, bounces off the back of the film and exposes
 * the emulsion a second time, a small distance away from where it came in. The bottom layer of colour film is the
 * red-sensitive one, so the halo is red-orange: strong in red, weak in green, almost none in blue.
 *
 * The model works on light, not on display values:
 *   1. the picture is turned back into linear light, and clipped whites are given back some of the brightness the camera
 *      threw away (`highlights`, in stops), because on film a lamp is many stops brighter than a white wall;
 *   2. that light is spread with a kernel of two gaussians, a tight one (the first bounce) and a wide faint one;
 *   3. the spread light is added to the layers by `tint`, and the result goes back to display values.
 * There is no threshold: everything makes a halo, but only light far above its surroundings is bright enough for it to show
 * (and what a point would give itself is left out, see the add pass).
 * The spread is a share of the picture width, because the halo has a fixed size on the film (about 0.15 mm): the smaller
 * the film frame, the larger the halo looks.
 */
export interface HalationLook {
  label: string;
  /** How much of the light comes back (1 = film without an anti-halation layer). */
  amount: number;
  /** Radius of the tight halo, percent of the picture width. */
  spread: number;
  /** Stops of brightness given back to clipped whites. */
  highlights: number;
  /** How the returning light exposes the red, green and blue layers. */
  tint: [number, number, number];
  /** Share of the light in the wide, faint halo. */
  wide: number;
}

export const HALATION_LOOKS: Record<string, HalationLook> = {
  film35: { label: '35mm film', amount: 0.3, spread: 0.6, highlights: 3, tint: [1, 0.22, 0.04], wide: 0.3 },
  film16: { label: '16mm film', amount: 0.35, spread: 1.2, highlights: 3, tint: [1, 0.22, 0.04], wide: 0.3 },
  super8: { label: 'Super 8', amount: 0.4, spread: 2.2, highlights: 3, tint: [1, 0.24, 0.05], wide: 0.3 },
  large: { label: '65mm film', amount: 0.25, spread: 0.3, highlights: 3, tint: [1, 0.22, 0.04], wide: 0.3 },
  nobacking: { label: 'No backing layer', amount: 1, spread: 0.9, highlights: 4, tint: [1, 0.16, 0.02], wide: 0.45 },
  bw: { label: 'Black and white film', amount: 0.35, spread: 0.7, highlights: 3, tint: [1, 1, 1], wide: 0.35 },
  neon: { label: 'Neon city', amount: 1.6, spread: 2.5, highlights: 5, tint: [1, 0.1, 0.75], wide: 0.6 },
  blood: { label: 'Blood moon', amount: 2.5, spread: 4, highlights: 5, tint: [1, 0.02, 0], wide: 0.7 },
  toxic: { label: 'Toxic', amount: 2, spread: 3, highlights: 5, tint: [0.25, 1, 0.05], wide: 0.6 },
  ice: { label: 'Ice', amount: 1.8, spread: 3.5, highlights: 5, tint: [0.1, 0.55, 1], wide: 0.7 },
  dream: { label: 'Fever dream', amount: 3, spread: 7, highlights: 6, tint: [1, 0.45, 0.6], wide: 0.8 },
  meltdown: { label: 'Meltdown', amount: 6, spread: 10, highlights: 6, tint: [1, 0.35, 0], wide: 0.9 },
};

const SOURCE_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smp, uv, 0.0);
  let lin = srgbToLinear(unpremul(s).rgb) * s.a;
  // clipped whites get their brightness back: the nearer to white, the more
  let top = max(lin.r, max(lin.g, lin.b));
  let light = lin * (1.0 + u.boost * pow(top, 6.0));
  // what reaches the back of the film: mostly red and green light (the blue layer and the yellow filter are on top)
  return vec4f(vec3f(dot(light, vec3f(0.6, 0.35, 0.05))), 1.0);
}`;

const BLUR_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = u.dir / vec2f(textureDimensions(src));
  var acc = textureSampleLevel(src, smp, uv, 0.0);
  var total = 1.0;
  let n = i32(ceil(u.sigma * 3.0));
  for (var i = 1; i <= n; i += 2) {
    let w1 = exp(-0.5 * f32(i * i) / (u.sigma * u.sigma));
    let w2 = exp(-0.5 * f32((i + 1) * (i + 1)) / (u.sigma * u.sigma));
    let wsum = w1 + w2;
    let off = (f32(i) * w1 + f32(i + 1) * w2) / wsum;
    acc += (textureSampleLevel(src, smp, uv + texel * off, 0.0) + textureSampleLevel(src, smp, uv - texel * off, 0.0)) * wsum;
    total += 2.0 * wsum;
  }
  return acc / total;
}`;

const ADD_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let lin0 = srgbToLinear(unpremul(s).rgb) * s.a;
  let top = max(lin0.r, max(lin0.g, lin0.b));
  let own = dot(lin0 * (1.0 + u.boost * pow(top, 6.0)), vec3f(0.6, 0.35, 0.05));
  // Film is colour-balanced with its own halation in it, so an even surface shows none: only light that arrives from
  // brighter neighbours counts.
  let spreadLight = mix(textureSampleLevel(tight, smp, uv, 0.0).r, textureSampleLevel(wide, smp, uv, 0.0).r, u.wide);
  let halo = max(spreadLight - own, 0.0) * u.amount;
  let add = halo * u.tint;
  if (u.only > 0.5) {
    let rgb = linearToSrgb(clamp(add, vec3f(0.0), vec3f(1.0)));
    return vec4f(rgb, 1.0);
  }
  let lin = srgbToLinear(unpremul(s).rgb);
  // the second exposure adds to the first; a soft shoulder instead of a hard clip keeps the halo's colour next to white
  let sum = lin + add;
  let outLin = sum / (1.0 + max(sum - 1.0, vec3f(0.0)) * 0.6);
  let a = max(s.a, min(max(add.r, max(add.g, add.b)), 1.0));
  return premul(vec4f(linearToSrgb(clamp(outLin, vec3f(0.0), vec3f(1.0))), a));
}`;

/** Gaussian blur in float precision at a reduced size (the halo is soft, so a small copy is enough). */
function floatBlur(gpu: NodeGpu, src: ImageValue, radiusTexels: number): ImageValue {
  const sigma = Math.max(0.3, radiusTexels / 2);
  const h = gpu.pass({ label: 'halation-blur-h', size: src, format: 'rgba16float', textures: { src }, uniforms: { dir: [1, 0], sigma }, wgsl: BLUR_WGSL });
  return gpu.pass({ label: 'halation-blur-v', size: src, format: 'rgba16float', textures: { src: h }, uniforms: { dir: [0, 1], sigma }, wgsl: BLUR_WGSL });
}

const custom = (p: Record<string, unknown>): boolean => p.look === 'custom';

export default defineNode({
  id: 'halation',
  title: 'Halation',
  category: 'filter',
  description: 'The red-orange glow film makes around bright lights: light that passes through the film, bounces off its back and exposes it again. The default is modelled on 35mm film; the other looks go from small-gauge film to anything but realistic.',
  keywords: ['film', 'halo', 'glow', 'red glow', 'highlights', 'cinestill', 'analog', '35mm', '16mm', 'super 8', 'bloom', 'film look', 'anti-halation', 'kodak', 'emulsion'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    look: {
      type: 'enum',
      default: 'film35',
      options: [...Object.entries(HALATION_LOOKS).map(([value, v]) => ({ value, label: v.label })), { value: 'custom', label: 'Custom' }],
      label: 'Look',
      hint: 'The film looks are modelled on real film: the halo has a fixed size on the film, so it looks larger on a smaller gauge. The ones after them are not realistic at all. Custom shows every control.',
    },
    strength: { type: 'number', default: 1, min: 0, max: 4, step: 0.01, label: 'Strength', hint: 'Multiplies the look. 1 = as the look is made.' },
    amount: { type: 'number', default: 0.3, min: 0, max: 8, step: 0.01, label: 'Light returned', visibleIf: custom, hint: 'How much of the light comes back from the back of the film. Film with an anti-halation layer: about 0.3. Without one: 1.' },
    spread: { type: 'number', default: 0.6, min: 0.05, max: 15, step: 0.05, label: 'Spread %', visibleIf: custom, hint: 'Radius of the halo as a percent of the picture width. 35mm: about 0.6. 16mm: 1.2. Super 8: 2.2.' },
    highlights: { type: 'number', default: 3, min: 0, max: 8, step: 0.1, label: 'Highlight stops', visibleIf: custom, hint: 'How many stops brighter than white the clipped lights are taken to be. Higher: only real lights glow, and they glow more.' },
    wide: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Wide share', visibleIf: custom, hint: 'Share of the light in the wide, faint second halo.' },
    tint: { type: 'color', default: [1, 0.22, 0.04, 1], label: 'Halo color', visibleIf: custom, hint: 'How the returning light exposes red, green and blue. Colour film: strong red, weak green, almost no blue.' },
    only: { type: 'bool', default: false, label: 'Halo only', hint: 'Shows the halo without the picture.' },
  },
  summary: (p) => `${HALATION_LOOKS[p.look as string]?.label ?? 'custom'}${p.strength !== 1 ? ` × ${p.strength}` : ''}`,
  render(ctx) {
    const src = ctx.in.image;
    const raw = ctx.params;
    if (!src) return { image: src };
    const preset = HALATION_LOOKS[raw.look as string];
    const t = raw.tint as number[];
    const look: HalationLook = preset ?? { label: 'Custom', amount: raw.amount, spread: raw.spread, highlights: raw.highlights, tint: [t[0], t[1], t[2]], wide: raw.wide };
    const amount = look.amount * raw.strength;
    if (amount <= 0 && !raw.only) return { image: src };
    // work on a copy about 480 texels wide: the halo is soft, and its radius is a share of the width anyway
    const down = Math.max(1, Math.round(src.width / 480));
    const size = { width: Math.max(1, Math.round(src.width / down)), height: Math.max(1, Math.round(src.height / down)), unit: src.unit / down };
    const boost = Math.pow(2, look.highlights) - 1;
    const light = ctx.gpu.pass({ label: 'halation-light', size, format: 'rgba16float', textures: { src }, uniforms: { boost }, wgsl: SOURCE_WGSL });
    const radius = (look.spread / 100) * size.width;
    const tight = floatBlur(ctx.gpu, light, radius);
    // the wide halo is blurred from a still smaller copy so its cost does not grow with the radius
    const wideRadius = radius * 3.5;
    const wd = Math.max(1, Math.floor(wideRadius / 12));
    const wsize = { width: Math.max(1, Math.round(size.width / wd)), height: Math.max(1, Math.round(size.height / wd)), unit: size.unit / wd };
    const small = wd === 1 ? light : ctx.gpu.pass({ label: 'halation-small', size: wsize, format: 'rgba16float', textures: { src: tight }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }' });
    const wide = floatBlur(ctx.gpu, small, wideRadius / wd);
    const image = ctx.gpu.pass({
      label: 'halation-add',
      size: src,
      textures: { src, tight, wide },
      // the returned light is spread over the halo, so its level per point is far below the light that made it
      uniforms: { amount: (amount / (1 + boost)) * 4, boost, tint: look.tint, wide: look.wide, only: raw.only },
      wgsl: ADD_WGSL,
    });
    return { image };
  },
});
