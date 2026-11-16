import { defineNode } from '../../define';
import { COLOR_WGSL } from '../../lib/color-wgsl';

export default defineNode({
  id: 'hsl-qualifier',
  title: 'HSL Qualifier',
  category: 'mask',
  description:
    'Selects pixels by explicit hue, saturation and lightness ranges with soft edges, like the HSL qualifier of a grading app. The matte comes out as a Mask: wire it into any node\'s Mask input to limit it to "the blue of the sea". Turn on the preview to see what is selected.',
  keywords: ['qualifier', 'key', 'colour key', 'color key', 'hsl', 'hue', 'select', 'matte', 'isolate', 'secondary', 'grade', 'chroma key', 'pick colour', 'range'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Matte' }, preview: { type: 'image', label: 'Preview' } },
  params: {
    hueCenter: { type: 'number', default: 220, min: 0, max: 360, step: 1, unit: 'deg', label: 'Hue', group: 'Hue', hint: 'HSL hue of the encoded picture: 0 red, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta.' },
    hueWidth: { type: 'number', default: 30, min: 0, max: 180, step: 0.5, unit: 'deg', label: 'Hue width', group: 'Hue', hint: 'Half-width of the fully selected hue band. 180 turns the hue test off. Greys (no hue) are never selected while the test is on.' },
    hueSoft: { type: 'number', default: 15, min: 0, max: 90, step: 0.5, unit: 'deg', label: 'Hue softness', group: 'Hue' },
    satLow: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Saturation low', group: 'Saturation' },
    satHigh: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'Saturation high', group: 'Saturation' },
    satSoft: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Sat softness', group: 'Saturation' },
    lumLow: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Lightness low', group: 'Lightness', hint: 'HSL lightness (max + min) / 2 of the stored values.' },
    lumHigh: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'Lightness high', group: 'Lightness' },
    lumSoft: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Lightness softness', group: 'Lightness' },
    invert: { type: 'bool', default: false, label: 'Invert' },
    preview: {
      type: 'enum',
      default: 'off',
      label: 'Preview',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'highlight', label: 'Color on gray' },
      ],
      hint: 'The Preview output (one extra pass, only when on). The Matte output is always a plain mask you can also view directly.',
    },
  },
  summary: (p) => `hue ${Math.round(p.hueCenter)}° ±${Math.round(p.hueWidth)}°`,
  render(ctx) {
    const p = ctx.params;
    const mask = ctx.gpu.passMask({
      label: 'hsl-qualifier',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: {
        hueC: p.hueCenter / 360,
        hueW: p.hueWidth / 360,
        hueS: p.hueSoft / 360,
        satLo: p.satLow,
        satHi: p.satHigh,
        satS: p.satSoft,
        lumLo: p.lumLow,
        lumHi: p.lumHigh,
        lumS: p.lumSoft,
        inv: p.invert,
      },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let hsl = cg_rgbToHsl(c.rgb);
  var dh = abs(hsl.x - u.hueC);
  dh = min(dh, 1.0 - dh);
  var hueM = 1.0;
  if (u.hueW < 0.4999) {
    hueM = (1.0 - smoothstep(u.hueW, u.hueW + max(u.hueS, 1e-4), dh)) * smoothstep(0.02, 0.1, hsl.y);
  }
  var m = hueM * cg_softRange(hsl.y, u.satLo, u.satHi, u.satS) * cg_softRange(hsl.z, u.lumLo, u.lumHi, u.lumS);
  if (u.inv > 0.5) { m = 1.0 - m; }
  return vec4f(vec3f(m * c.a), 1.0);
}`,
    });
    let preview = null;
    if (p.preview === 'highlight') {
      preview = ctx.gpu.pass({
        label: 'hsl-qualifier-preview',
        size: ctx.in.image,
        textures: { src: ctx.in.image, matte: mask },
        wgsl: /* wgsl */ `${COLOR_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  let m = textureSampleLevel(matte, smpNearest, uv, 0.0).r;
  let dim = vec3f(cg_luma(c.rgb) * 0.3);
  return vec4f(mix(dim, c.rgb, m), c.a);
}`,
      });
    }
    return { mask, preview };
  },
});
