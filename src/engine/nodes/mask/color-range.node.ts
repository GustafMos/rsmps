import { defineNode } from '../../define';

export default defineNode({
  id: 'color-range',
  title: 'Color Range',
  category: 'mask',
  description: 'Selects pixels near a picked colour using separate hue, saturation and value tolerances.',
  keywords: ['select', 'hue', 'saturation', 'pick', 'sample', 'similar', 'magic wand'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    color: { type: 'color', default: [0.9, 0.2, 0.2, 1], label: 'Color' },
    hue: { type: 'number', default: 20, min: 0, max: 180, step: 0.5, unit: 'deg', label: 'Hue tolerance' },
    saturation: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Saturation tolerance' },
    value: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Value tolerance' },
    softness: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Softness', hint: 'Fraction of each tolerance used as a soft falloff.' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `±${p.hue}°`,
  render(ctx) {
    const p = ctx.params;
    const mask = ctx.gpu.passMask({
      label: 'color-range',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { pick: [p.color[0], p.color[1], p.color[2]], th: p.hue / 360, ts: p.saturation, tv: p.value, soft: Math.min(Math.max(p.softness, 0), 1), inv: p.invert },
      wgsl: /* wgsl */ `
fn fall(d: f32, tol: f32) -> f32 {
  let t = max(tol, 1e-4);
  return 1.0 - smoothstep(t * (1.0 - u.soft), t * (1.0 + u.soft) + 1e-4, d);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let h = rgbToHsv(c.rgb);
  let k = rgbToHsv(u.pick);
  var dh = abs(h.x - k.x);
  dh = min(dh, 1.0 - dh);
  // Hue is meaningless for greys: fade the hue test out as saturation drops.
  let hueFactor = smoothstep(0.03, 0.15, min(h.y, k.y));
  let mh = mix(1.0, fall(dh, u.th), hueFactor);
  var m = mh * fall(abs(h.y - k.y), u.ts) * fall(abs(h.z - k.z), u.tv);
  if (u.inv > 0.5) { m = 1.0 - m; }
  return vec4f(vec3f(m * c.a), 1.0);
}`,
    });
    return { mask };
  },
});
