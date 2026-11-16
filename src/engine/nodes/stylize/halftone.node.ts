import { defineNode } from '../../define';

export default defineNode({
  id: 'halftone',
  title: 'Halftone',
  category: 'stylize',
  description: 'Print-style dots whose size follows the image brightness: single ink, or cyan/magenta/yellow/black like a colour press.',
  keywords: ['dots', 'print', 'comic', 'newspaper', 'cmyk', 'pop art', 'screen'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'mono',
      label: 'Inks',
      options: [
        { value: 'mono', label: 'One ink' },
        { value: 'cmyk', label: 'CMYK' },
      ],
    },
    dotSize: { type: 'number', default: 8, min: 2, max: 80, step: 0.5, unit: 'px', label: 'Dot spacing' },
    angle: { type: 'number', default: 45, min: 0, max: 90, step: 1, unit: 'deg', label: 'Screen angle' },
    contrast: { type: 'number', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Contrast' },
    ink: { type: 'color', default: [0.05, 0.05, 0.08, 1], label: 'Ink color', visibleIf: (p) => p.mode === 'mono' },
    paper: { type: 'color', default: [1, 0.98, 0.93, 1], label: 'Paper color' },
  },
  summary: (p) => `${p.mode === 'cmyk' ? 'CMYK' : 'Mono'} · ${p.dotSize} px`,
  render(ctx) {
    const p = ctx.params;
    const image = ctx.gpu.pass({
      label: 'halftone',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { cell: Math.max(2, p.dotSize), angle: (p.angle * Math.PI) / 180, contrast: p.contrast, cmyk: p.mode === 'cmyk', ink: p.ink, paper: p.paper },
      wgsl: /* wgsl */ `
fn rot(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn inkOf(c: vec3f, which: i32) -> f32 {
  let k = 1.0 - max(c.r, max(c.g, c.b));
  let d = max(1.0 - k, 0.0001);
  var v = 1.0 - luma(c);
  if (which == 1) { v = (1.0 - c.r - k) / d; }
  if (which == 2) { v = (1.0 - c.g - k) / d; }
  if (which == 3) { v = (1.0 - c.b - k) / d; }
  if (which == 4) { v = k; }
  return clamp((v - 0.5) * u.contrast + 0.5, 0.0, 1.0);
}
// coverage (0..1) of one dot screen at this pixel. which: 0 = mono, 1..4 = C M Y K
fn screen(px: vec2f, ang: f32, which: i32) -> f32 {
  let q = rot(-ang) * px;
  let idx = floor(q / u.cell);
  let cq = (idx + 0.5) * u.cell;
  let cpx = rot(ang) * cq;
  let h = u.cell * 0.25;
  var acc = vec4f(0.0);
  acc += textureSampleLevel(src, smp, cpx / u.size, 0.0);
  acc += textureSampleLevel(src, smp, (cpx + vec2f(h, h)) / u.size, 0.0);
  acc += textureSampleLevel(src, smp, (cpx + vec2f(-h, h)) / u.size, 0.0);
  acc += textureSampleLevel(src, smp, (cpx + vec2f(h, -h)) / u.size, 0.0);
  acc += textureSampleLevel(src, smp, (cpx + vec2f(-h, -h)) / u.size, 0.0);
  let c = unpremul(acc / 5.0);
  let amt = inkOf(c.rgb, which);
  let r = sqrt(amt) * u.cell * 0.7071 + smoothstep(0.9, 1.0, amt) * 0.75;
  let d = length(q - cq);
  return smoothstep(-0.75, 0.75, r - d) * smoothstep(0.0, 0.04, amt);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(src, smpNearest, uv, 0.0).a;
  var rgb: vec3f;
  if (u.cmyk > 0.5) {
    let cC = screen(px, u.angle + radians(15.0), 1);
    let cM = screen(px, u.angle + radians(75.0), 2);
    let cY = screen(px, u.angle + radians(0.0), 3);
    let cK = screen(px, u.angle, 4);
    rgb = u.paper.rgb * vec3f(1.0 - cC, 1.0 - cM, 1.0 - cY) * (1.0 - cK);
  } else {
    rgb = mix(u.paper.rgb, u.ink.rgb, screen(px, u.angle, 0));
  }
  return premul(vec4f(rgb, a));
}`,
    });
    return { image };
  },
});
