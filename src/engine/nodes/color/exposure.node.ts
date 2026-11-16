import { defineNode } from '../../define';
import { HABLE } from '../../lib/color-math';
import { COLOR_WGSL, fl } from '../../lib/color-wgsl';

export default defineNode({
  id: 'exposure',
  title: 'Exposure',
  category: 'color',
  description: 'Exposure in stops in linear light, with black point, a soft highlight shoulder, and an optional filmic tone map (extended Reinhard or Hable / Uncharted 2).',
  keywords: ['grade', 'exposure', 'stops', 'ev', 'brightness', 'tone map', 'tonemap', 'filmic', 'reinhard', 'hable', 'shoulder', 'highlight', 'roll-off', 'black point', 'linear'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    stops: { type: 'number', default: 0, min: -8, max: 8, softMax: 4, step: 0.01, label: 'Exposure', hint: 'Multiplies LINEAR light by 2^stops (one stop = double / half the light).' },
    blackPoint: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.001, label: 'Black point', hint: 'Linear value that becomes black: v = (lin - black) / (1 - black), applied before the exposure.' },
    rolloff: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Highlight roll-off', hint: 'Soft shoulder: values above the knee (1 - roll-off, linear) approach white smoothly instead of clipping. 0 = hard clip.', visibleIf: (p) => p.tonemap === 'none' },
    tonemap: {
      type: 'enum',
      default: 'none',
      label: 'Tone map',
      options: [
        { value: 'none', label: 'Shoulder only' },
        { value: 'reinhard', label: 'Extended Reinhard' },
        { value: 'hable', label: 'Filmic Hable' },
      ],
      hint: 'Per-channel curves applied to the exposed LINEAR values. Extended Reinhard: x(1 + x/W^2)/(1 + x). Hable: the Uncharted 2 curve normalised so the white point maps to 1. These are simple documented curves, NOT ACES or AgX. They darken the mid-tones: add exposure to compensate.',
    },
    whitePoint: { type: 'number', default: 4, min: 1, max: 16, step: 0.1, label: 'White point', hint: 'The linear value that maps to white.', visibleIf: (p) => p.tonemap !== 'none' },
  },
  summary: (p) => `${p.stops >= 0 ? '+' : ''}${p.stops.toFixed(2)} EV${p.tonemap !== 'none' ? ` · ${p.tonemap}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const image = ctx.gpu.pass({
      label: 'exposure',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { gain: Math.pow(2, p.stops), black: p.blackPoint, knee: 1 - p.rolloff, tm: p.tonemap === 'none' ? 0 : p.tonemap === 'reinhard' ? 1 : 2, white: p.whitePoint },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn hable(x: vec3f) -> vec3f {
  return (x * (${fl(HABLE.A)} * x + vec3f(${fl(HABLE.C * HABLE.B)})) + vec3f(${fl(HABLE.D * HABLE.E)})) / (x * (${fl(HABLE.A)} * x + vec3f(${fl(HABLE.B)})) + vec3f(${fl(HABLE.D * HABLE.F)})) - vec3f(${fl(HABLE.E / HABLE.F)});
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var x = max((srgbToLinear(s.rgb) - vec3f(u.black)) / max(1.0 - u.black, 1e-3), vec3f(0.0)) * u.gain;
  if (u.tm > 1.5) {
    let w = max(u.white, 1e-3);
    x = min(hable(x) / hable(vec3f(w)), vec3f(1.0));
  } else if (u.tm > 0.5) {
    let w = max(u.white, 1e-3);
    x = x * (vec3f(1.0) + x / (w * w)) / (vec3f(1.0) + x);
  } else {
    let span = max(1.0 - u.knee, 1e-6);
    let soft = vec3f(u.knee) + span * (vec3f(1.0) - exp(-(x - vec3f(u.knee)) / span));
    let capped = select(soft, vec3f(1.0), vec3<bool>(span <= 1e-6));
    x = select(x, capped, x > vec3f(u.knee));
  }
  return premul(vec4f(linearToSrgb(clamp(x, vec3f(0.0), vec3f(1.0))), s.a));
}`,
    });
    return { image };
  },
});
