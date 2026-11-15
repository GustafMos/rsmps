import { defineNode } from '../../define';
import { DETECT_PARAMS } from '../../lib/track-core';
import { regionsFromStrength } from '../../lib/track-detect';
import { gaussianBlur } from '../filter/blur.node';

export default defineNode({
  id: 'detect-color',
  title: 'Detect Colour',
  category: 'track',
  description:
    'Finds areas of one picked colour, such as a tracking marker or a coloured prop, and outputs them as regions. Colours are compared the way the eye sees them (OKLab), so the tolerance feels even across hues.',
  keywords: ['detect', 'color', 'colour', 'marker', 'track', 'prop', 'find', 'key'],
  cpu: true,
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { regions: { type: 'regions', label: 'Regions' }, mask: { type: 'mask', label: 'Detected pixels' } },
  params: {
    color: { type: 'color', default: [1, 0.15, 0.1, 1], label: 'Colour to find' },
    tolerance: { type: 'number', default: 0.15, min: 0.01, max: 1, step: 0.005, label: 'Tolerance', hint: 'How far a pixel may be from the colour (OKLab distance). 0.1 is strict, 0.3 is loose.' },
    softness: { type: 'number', default: 0.04, min: 0, max: 0.5, step: 0.005, label: 'Softness' },
    lightness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Care about brightness', hint: 'Lower values also match darker or lighter shades of the colour.' },
    blur: { type: 'number', default: 1, min: 0, max: 50, step: 0.5, unit: 'px', label: 'Smooth first' },
    label: { type: 'string', default: 'color', label: 'Label' },
    ...DETECT_PARAMS,
  },
  summary: (p) => `${p.label} ±${p.tolerance}`,
  async render(ctx) {
    const p = ctx.params;
    const src = gaussianBlur(ctx.gpu, ctx.in.image, p.blur);
    const mask = ctx.gpu.passMask({
      label: 'detect-color',
      size: ctx.in.image,
      textures: { src },
      uniforms: { tcol: [p.color[0], p.color[1], p.color[2]], tol: p.tolerance, soft: Math.max(p.softness, 0.004), wl: p.lightness },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let raw = textureSampleLevel(src, smp, uv, 0.0);
  let c = unpremul(raw);
  let a = srgbToOklab(c.rgb);
  let b = srgbToOklab(u.tcol);
  let d = a - b;
  let dist = length(vec3f(d.x * u.wl, d.y, d.z));
  let s = clamp(0.5 + (u.tol - dist) / (2.0 * u.soft), 0.0, 1.0) * select(0.0, 1.0, raw.a > 0.5);
  return vec4f(s, s, s, 1.0);
}`,
    });
    const items = await regionsFromStrength(ctx.gpu, mask, p, p.label);
    return { regions: { kind: 'regions', items }, mask };
  },
});
