import { defineNode } from '../../define';
import { gaussianBlur } from '../filter/blur.node';

export default defineNode({
  id: 'crt',
  title: 'CRT Monitor',
  category: 'stylize',
  description: 'Old tube-television look in one node: curved screen, scanlines, RGB phosphor mask, glow and edge falloff.',
  keywords: ['retro', 'television', 'monitor', 'tube', 'scanlines', 'curvature', 'phosphor', 'arcade'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    curvature: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Screen curvature' },
    scanlines: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Scanlines' },
    mask: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'RGB phosphor mask' },
    glow: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Glow' },
    lineSize: { type: 'number', default: 3, min: 1.5, max: 24, step: 0.5, unit: 'px', label: 'Line size', hint: 'Height of one scanline; the phosphor stripes use the same size.' },
    blackCorners: { type: 'bool', default: true, label: 'Black outside the screen' },
  },
  summary: (p) => `curve ${Math.round(p.curvature * 100)}% · lines ${Math.round(p.scanlines * 100)}%`,
  render(ctx) {
    const p = ctx.params;
    if (p.curvature <= 0 && p.scanlines <= 0 && p.mask <= 0 && p.glow <= 0) return { image: ctx.in.image };
    const glow = p.glow > 0 ? gaussianBlur(ctx.gpu, ctx.in.image, p.lineSize * 2.5) : ctx.in.image;
    const image = ctx.gpu.pass({
      label: 'crt',
      size: ctx.in.image,
      textures: { src: ctx.in.image, glow },
      uniforms: { curve: p.curvature, scan: p.scanlines, mask: p.mask, glowAmt: p.glow, line: p.lineSize, black: p.blackCorners },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let cc = uv * 2.0 - 1.0;
  let k = u.curve * 0.3;
  let w = cc * (1.0 + vec2f(cc.y * cc.y, cc.x * cc.x) * k);
  let wuv = w * 0.5 + 0.5;
  let edge = vec2f(0.01);
  let inside = smoothstep(vec2f(0.0), edge, wuv) * (1.0 - smoothstep(vec2f(1.0) - edge, vec2f(1.0), wuv));
  let cover = inside.x * inside.y;
  let s = unpremul(textureSampleLevel(src, smp, clamp(wuv, vec2f(0.0), vec2f(1.0)), 0.0));
  let g = unpremul(textureSampleLevel(glow, smp, clamp(wuv, vec2f(0.0), vec2f(1.0)), 0.0));
  // scanlines: bright at the row centre, dark between rows (screen space)
  let row = 0.5 + 0.5 * cos(TAU * px.y / u.line);
  let scanMul = 1.0 - u.scan * (1.0 - row) * 0.9;
  // phosphor triads
  let idx = i32(floor(fract(px.x / (u.line * 1.5)) * 3.0));
  let tri = mix(vec3f(0.35), vec3f(1.0), vec3f(f32(idx == 0), f32(idx == 1), f32(idx == 2)));
  let maskMul = mix(vec3f(1.0), tri * (3.0 / (1.0 + 2.0 * 0.35)), u.mask);
  var col = s.rgb * scanMul * maskMul;
  col += g.rgb * g.a * u.glowAmt * 0.6;
  col *= 1.0 + 0.25 * (u.scan * 0.6 + u.mask * 0.6);
  col *= 1.0 - u.curve * 0.55 * smoothstep(0.55, 1.5, length(cc));
  col = clamp(col, vec3f(0.0), vec3f(1.0));
  let lit = premul(vec4f(col, s.a));
  if (u.black > 0.5) { return mix(vec4f(0.0, 0.0, 0.0, 1.0), lit, cover); }
  return lit * cover;
}`,
    });
    return { image };
  },
});
