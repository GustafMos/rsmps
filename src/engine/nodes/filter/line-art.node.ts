import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

export default defineNode({
  id: 'line-art',
  title: 'Line Art',
  category: 'filter',
  description:
    'Turns a cleaned drawing into crisp, solid line art. Lines are found against the local paper brightness (so uneven light does not matter), can be made thicker or thinner, smoothed to remove jagged edges and recoloured. Filled colour areas can be kept.',
  keywords: ['ink', 'lineart', 'threshold', 'adaptive threshold', 'trace', 'outline', 'bitmap', 'crisp', 'sketch', 'thicken', 'thin', 'jaggies', 'clean'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    radius: { type: 'number', default: 24, min: 2, max: 300, softMax: 100, step: 1, unit: 'px', label: 'Local window', group: 'Find lines', hint: 'Bigger than the thickest line. The paper brightness is measured over this window.' },
    sensitivity: { type: 'number', default: 0.45, min: 0, max: 1, step: 0.01, label: 'Sensitivity', group: 'Find lines', hint: 'Higher picks up fainter pencil.' },
    thicken: { type: 'number', default: 0, min: -8, max: 12, softMax: 6, step: 0.1, unit: 'px', label: 'Thicken / thin', group: 'Lines', hint: 'Positive grows the strokes, negative shrinks them.' },
    smooth: { type: 'number', default: 1, min: 0, max: 12, softMax: 5, step: 0.1, unit: 'px', label: 'Smooth jaggies', group: 'Lines' },
    lineColor: { type: 'color', default: [0.05, 0.05, 0.08, 1], label: 'Line color', group: 'Output' },
    mode: {
      type: 'enum',
      default: 'lines',
      label: 'Fills',
      group: 'Output',
      options: [
        { value: 'lines', label: 'Lines only' },
        { value: 'fills', label: 'Keep colored fills' },
      ],
    },
    fillThreshold: { type: 'number', default: 0.18, min: 0.02, max: 0.8, step: 0.01, label: 'Fill threshold', hint: 'A color counts as fill above this.', group: 'Output', visibleIf: (p) => p.mode === 'fills' },
    background: { type: 'color', default: [1, 1, 1, 1], label: 'Paper color', group: 'Output', hint: 'Set alpha to 0 for transparent paper.' },
  },
  summary: (p) => `${p.mode === 'fills' ? 'lines + fills' : 'lines'} · ${p.thicken >= 0 ? '+' : ''}${p.thicken} px`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;

    // 1. brightness over white, and its local mean
    const lum = gpu.pass({
      label: 'lineart-lum',
      size: src,
      textures: { src },
      uniforms: {},
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let l = luma(s.rgb) + (1.0 - s.a);
  return vec4f(l, l, l, 1.0);
}`,
    });
    const local = gaussianBlur(gpu, lum, p.radius);
    const calm = gaussianBlur(gpu, lum, 1.1 * src.unit); // tames sensor noise and JPEG blocks before thresholding

    // 2. adaptive threshold -> ink coverage in .r (1 = ink)
    let ink = gpu.pass({
      label: 'lineart-ink',
      size: src,
      textures: { lum: calm, local },
      uniforms: { bias: 0.02 + (1 - p.sensitivity) * 0.16 },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let l = textureSampleLevel(lum, smpNearest, uv, 0.0).r;
  let m = textureSampleLevel(local, smp, uv, 0.0).r;
  // darker than the local paper by more than the bias counts as ink
  let d = (m - l) / max(m, 0.2);
  let v = smoothstep(u.bias * 0.7, u.bias * 1.3, d);
  return vec4f(v, v, v, 1.0);
}`,
    });

    // 3. grow / shrink the strokes (bounded: 3 rings of 16 taps)
    if (Math.abs(p.thicken) >= 0.25) {
      ink = gpu.pass({
        label: 'lineart-grow',
        size: src,
        textures: { ink },
        uniforms: { r: Math.abs(p.thicken), grow: p.thicken > 0 },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var m = textureSampleLevel(ink, smp, uv, 0.0).r;
  for (var k = 1; k <= 3; k++) {
    let r = u.r * f32(k) / 3.0;
    for (var i = 0; i < 16; i++) {
      let a = TAU * (f32(i) + 0.5 * f32(k & 1)) / 16.0;
      let t = textureSampleLevel(ink, smp, uv + vec2f(cos(a), sin(a)) * r / u.size, 0.0).r;
      m = select(min(m, t), max(m, t), u.grow > 0.5);
    }
  }
  return vec4f(m, m, m, 1.0);
}`,
      });
    }

    // 4. smooth the contour: blur then re-threshold with a narrow ramp (a little below 0.5 so hairlines survive)
    if (p.smooth >= 0.2) ink = gaussianBlur(gpu, ink, p.smooth);

    const fills = p.mode === 'fills';
    const image = gpu.pass({
      label: 'lineart',
      size: src,
      textures: { src, ink },
      uniforms: { smoothed: p.smooth >= 0.2, color: p.lineColor, bg: p.background, fillThr: p.fillThreshold },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let v = textureSampleLevel(ink, smp, uv, 0.0).r;
  var a = v;
  if (u.smoothed > 0.5) { a = smoothstep(0.28, 0.55, v); } else { a = step(0.5, v); }
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  var base = vec4f(u.bg.rgb * u.bg.a, u.bg.a);
  ${
    fills
      ? `let sc = unpremul(s);
  let chroma = max(sc.r, max(sc.g, sc.b)) - min(sc.r, min(sc.g, sc.b));
  let fill = smoothstep(u.fillThr * 0.7, u.fillThr * 1.3, chroma) * s.a;
  base = vec4f(sc.rgb * fill + base.rgb * (1.0 - fill), fill + base.a * (1.0 - fill));`
      : ''
  }
  let la = a * u.color.a;
  return vec4f(u.color.rgb * la + base.rgb * (1.0 - la), la + base.a * (1.0 - la));
}`,
    });
    return { image };
  },
});
