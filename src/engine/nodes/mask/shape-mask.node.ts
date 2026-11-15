import { defineNode } from '../../define';

/** Rectangle or ellipse mask with rotation, corner rounding, feather and invert. Size follows the optional reference image, else the canvas. */
export default defineNode({
  id: 'shape-mask',
  title: 'Shape Mask',
  category: 'mask',
  description: 'A rectangle or ellipse mask with rotation, rounded corners and a feathered edge.',
  keywords: ['rectangle', 'ellipse', 'circle', 'vignette', 'region', 'box'],
  inputs: { reference: { type: 'image', label: 'Size from' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    shape: {
      type: 'enum',
      default: 'rectangle',
      options: [
        { value: 'rectangle', label: 'Rectangle' },
        { value: 'ellipse', label: 'Ellipse' },
      ],
      label: 'Shape',
    },
    center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', step: 0.001, label: 'Center' },
    size: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: 0, max: 4, step: 0.001, label: 'Size', hint: 'Width and height as a fraction of the frame.' },
    rotation: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Rotation' },
    corner: { type: 'number', default: 0, min: 0, max: 2000, step: 0.5, unit: 'px', label: 'Corner radius', visibleIf: (p) => p.shape === 'rectangle' },
    feather: { type: 'number', default: 0, min: 0, max: 1000, step: 0.5, unit: 'px', label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `${p.shape}${p.invert ? ' · inverted' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const ref = ctx.in.reference ?? ctx.canvas;
    const mask = ctx.gpu.passMask({
      label: 'shape-mask',
      size: { width: ref.width, height: ref.height, unit: ref.unit },
      uniforms: {
        center: p.center,
        half: [p.size[0] * 0.5, p.size[1] * 0.5],
        rot: (p.rotation * Math.PI) / 180,
        corner: p.corner,
        feather: Math.max(p.feather, 1),
        ellipse: p.shape === 'ellipse',
        inv: p.invert,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = (uv - u.center) * u.size;
  let c = cos(u.rot); let s = sin(u.rot);
  let q = vec2f(c * d.x + s * d.y, -s * d.x + c * d.y);
  let h = u.half * u.size;
  var sd: f32;
  if (u.ellipse > 0.5) {
    let hh = max(h, vec2f(0.5));
    let k0 = length(q / hh);
    let k1 = length(q / (hh * hh));
    let nonZero = k1 > 1e-6;
    sd = select(-min(hh.x, hh.y), k0 * (k0 - 1.0) / max(k1, 1e-6), nonZero);
  } else {
    let rc = min(u.corner, min(h.x, h.y));
    let e = abs(q) - (h - vec2f(rc));
    sd = length(max(e, vec2f(0.0))) + min(max(e.x, e.y), 0.0) - rc;
  }
  var cov = clamp(0.5 - sd / u.feather, 0.0, 1.0);
  if (u.feather > 1.5) { cov = smoothstep(0.0, 1.0, cov); }
  if (u.inv > 0.5) { cov = 1.0 - cov; }
  return vec4f(vec3f(cov), 1.0);
}`,
    });
    return { mask };
  },
});
