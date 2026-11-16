import { defineNode } from '../../define';
import type { ImageValue } from '../../types';
import { gaussianBlur } from '../filter/blur.node';

export default defineNode({
  id: 'paper-clean',
  title: 'Paper Clean',
  category: 'color',
  description:
    'Cleans up a photo or scan of a drawing on paper: evens out shadows and uneven light, turns the paper white, removes colour casts and faint printed guides, and can output just the ink on a transparent background.',
  keywords: ['scan', 'paper', 'whiten', 'shadow removal', 'flatten', 'illumination', 'background', 'cleanup', 'photo of drawing', 'ink', 'transparent', 'guide', 'cast', 'white balance'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    paperRadius: { type: 'number', default: 40, min: 4, max: 600, softMax: 200, step: 1, unit: 'px', label: 'Paper estimate', group: 'Paper', hint: 'Larger than the thickest drawn shape. Smaller follows shadows more closely, but eats big filled areas.' },
    removeCast: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Remove color cast', group: 'Paper', hint: '1 = paper becomes neutral white, 0 = keep its tint.' },
    blackPoint: { type: 'number', default: 0.04, min: 0, max: 0.5, step: 0.005, label: 'Black point', group: 'Levels' },
    whitePoint: { type: 'number', default: 0.9, min: 0.5, max: 1, step: 0.005, label: 'White point', group: 'Levels', hint: 'Anything this bright or brighter becomes pure white, which wipes out paper noise.' },
    gamma: { type: 'number', default: 1, min: 0.3, max: 3, step: 0.01, label: 'Midtones', group: 'Levels' },
    guideSuppress: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.005, label: 'Fade faint guides', group: 'Guides', hint: 'Marks lighter than this (after cleaning) are erased: pale printed guide lines and grid.' },
    output: {
      type: 'enum',
      default: 'paper',
      label: 'Output',
      group: 'Output',
      options: [
        { value: 'paper', label: 'On white paper' },
        { value: 'ink', label: 'Ink only' },
      ],
    },
    inkThreshold: { type: 'number', default: 0.12, min: 0, max: 0.9, step: 0.005, label: 'Ink threshold', group: 'Output', visibleIf: (p) => p.output === 'ink' },
    inkSoftness: { type: 'number', default: 0.12, min: 0.005, max: 0.6, step: 0.005, label: 'Ink edge softness', group: 'Output', visibleIf: (p) => p.output === 'ink' },
  },
  summary: (p) => `${p.output === 'ink' ? 'ink only' : 'white paper'} · ${p.paperRadius} px`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;

    // 1. paper tone: a small copy, grey-level dilation (local maximum), then smoothing
    const down = Math.max(1, Math.ceil(p.paperRadius / 10));
    const lw = Math.max(4, Math.round(src.width / down));
    const lh = Math.max(4, Math.round(src.height / down));
    const low = { width: lw, height: lh, unit: src.unit / down };
    const reach = Math.max(1, Math.min(12, Math.round(p.paperRadius / down)));
    const small = gpu.pass({
      label: 'paper-small',
      size: low,
      format: 'rgba16float',
      textures: { src },
      uniforms: { step: down / 3 },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src));
  var acc = vec3f(0.0);
  for (var j = -1; j <= 1; j++) { for (var i = 0; i < 3; i++) {
    let s = textureSampleLevel(src, smp, uv + vec2f(f32(i - 1), f32(j)) * u.step * texel, 0.0);
    acc += s.rgb + vec3f(1.0 - s.a);
  } }
  return vec4f(acc / 9.0, 1.0);
}`,
    });
    const morph = (img: ImageValue, dir: [number, number], grow: boolean) =>
      gpu.pass({
        label: 'paper-morph',
        size: low,
        format: 'rgba16float',
        textures: { src: img },
        uniforms: { dir, reach, grow },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = u.dir / vec2f(textureDimensions(src));
  var m = textureSampleLevel(src, smpNearest, uv, 0.0).rgb;
  let n = i32(u.reach);
  for (var k = 1; k <= n; k++) {
    let a = textureSampleLevel(src, smpNearest, uv + texel * f32(k), 0.0).rgb;
    let b = textureSampleLevel(src, smpNearest, uv - texel * f32(k), 0.0).rgb;
    m = select(min(m, min(a, b)), max(m, max(a, b)), u.grow > 0.5);
  }
  return vec4f(m, 1.0);
}`,
      });
    let paper = morph(morph(morph(morph(small, [1, 0], true), [0, 1], true), [1, 0], false), [0, 1], false);
    paper = gaussianBlur(gpu, paper, Math.max(1, reach * 0.9));

    // 2. flatten, levels, guide suppression, output
    const ink = p.output === 'ink';
    const image = gpu.pass({
      label: 'paper-clean',
      size: src,
      textures: { src, paper },
      uniforms: {
        castAmt: p.removeCast,
        black: p.blackPoint,
        white: Math.max(p.whitePoint, p.blackPoint + 0.01),
        invGamma: 1 / p.gamma,
        guide: p.guideSuppress,
        thr: p.inkThreshold,
        soft: p.inkSoftness,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let pap = textureSampleLevel(paper, smp, uv, 0.0).rgb;
  let rgb0 = s.rgb + vec3f(1.0 - s.a);           // over white
  let papGrey = vec3f(luma(pap));
  let pv = srgbToLinear(clamp(mix(papGrey, pap, u.castAmt), vec3f(0.02), vec3f(1.0))) * 0.9;   // the estimate leans bright (noise, specks): aim a little under it
  var lin = srgbToLinear(clamp(rgb0, vec3f(0.0), vec3f(1.0))) / pv;
  var c = linearToSrgb(clamp(lin, vec3f(0.0), vec3f(1.0)));
  c = clamp((c - vec3f(u.black)) / (u.white - u.black), vec3f(0.0), vec3f(1.0));
  c = pow(c, vec3f(u.invGamma));
  if (u.guide > 0.0) {
    let d = 1.0 - luma(c);
    c = vec3f(1.0) - (vec3f(1.0) - c) * smoothstep(u.guide * 0.6, u.guide, d);
  }
  ${
    ink
      ? `let dark = 1.0 - min(c.r, min(c.g, c.b));
  let a = smoothstep(u.thr, u.thr + u.soft, dark);
  // c = a*ink + (1-a)*white  ->  premultiplied ink = c - (1-a)
  return vec4f(clamp(c - vec3f(1.0 - a), vec3f(0.0), vec3f(a)), a);`
      : 'return vec4f(c, 1.0);'
  }
}`,
    });
    return { image };
  },
});
