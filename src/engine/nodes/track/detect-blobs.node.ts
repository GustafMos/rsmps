import { defineNode } from '../../define';
import { DETECT_PARAMS } from '../../lib/track-core';
import { regionsFromStrength } from '../../lib/track-detect';
import { gaussianBlur } from '../filter/blur.node';

const MODES = [
  { value: 'bright', label: 'Bright spots' },
  { value: 'dark', label: 'Dark spots' },
  { value: 'saturated', label: 'Vivid color spots' },
] as const;

export default defineNode({
  id: 'detect-blobs',
  title: 'Detect Blobs',
  category: 'track',
  description:
    'Finds bright, dark or vividly colored spots (stars, lights, highlights, shadows) and outputs them as regions. Wire the regions into Region Overlay to draw boxes on them, or Regions To Mask to apply any effect only there.',
  keywords: ['detect', 'stars', 'lights', 'highlights', 'spots', 'bright', 'threshold', 'find', 'objects'],
  cpu: true,
  guide: {
    does: 'Finds bright, dark or very colorful spots in the picture and gives you their boxes (regions).',
    steps: [
      'Wire a picture into Picture to search.',
      'Set Look for and Threshold until the spots you want are found (look at the Detected pixels output).',
      'Wire Regions into Track, then into Effects On Regions or Region Overlay.',
    ],
    needs: [
      { input: 'image', hint: 'The picture to search for spots.' },
    ],
    seeAlso: ['track', 'region-fx', 'region-overlay', 'detect-color'],
  },
  inputs: { image: { type: 'image', required: true, label: 'Picture to search' } },
  outputs: { regions: { type: 'regions', label: 'Regions' }, mask: { type: 'mask', label: 'Detected pixels' } },
  params: {
    mode: { type: 'enum', default: 'bright', options: MODES, label: 'Look for' },
    threshold: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Threshold', hint: 'Bright: how bright a pixel must be. Dark: how dark. Vivid: how saturated and bright.' },
    softness: { type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.01, label: 'Softness', hint: 'Width of the soft edge around the threshold.' },
    blur: { type: 'number', default: 1, min: 0, max: 50, step: 0.5, unit: 'px', label: 'Smooth first', hint: 'Blurs before measuring so noise does not create tiny regions.' },
    label: { type: 'string', default: 'blob', label: 'Label' },
    ...DETECT_PARAMS,
  },
  summary: (p) => `${p.mode} > ${p.threshold}`,
  async render(ctx) {
    const p = ctx.params;
    const src = gaussianBlur(ctx.gpu, ctx.in.image, p.blur);
    const mask = ctx.gpu.passMask({
      label: 'detect-blobs',
      size: ctx.in.image,
      textures: { src },
      uniforms: { mode: p.mode === 'bright' ? 0 : p.mode === 'dark' ? 1 : 2, thr: p.threshold, soft: Math.max(p.softness, 0.004) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let col = unpremul(c);
  var v = luma(col.rgb);
  if (u.mode > 1.5) { let h = rgbToHsv(col.rgb); v = h.y * h.z; }
  else if (u.mode > 0.5) { v = 1.0 - v; }
  v = v * c.a;
  let s = clamp(0.5 + (v - u.thr) / (2.0 * u.soft), 0.0, 1.0);
  return vec4f(s, s, s, 1.0);
}`,
    });
    const items = await regionsFromStrength(ctx.gpu, mask, p, p.label);
    return { regions: { kind: 'regions', items }, mask };
  },
});
