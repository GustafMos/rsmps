import { defineNode } from '../../define';
import { CURVE_TABLE_SIZE, HUE_SHIFT_TURNS, LUM_SHIFT, hslCurveTable, isNeutralCurve, rgbCurveTable } from '../../lib/color-math';
import { COLOR_WGSL, fl } from '../../lib/color-wgsl';
import { presetLinear } from '../../lib/util-curve';
import type { CurveValue } from '../../types';

const flat = (): CurveValue => ({ keys: [{ t: 0, v: 0.5, interp: 'linear' }, { t: 0.999, v: 0.5, interp: 'linear' }] });
const flatLoop = (): CurveValue => ({ keys: [{ t: 0, v: 0.5, interp: 'smooth' }] });

const HUE_HINT = 'The horizontal axis is the colour wheel (0 = red, 1/6 yellow, 1/3 green, 1/2 cyan, 2/3 blue, 5/6 magenta) and wraps around: red is both ends. Vertical: 0.5 = no change. ';

export default defineNode({
  id: 'curves',
  title: 'Curves',
  category: 'color',
  description:
    'Master, red, green and blue curves, plus the colourist curves Hue vs Hue, Hue vs Sat, Hue vs Lum, Lum vs Sat and Sat vs Sat, all in one pass from small lookup textures.',
  keywords: ['grade', 'curves', 'rgb curves', 'master', 'tone curve', 'hue vs hue', 'hue vs sat', 'hue vs lum', 'lum vs sat', 'sat vs sat', 'colour curves', 'color curves', 'resolve', 'contrast', 's-curve'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    master: { type: 'curve', default: presetLinear(), min: 0, max: 1, label: 'Master', group: 'RGB', hint: 'Input on the horizontal axis, output on the vertical one, on the values as stored (display-encoded). Master is applied to R, G and B first, then each channel curve.' },
    red: { type: 'curve', default: presetLinear(), min: 0, max: 1, label: 'Red', group: 'RGB' },
    green: { type: 'curve', default: presetLinear(), min: 0, max: 1, label: 'Green', group: 'RGB' },
    blue: { type: 'curve', default: presetLinear(), min: 0, max: 1, label: 'Blue', group: 'RGB' },
    hueVsHue: { type: 'curve', default: flatLoop(), min: 0, max: 1, label: 'Hue vs Hue', group: 'Color', hint: HUE_HINT + 'The full height is +/- 180 degrees of hue shift (done in OKLab, lightness constant).' },
    hueVsSat: { type: 'curve', default: flatLoop(), min: 0, max: 1, label: 'Hue vs Sat', group: 'Color', hint: HUE_HINT + 'Saturation multiplier = 2 x value: 0 removes the colour, 1 doubles it.' },
    hueVsLum: { type: 'curve', default: flatLoop(), min: 0, max: 1, label: 'Hue vs Lum', group: 'Color', hint: HUE_HINT + 'Shifts OKLab lightness by up to +/- 0.5 for that hue. Greys are not affected.' },
    lumVsSat: { type: 'curve', default: flat(), min: 0, max: 1, label: 'Lum vs Sat', group: 'Color', hint: 'Horizontal: OKLab lightness 0..1. Vertical: 0.5 = no change, saturation multiplier = 2 x value.' },
    satVsSat: { type: 'curve', default: flat(), min: 0, max: 1, label: 'Sat vs Sat', group: 'Color', hint: 'Horizontal: HSV saturation 0..1. Vertical: 0.5 = no change, saturation multiplier = 2 x value. Pull the right end down to tame the most saturated colours.' },
  },
  summary: (p) => `${p.master.keys.length}+${p.red.keys.length}+${p.green.keys.length}+${p.blue.keys.length} points`,
  render(ctx) {
    const p = ctx.params;
    const hsl = [p.hueVsHue, p.hueVsSat, p.hueVsLum, p.lumVsSat, p.satVsSat];
    const useHsl = !hsl.every((c) => isNeutralCurve(c));
    const rgbTex = ctx.gpu.dataTexture(rgbCurveTable(p.master, p.red, p.green, p.blue), CURVE_TABLE_SIZE, 1);
    const hslTex = ctx.gpu.dataTexture(hslCurveTable(hsl), CURVE_TABLE_SIZE, 5);
    const image = ctx.gpu.pass({
      label: 'curves',
      size: ctx.in.image,
      textures: { src: ctx.in.image, curRgb: rgbTex, curHsl: hslTex },
      uniforms: { useHsl },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn cg_tabX(v: f32) -> f32 { return (clamp(v, 0.0, 1.0) * ${fl(CURVE_TABLE_SIZE - 1)} + 0.5) / ${fl(CURVE_TABLE_SIZE)}; }
fn cg_row(row: f32, x: f32) -> f32 { return textureSampleLevel(curHsl, smp, vec2f(cg_tabX(x), (row + 0.5) / 5.0), 0.0).r; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var c = vec3f(
    textureSampleLevel(curRgb, smp, vec2f(cg_tabX(s.r), 0.5), 0.0).r,
    textureSampleLevel(curRgb, smp, vec2f(cg_tabX(s.g), 0.5), 0.0).g,
    textureSampleLevel(curRgb, smp, vec2f(cg_tabX(s.b), 0.5), 0.0).b);
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  if (u.useHsl > 0.5) {
    let hsv = rgbToHsv(c);
    let lab = linearToOklab(srgbToLinear(c));
    let C = length(lab.yz);
    let w = smoothstep(0.02, 0.1, hsv.y);
    var hk = atan2(lab.z, lab.y) / TAU;
    hk = hk + (cg_row(0.0, hsv.x) - 0.5) * ${fl(2 * HUE_SHIFT_TURNS)} * w;
    var m = mix(1.0, 2.0 * cg_row(1.0, hsv.x), w);
    m = m * 2.0 * cg_row(3.0, lab.x) * 2.0 * cg_row(4.0, hsv.y);
    let L = lab.x + (cg_row(2.0, hsv.x) - 0.5) * ${fl(2 * LUM_SHIFT)} * w;
    let ang = hk * TAU;
    c = clamp(linearToSrgb(cg_gamutLC(L, vec2f(cos(ang), sin(ang)) * C * m)), vec3f(0.0), vec3f(1.0));
  }
  return premul(vec4f(c, s.a));
}`,
    });
    return { image };
  },
});
