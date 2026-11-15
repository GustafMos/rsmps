import { defineNode } from '../../define';
import { GEN_PALETTE_WGSL, genPaletteTexture } from '../../lib/gen-common';

const KINDS = { linear: 0, radial: 1, angular: 2, diamond: 3 } as const;
const REPEATS = { clamp: 0, repeat: 1, mirror: 2 } as const;

export default defineNode({
  id: 'gradient',
  title: 'Gradient',
  category: 'generate',
  description: 'Linear, radial, angular or diamond gradient through any number of colour stops. Can scroll or rotate in a perfect loop.',
  keywords: ['ramp', 'blend', 'sweep', 'conic', 'colour', 'color', 'background'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    kind: {
      type: 'enum',
      default: 'linear',
      label: 'Type',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'radial', label: 'Radial' },
        { value: 'angular', label: 'Angular (sweep)' },
        { value: 'diamond', label: 'Diamond' },
      ],
    },
    colors: {
      type: 'palette',
      label: 'Colour stops',
      hint: 'Stops are spaced evenly from start to end.',
      default: [
        [0.09, 0.1, 0.35],
        [0.75, 0.25, 0.55],
        [1, 0.8, 0.3],
      ],
    },
    angle: { type: 'number', default: 90, min: -360, max: 360, step: 1, unit: 'deg', label: 'Angle', hint: '0 = left to right, 90 = top to bottom.' },
    center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -1, max: 2, step: 0.01, label: 'Center' },
    scale: { type: 'number', default: 1, min: 0.05, max: 8, step: 0.01, unit: 'norm', label: 'Scale', hint: '1 = the gradient spans the whole frame.' },
    repeat: {
      type: 'enum',
      default: 'clamp',
      label: 'Beyond the ends',
      options: [
        { value: 'clamp', label: 'Hold end colours' },
        { value: 'repeat', label: 'Repeat' },
        { value: 'mirror', label: 'Mirror' },
      ],
    },
    animate: {
      type: 'enum',
      default: 'none',
      label: 'Animation',
      options: [
        { value: 'none', label: 'Still' },
        { value: 'scroll', label: 'Scroll' },
        { value: 'rotate', label: 'Rotate' },
      ],
    },
    cycles: {
      type: 'number',
      default: 1,
      min: -16,
      max: 16,
      step: 1,
      integer: true,
      unit: 'cycles',
      label: 'Cycles per loop',
      hint: 'Whole turns / repeats per loop, so it loops exactly. Negative runs backwards.',
      visibleIf: (p) => p.animate !== 'none',
    },
  },
  summary: (p) => `${p.kind} · ${p.colors.length} stops${p.animate !== 'none' ? ` · ${p.animate} x${p.cycles}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const animated = p.animate !== 'none' && p.cycles !== 0;
    const phase = animated ? ctx.time.phase : 0;
    const pal = genPaletteTexture(ctx.gpu, p.colors);
    const image = ctx.gpu.pass({
      label: 'gradient',
      size,
      textures: { pal: pal.texture },
      uniforms: {
        palN: pal.count,
        kind: KINDS[p.kind as keyof typeof KINDS] ?? 0,
        rep: REPEATS[p.repeat as keyof typeof REPEATS] ?? 0,
        // rotate: whole turns per loop; scroll: whole gradient lengths per loop
        angle: p.angle + (p.animate === 'rotate' ? phase * 360 * p.cycles : 0),
        scroll: p.animate === 'scroll' ? phase * p.cycles : 0,
        center: p.center,
        scale: Math.max(0.01, p.scale),
      },
      wgsl: /* wgsl */ `
${GEN_PALETTE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = radians(u.angle);
  let d = vec2f(cos(a), sin(a));
  let p = px - u.center * u.size;
  var t = 0.0;
  let kind = i32(u.kind);
  if (kind == 0) {
    let extent = max(abs(u.size.x * d.x) + abs(u.size.y * d.y), 1.0) * u.scale;
    t = dot(p, d) / extent + 0.5;
  } else if (kind == 1) {
    t = length(p) / (u.scale * 0.5 * length(u.size));
  } else if (kind == 2) {
    t = fract((atan2(p.y, p.x) - a) / TAU);
  } else {
    let q = vec2f(dot(p, d), dot(p, vec2f(-d.y, d.x)));
    t = (abs(q.x) + abs(q.y)) / (u.scale * 0.5 * (u.size.x + u.size.y));
  }
  var rep = i32(u.rep);
  // scrolling a clamped ramp could never loop, so it wraps instead
  if ((u.scroll != 0.0 || kind == 2) && rep == 0) { rep = 1; }
  if (rep == 2) {
    let s = u.scroll * 2.0; // mirror has period 2
    t = 1.0 - abs(1.0 - (((t - s) % 2.0) + 2.0) % 2.0);
  } else if (rep == 1) {
    t = fract(t - u.scroll);
  } else {
    t = clamp(t, 0.0, 1.0);
  }
  return premul(vec4f(palAt(t), 1.0));
}`,
    });
    return { image };
  },
});
