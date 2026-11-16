import { defineNode } from '../../define';

/**
 * EXEMPLAR — one-pass filter. Shows: required input, `maskable`, uniforms, premultiplied handling.
 * This is the shape of ~80% of nodes: declare params, write one WGSL function.
 */
export default defineNode({
  id: 'color-adjust',
  title: 'Color Adjust',
  category: 'color',
  description:
    'Quick tweaks in one node: exposure, contrast, brightness, saturation, gamma, hue, temperature and tint, applied to the stored (display) values. For grading that behaves like the tools of a grading app use White Balance, Saturation / Vibrance, Lift Gamma Gain, Curves, Exposure, Colour Space and LUT.',
  keywords: ['grade', 'correct', 'brightness', 'contrast', 'saturation', 'hue', 'quick', 'white balance', 'lift gamma gain', 'curves', 'lut'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    exposure: { type: 'number', default: 0, min: -4, max: 4, step: 0.01, label: 'Exposure' },
    contrast: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Contrast' },
    brightness: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness' },
    saturation: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Saturation' },
    gamma: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.01, label: 'Gamma' },
    hue: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Hue shift' },
    temperature: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Temperature' },
    tint: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Tint' },
  },
  render(ctx) {
    const p = ctx.params;
    const image = ctx.gpu.pass({
      label: 'color-adjust',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: {
        gain: Math.pow(2, p.exposure),
        contrast: p.contrast,
        brightness: p.brightness,
        saturation: p.saturation,
        invGamma: 1 / p.gamma,
        hue: p.hue / 360,
        temperature: p.temperature,
        tint: p.tint,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var c = s.rgb * u.gain;
  c += vec3f(u.temperature * 0.1, u.tint * -0.1, u.temperature * -0.1);
  c = (c - 0.5) * u.contrast + 0.5 + u.brightness;
  var hsv = rgbToHsv(clamp(c, vec3f(0.0), vec3f(1.0)));
  hsv.x = fract(hsv.x + u.hue);
  hsv.y = clamp(hsv.y * u.saturation, 0.0, 1.0);
  c = pow(hsvToRgb(hsv), vec3f(u.invGamma));
  return premul(vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
