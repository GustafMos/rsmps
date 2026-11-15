import { defineNode } from '../../define';

export default defineNode({
  id: 'mask-levels',
  title: 'Mask Levels',
  category: 'mask',
  description: 'Adjusts the contrast of a mask (black/white point, gamma) or turns it into a hard/soft threshold.',
  keywords: ['contrast', 'threshold', 'curve', 'clip', 'gamma', 'binarize'],
  inputs: { mask: { type: 'mask', required: true, label: 'Mask' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    mode: {
      type: 'enum',
      default: 'levels',
      options: [
        { value: 'levels', label: 'Levels' },
        { value: 'threshold', label: 'Threshold' },
      ],
      label: 'Mode',
    },
    black: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Black point', visibleIf: (p) => p.mode === 'levels' },
    white: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'White point', visibleIf: (p) => p.mode === 'levels' },
    gamma: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.01, label: 'Gamma', visibleIf: (p) => p.mode === 'levels' },
    threshold: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Threshold', visibleIf: (p) => p.mode === 'threshold' },
    softness: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Softness', visibleIf: (p) => p.mode === 'threshold' },
  },
  summary: (p) => (p.mode === 'threshold' ? `>= ${p.threshold.toFixed(2)}` : `${p.black.toFixed(2)}-${p.white.toFixed(2)}`),
  render(ctx) {
    const p = ctx.params;
    const mask = ctx.gpu.passMask({
      label: 'mask-levels',
      size: ctx.in.mask,
      textures: { src: ctx.in.mask },
      uniforms: { thr: p.mode === 'threshold', t: p.threshold, soft: p.softness, b: p.black, w: Math.max(p.white, p.black + 0.001), ig: 1 / p.gamma },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let m = textureSampleLevel(src, smpNearest, uv, 0.0).r;
  var v: f32;
  if (u.thr > 0.5) {
    let h = max(u.soft * 0.5, 0.0005);
    v = smoothstep(u.t - h, u.t + h, m);
  } else {
    v = pow(clamp((m - u.b) / (u.w - u.b), 0.0, 1.0), u.ig);
  }
  return vec4f(vec3f(v), 1.0);
}`,
    });
    return { mask };
  },
});
