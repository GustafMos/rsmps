import { defineNode } from '../../define';

/** Linear / radial / mirrored / angular ramp between two points. Size follows the optional reference image, else the canvas. */
export default defineNode({
  id: 'gradient-mask',
  title: 'Gradient Mask',
  category: 'mask',
  description: 'A linear, radial or mirrored ramp between two points. Good for fades, vignettes and graduated filters.',
  keywords: ['ramp', 'fade', 'graduated', 'vignette', 'linear', 'radial'],
  inputs: { reference: { type: 'image', label: 'Size from' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    kind: {
      type: 'enum',
      default: 'linear',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'radial', label: 'Radial' },
        { value: 'reflected', label: 'Mirrored' },
        { value: 'angular', label: 'Angular' },
      ],
      label: 'Type',
    },
    from: { type: 'vec2', default: [0.5, 0.2], unit: 'norm', step: 0.001, label: 'Start (value 0)' },
    to: { type: 'vec2', default: [0.5, 0.8], unit: 'norm', step: 0.001, label: 'End (value 1)' },
    smooth: { type: 'bool', default: false, label: 'Smooth ends' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => p.kind,
  render(ctx) {
    const p = ctx.params;
    const ref = ctx.in.reference ?? ctx.canvas;
    const kinds = ['linear', 'radial', 'reflected', 'angular'];
    const mask = ctx.gpu.passMask({
      label: 'gradient-mask',
      size: { width: ref.width, height: ref.height, unit: ref.unit },
      uniforms: { a: p.from, b: p.to, kind: kinds.indexOf(p.kind), smoothEnds: p.smooth, inv: p.invert },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = u.a * u.size;
  let b = u.b * u.size;
  let ab = b - a;
  let len2 = max(dot(ab, ab), 1e-6);
  let p = uv * u.size - a;
  var t: f32;
  let k = i32(u.kind);
  if (k == 1) { t = length(p) / sqrt(len2); }
  else if (k == 2) { t = abs(dot(p, ab) / len2); }
  else if (k == 3) { t = fract((atan2(p.y, p.x) - atan2(ab.y, ab.x)) / TAU); }
  else { t = dot(p, ab) / len2; }
  t = clamp(t, 0.0, 1.0);
  if (u.smoothEnds > 0.5) { t = t * t * (3.0 - 2.0 * t); }
  if (u.inv > 0.5) { t = 1.0 - t; }
  return vec4f(vec3f(t), 1.0);
}`,
    });
    return { mask };
  },
});
