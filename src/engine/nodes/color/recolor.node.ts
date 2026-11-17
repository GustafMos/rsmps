import { defineNode } from '../../define';

const MODES = { fill: 0, ink: 1, swap: 2, duotone: 3 } as const;

export default defineNode({
  id: 'recolor',
  title: 'Recolor',
  category: 'color',
  description:
    'Replaces colors outright. Fill turns everything into one color and keeps the shape (a black logo becomes white). Ink is for artwork without transparency: it treats the paper color as background and recolours the ink. Swap replaces one picked color by another. Duotone maps dark to one color and light to another.',
  keywords: ['recolor', 'recolour', 'colorize', 'fill', 'logo', 'white', 'black', 'replace color', 'replace color', 'silhouette', 'tint', 'swap', 'invert logo', 'one color', 'duotone', 'paper', 'knockout', 'key'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'fill',
      label: 'Mode',
      options: [
        { value: 'fill', label: 'Fill' },
        { value: 'ink', label: 'Ink on paper' },
        { value: 'swap', label: 'Swap color' },
        { value: 'duotone', label: 'Duotone' },
      ],
    },
    color: { type: 'color', default: [1, 1, 1, 1], label: 'Color', hint: 'Every pixel takes this color; the picture’s own transparency is kept.', visibleIf: (p) => p.mode === 'fill' },
    ink: { type: 'color', default: [1, 1, 1, 1], label: 'Ink becomes', hint: 'The color the drawn parts (everything that is not paper) are painted with.', visibleIf: (p) => p.mode === 'ink' },
    paper: { type: 'color', default: [1, 1, 1, 1], label: 'Paper color', hint: 'The background color of the artwork (usually white).', visibleIf: (p) => p.mode === 'ink' },
    transparentPaper: { type: 'bool', default: true, label: 'Clear paper', hint: 'The paper becomes transparent.', visibleIf: (p) => p.mode === 'ink' },
    paperFill: { type: 'color', default: [0, 0, 0, 1], label: 'Paper becomes', visibleIf: (p) => p.mode === 'ink' && p.transparentPaper === false },
    paperTolerance: { type: 'number', default: 0.05, min: 0, max: 1, step: 0.01, label: 'Paper tolerance', hint: 'How far from the paper color still counts as pure paper (0..1).', visibleIf: (p) => p.mode === 'ink' },
    paperSoftness: { type: 'number', default: 0.9, min: 0.01, max: 1, step: 0.01, label: 'Edge softness', hint: 'Width of the ramp from paper to ink. High keeps anti-aliased edges smooth; low makes a hard cut-out.', visibleIf: (p) => p.mode === 'ink' },
    from: { type: 'color', default: [0, 0, 0, 1], label: 'Replace this color', visibleIf: (p) => p.mode === 'swap' },
    to: { type: 'color', default: [1, 1, 1, 1], label: 'With this color', visibleIf: (p) => p.mode === 'swap' },
    tolerance: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Tolerance', hint: 'How different from the picked color a pixel may be and still be replaced fully.', visibleIf: (p) => p.mode === 'swap' },
    softness: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Softness', hint: 'Extra range over which the replacement fades out.', visibleIf: (p) => p.mode === 'swap' },
    dark: { type: 'color', default: [0.05, 0.05, 0.2, 1], label: 'Dark becomes', visibleIf: (p) => p.mode === 'duotone' },
    light: { type: 'color', default: [1, 0.9, 0.7, 1], label: 'Light becomes', visibleIf: (p) => p.mode === 'duotone' },
  },
  summary: (p) => (p.mode === 'fill' ? 'fill one color' : p.mode === 'ink' ? `ink on paper${p.transparentPaper ? ' · transparent' : ''}` : p.mode === 'swap' ? 'swap a color' : 'duotone'),
  render(ctx) {
    const p = ctx.params;
    const image = ctx.gpu.pass({
      label: 'recolor',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: {
        mode: MODES[p.mode as keyof typeof MODES] ?? 0,
        fillCol: p.color,
        inkCol: p.ink,
        paperCol: p.paper,
        paperOut: p.paperFill,
        cutout: p.transparentPaper,
        pTol: p.paperTolerance,
        pSoft: p.paperSoftness,
        fromCol: p.from,
        toCol: p.to,
        tol: p.tolerance,
        soft: p.softness,
        darkCol: p.dark,
        lightCol: p.light,
      },
      wgsl: /* wgsl */ `
// distance between two sRGB colours, 0 (same) .. 1 (black vs white)
fn colDist(a: vec3f, b: vec3f) -> f32 { return distance(a, b) * 0.57735027; }

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let m = i32(u.mode + 0.5);
  if (m == 0) {
    return premul(vec4f(u.fillCol.rgb, s.a * u.fillCol.a));
  }
  if (m == 1) {
    // how far this pixel is from the paper = how much ink there is
    let k = saturate1((colDist(s.rgb, u.paperCol.rgb) - u.pTol) / max(u.pSoft, 0.0001));
    if (u.cutout > 0.5) { return premul(vec4f(u.inkCol.rgb, s.a * k * u.inkCol.a)); }
    return premul(vec4f(mix(u.paperOut.rgb, u.inkCol.rgb, k), s.a));
  }
  if (m == 2) {
    let w = 1.0 - smoothstep(u.tol, u.tol + max(u.soft, 0.0001), colDist(s.rgb, u.fromCol.rgb));
    return premul(vec4f(mix(s.rgb, u.toCol.rgb, w), s.a));
  }
  let l = saturate1(luma(s.rgb));
  return premul(vec4f(mix(u.darkCol.rgb, u.lightCol.rgb, l), s.a));
}`,
    });
    return { image };
  },
});
