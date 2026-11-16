import { defineNode } from '../../define';
import { COLOR_WGSL } from '../../lib/color-wgsl';

export default defineNode({
  id: 'saturation',
  title: 'Saturation / Vibrance',
  category: 'color',
  description:
    'Changes colour intensity without changing brightness. The default scales chroma in OKLab (hue and perceived lightness stay put, out-of-gamut colours lose chroma instead of clipping). Also linear-light luma-weighted and classic HSL modes, vibrance, and roll-off in shadows and highlights.',
  keywords: ['grade', 'saturation', 'vibrance', 'desaturate', 'chroma', 'colourfulness', 'colorfulness', 'luminance preserving', 'oklab', 'oklch', 'hsl', 'muted', 'vivid', 'skin'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'oklab',
      label: 'Method',
      options: [
        { value: 'oklab', label: 'OKLab chroma' },
        { value: 'linear', label: 'Linear light' },
        { value: 'hsl', label: 'HSL' },
      ],
      hint: 'OKLab: chroma is scaled at constant OKLab lightness and hue. Linear: colour is moved toward / away from its Rec.709 luma Y in LINEAR light (Y is constant). Both reduce chroma at the gamut edge instead of clipping. HSL scales saturation of the encoded values; it is the cheap legacy method and shifts brightness.',
    },
    saturation: { type: 'number', default: 1, min: 0, max: 4, softMax: 3, step: 0.01, label: 'Saturation', hint: '1 = unchanged, 0 = grey (luminance is kept in the first two methods).' },
    vibrance: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Vibrance', hint: 'Positive boosts muted colours more than already vivid ones. Negative tames the vivid ones first. Measured in OKLab chroma.', group: 'Vibrance' },
    protectSkin: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Protect skin tones', hint: 'Reduces positive vibrance on orange-red skin hues (a heuristic band around one OKLCh hue angle).', group: 'Vibrance' },
    shadowRolloff: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Shadow roll-off', hint: 'Fades the saturation change out in the shadows (below about 40% OKLab lightness).', group: 'Roll-off' },
    highlightRolloff: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Highlight roll-off', hint: 'Fades the saturation change out in the highlights (above about 60% OKLab lightness).', group: 'Roll-off' },
  },
  summary: (p) => `${p.mode} · ${p.saturation.toFixed(2)}${p.vibrance ? ` · vib ${p.vibrance.toFixed(2)}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const image = ctx.gpu.pass({
      label: 'saturation',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: {
        mode: p.mode === 'oklab' ? 0 : p.mode === 'linear' ? 1 : 2,
        sat: p.saturation,
        vib: p.vibrance,
        protect: p.protectSkin,
        shRoll: p.shadowRolloff,
        hiRoll: p.highlightRolloff,
      },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let lin = srgbToLinear(s.rgb);
  let lab = linearToOklab(lin);
  let C = length(lab.yz);
  let hue = fract(atan2(lab.z, lab.y) / TAU);
  let m = cg_satGain(u.sat, u.vib, u.protect, u.shRoll, u.hiRoll, lab.x, C, hue);
  var enc: vec3f;
  if (u.mode < 0.5) {
    enc = linearToSrgb(clamp(cg_gamutLC(lab.x, lab.yz * m), vec3f(0.0), vec3f(1.0)));
  } else if (u.mode < 1.5) {
    let Y = cg_luma(lin);
    var k = m;
    if (m > 1.0) {
      let d = lin - vec3f(Y);
      for (var i = 0; i < 3; i++) {
        if (d[i] > 1e-6) { k = min(k, (1.0 - Y) / d[i]); }
        else if (d[i] < -1e-6) { k = min(k, Y / (-d[i])); }
      }
      k = max(k, 1.0);
    }
    enc = linearToSrgb(clamp(vec3f(Y) + k * (lin - vec3f(Y)), vec3f(0.0), vec3f(1.0)));
  } else {
    var hsl = cg_rgbToHsl(s.rgb);
    hsl.y = clamp(hsl.y * m, 0.0, 1.0);
    enc = clamp(cg_hslToRgb(hsl), vec3f(0.0), vec3f(1.0));
  }
  return premul(vec4f(enc, s.a));
}`,
    });
    return { image };
  },
});
