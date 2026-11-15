import { defineNode } from '../../define';
import { gaussianBlur } from '../filter/blur.node';

export default defineNode({
  id: 'contour-lines',
  title: 'Contour Lines',
  category: 'stylize',
  description:
    'Draws iso-lines like a topographic map: a line wherever the brightness (or a soft glow around the subject) crosses an evenly spaced level. Add a little wobble for the wavy rings that radiate out of a shape.',
  keywords: ['contour', 'topographic', 'iso', 'isolines', 'rings', 'radiate', 'waves', 'level lines', 'height map', 'outline', 'ripple', 'echo'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    field: {
      type: 'enum',
      default: 'luminance',
      label: 'Lines follow',
      options: [
        { value: 'luminance', label: 'Brightness' },
        { value: 'subject', label: 'Glow around the subject (rings)' },
      ],
    },
    smoothing: { type: 'number', default: 3, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'Smooth the field', group: 'Field', visibleIf: (p) => p.field === 'luminance' },
    spread: { type: 'number', default: 60, min: 2, max: 400, softMax: 200, step: 1, unit: 'px', label: 'Ring reach', group: 'Field', hint: 'How far the rings radiate from the subject.', visibleIf: (p) => p.field === 'subject' },
    threshold: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Subject threshold', group: 'Field', hint: 'Brightness that counts as "subject" when the picture has no transparency.', visibleIf: (p) => p.field === 'subject' },
    count: { type: 'number', default: 12, min: 1, max: 200, softMax: 60, step: 1, integer: true, label: 'Number of levels', group: 'Lines' },
    thickness: { type: 'number', default: 1.6, min: 0.3, max: 30, softMax: 10, step: 0.1, unit: 'px', label: 'Line thickness', group: 'Lines' },
    offset: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Level offset', group: 'Lines' },
    cycles: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Lines travel (per loop)', group: 'Lines', hint: 'Whole level spacings the lines move in one loop. 0 = still.' },
    wobble: { type: 'number', default: 0, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'Wobble', group: 'Wobble' },
    wobbleScale: { type: 'number', default: 60, min: 4, max: 600, step: 1, unit: 'px', label: 'Wobble size', group: 'Wobble', visibleIf: (p) => (p.wobble as number) > 0 },
    wobbleEvolution: { type: 'number', default: 0, min: 0, max: 8, step: 0.1, label: 'Wobble evolution per loop', group: 'Wobble', hint: '0 = frozen wobble.', visibleIf: (p) => (p.wobble as number) > 0 },
    colorMode: {
      type: 'enum',
      default: 'fixed',
      label: 'Line colour from',
      group: 'Colour',
      options: [
        { value: 'fixed', label: 'The colour below' },
        { value: 'source', label: 'The picture' },
      ],
    },
    lineColor: { type: 'color', default: [0.4, 1, 0.9, 1], label: 'Line colour', group: 'Colour', visibleIf: (p) => p.colorMode === 'fixed' },
    background: { type: 'color', default: [0, 0, 0, 1], label: 'Background', group: 'Colour' },
    imageAmount: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Show picture underneath', group: 'Colour' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Wobble', visibleIf: (p) => (p.wobble as number) > 0 },
  },
  summary: (p) => `${p.count} levels`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const animated = p.cycles !== 0 || (p.wobble > 0 && p.wobbleEvolution > 0);
    const phase = animated ? ctx.time.phase : 0;

    // 1. scalar field in .r
    const subject = p.field === 'subject';
    let field = gpu.pass({
      label: 'contour-field',
      size: src,
      textures: { src },
      uniforms: { subject, thr: p.threshold },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smp, uv, 0.0);
  var v = luma(s.rgb);
  if (u.subject > 0.5) {
    // transparency marks the subject; otherwise bright areas do
    v = select(select(0.0, 1.0, v > u.thr), s.a, s.a < 0.999);
  } else {
    v = v * 1.0;
  }
  return vec4f(v, v, v, 1.0);
}`,
    });
    field = gaussianBlur(gpu, field, subject ? p.spread : p.smoothing);

    // 2. levels, lines, colour
    const fromSource = p.colorMode === 'source';
    const image = gpu.pass({
      label: 'contour-lines',
      size: src,
      textures: { src, field },
      uniforms: {
        count: p.count,
        half: p.thickness / 2,
        offset: p.offset - (p.cycles !== 0 ? phase * Math.round(p.cycles) : 0),
        wob: p.wobble,
        wscale: p.wobbleScale,
        wphase: phase,
        wevo: p.wobbleEvolution,
        seed: p.seed * 13.37,
        color: p.lineColor,
        bg: p.background,
        under: p.imageAmount,
        subject,
      },
      wgsl: /* wgsl */ `
fn level(uv: vec2f, px: vec2f) -> f32 {
  var q = uv;
  if (u.wob > 0.0) {
    let np = px / u.wscale + vec2f(u.seed, u.seed * 0.7);
    let nx = loopNoise(np, u.wphase, u.wevo) - 0.5;
    let ny = loopNoise(np + vec2f(31.7, 17.3), u.wphase, u.wevo) - 0.5;
    q = uv + vec2f(nx, ny) * 2.0 * u.wob / u.size;
  }
  var v = textureSampleLevel(field, smp, q, 0.0).r;
  if (u.subject > 0.5) { v = 1.0 - v; }
  return v * u.count + u.offset;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smp, uv, 0.0);
  let v = level(uv, px);
  let vx = level(uv + vec2f(1.0 / u.size.x, 0.0), px + vec2f(1.0, 0.0)) - v;
  let vy = level(uv + vec2f(0.0, 1.0 / u.size.y), px + vec2f(0.0, 1.0)) - v;
  let rate = max(length(vec2f(vx, vy)), 0.0005);
  let f = fract(v);
  let dist = min(f, 1.0 - f) / rate;
  var cover = 1.0 - smoothstep(u.half - 0.5, u.half + 0.5, dist);
  cover = cover * smoothstep(0.0008, 0.004, rate);   // flat field: no lines
  let base = mix(vec4f(u.bg.rgb * u.bg.a, u.bg.a), s, u.under);
  ${fromSource ? 'let lc = unpremul(s).rgb; let la = cover * max(s.a, 0.0);' : 'let lc = u.color.rgb; let la = cover * u.color.a;'}
  return vec4f(lc * la + base.rgb * (1.0 - la), la + base.a * (1.0 - la));
}`,
    });
    return { image };
  },
});
