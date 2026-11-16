import { defineNode } from '../../define';

/**
 * Chroma key in OKLab. Output is a matte: 1 where the pixel is NOT the key colour (foreground), 0 where it matches.
 * `invert` selects the key colour instead. Spill (green/blue colour cast on the subject) is removed by `despill`.
 */
export default defineNode({
  id: 'key-color',
  title: 'Chroma Key',
  category: 'mask',
  description: 'Chroma key: removes one chosen colour (green screen, flat sprite background). Output is a matte, 1 = keep. For picking a range of hues, see HSL Qualifier or Similar Color.',
  keywords: ['chroma', 'green screen', 'blue screen', 'matte', 'remove background', 'knockout', 'key color', 'key colour', 'colour key'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Matte' } },
  params: {
    key: { type: 'color', default: [0.0, 0.7, 0.25, 1], label: 'Key color' },
    tolerance: { type: 'number', default: 0.16, min: 0, max: 1, step: 0.005, label: 'Tolerance', hint: 'Distance in OKLab that is fully keyed out.' },
    softness: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Softness', hint: 'Extra distance over which the matte fades in.' },
    lumaWeight: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Brightness weight', hint: 'Lower values key shadows and highlights of the colour too.' },
    invert: { type: 'bool', default: false, label: 'Invert key', hint: 'Select everything but the key color.' },
  },
  summary: (p) => `tol ${p.tolerance.toFixed(2)}`,
  render(ctx) {
    const p = ctx.params;
    const mask = ctx.gpu.passMask({
      label: 'key-color',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { key: [p.key[0], p.key[1], p.key[2]], tol: p.tolerance, soft: Math.max(p.softness, 0.001), lw: p.lumaWeight, inv: p.invert },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let a = srgbToOklab(c.rgb);
  let k = srgbToOklab(u.key);
  var d = a - k;
  d.x *= u.lw;
  let dist = length(d);
  var m = smoothstep(u.tol, u.tol + u.soft, dist);
  if (u.inv > 0.5) { m = 1.0 - m; }
  return vec4f(vec3f(m * c.a), 1.0);
}`,
    });
    return { mask };
  },
});
