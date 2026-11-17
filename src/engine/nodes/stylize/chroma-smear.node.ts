import { defineNode } from '../../define';
import { paletteTexture } from '../../lib/fx-util';

export default defineNode({
  id: 'chroma-smear',
  title: 'Chroma Smear',
  category: 'stylize',
  description:
    'Color smear for a video-mixer look (not temporal feedback; for that see Feedback). Smears each color channel a different distance in a different direction, boosts saturation, recolors brightness bands through a palette and lets contours ripple outward: the look of a video mixer fed back into itself.',
  keywords: ['smear', 'feedback', 'glitch', 'psychedelic', 'rgb shift', 'streak', 'mixer', 'ripple', 'datamosh', 'color cycling', 'interference', 'vhs', 'video feedback color', 'video feedback color', 'color smear'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    smear: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Smear amount', group: 'Smear' },
    lengthR: { type: 'number', default: 90, min: 0, max: 800, softMax: 400, step: 1, unit: 'px', label: 'Red length', group: 'Smear', hint: 'Mean length of the exponential smear.' },
    lengthG: { type: 'number', default: 40, min: 0, max: 800, softMax: 400, step: 1, unit: 'px', label: 'Green length', group: 'Smear' },
    lengthB: { type: 'number', default: 130, min: 0, max: 800, softMax: 400, step: 1, unit: 'px', label: 'Blue length', group: 'Smear' },
    angleR: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Red direction', group: 'Smear' },
    angleG: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Green direction', group: 'Smear' },
    angleB: { type: 'number', default: 180, min: -180, max: 180, step: 1, unit: 'deg', label: 'Blue direction', group: 'Smear' },
    saturation: { type: 'number', default: 1.6, min: 0, max: 4, step: 0.01, label: 'Saturation boost', group: 'Color' },
    palette: {
      type: 'palette',
      default: [
        [0.05, 0.0, 0.25],
        [0.85, 0.05, 0.65],
        [0.1, 0.9, 0.45],
        [0.98, 0.9, 0.15],
        [1, 1, 1],
      ],
      label: 'Band colors',
      group: 'Color',
      hint: 'Dark to light. Brightness bands of the picture take these colors.',
    },
    paletteMix: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Palette mix', group: 'Color', hint: '0 = keep the picture colors, 1 = fully banded through the palette.' },
    bands: { type: 'number', default: 6, min: 2, max: 24, softMax: 16, step: 1, integer: true, label: 'Brightness bands', group: 'Color', visibleIf: (p) => (p.paletteMix as number) > 0 },
    hueCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Color cycling', group: 'Color', hint: 'Whole cycles of the palette per loop. 0 = still.', visibleIf: (p) => (p.paletteMix as number) > 0 },
    hueOffset: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Palette offset', group: 'Color', visibleIf: (p) => (p.paletteMix as number) > 0 },
    ripple: { type: 'number', default: 0, min: 0, max: 60, softMax: 30, step: 0.5, unit: 'px', label: 'Contour ripple', group: 'Ripple', hint: 'Each pass pushes the picture along its own brightness gradient.' },
    ripplePasses: { type: 'number', default: 3, min: 1, max: 8, softMax: 6, step: 1, integer: true, label: 'Ripple passes', group: 'Ripple', visibleIf: (p) => (p.ripple as number) > 0 },
    interference: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Interference lines', group: 'Interference' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Interference', visibleIf: (p) => (p.interference as number) > 0 },
  },
  summary: (p) => `smear ${Math.round(p.lengthR)}/${Math.round(p.lengthG)}/${Math.round(p.lengthB)} px`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const hasPalette = p.paletteMix > 0 && p.palette.length > 0;
    const phase = hasPalette && p.hueCycles > 0 ? ctx.time.phase * Math.round(p.hueCycles) : 0;
    let img = src;

    // 1. contour ripple: push the picture along its own gradient, a few times
    if (p.ripple > 0) {
      for (let i = 0; i < p.ripplePasses; i++) {
        img = gpu.pass({
          label: `ripple-${i}`,
          size: src,
          textures: { src: img },
          uniforms: { amt: p.ripple / Math.max(1, p.ripplePasses * 0.6), step: Math.max(1.5, p.ripple * 0.12) },
          wgsl: /* wgsl */ `
fn lum(uv: vec2f) -> f32 { let s = textureSampleLevel(src, smp, uv, 0.0); return luma(s.rgb); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = vec2f(u.step) / u.size;
  let g = vec2f(lum(uv + vec2f(t.x, 0.0)) - lum(uv - vec2f(t.x, 0.0)), lum(uv + vec2f(0.0, t.y)) - lum(uv - vec2f(0.0, t.y)));
  return textureSampleLevel(src, smp, uv - g * u.amt / u.size * 3.0, 0.0);
}`,
        });
      }
    }

    // 2. per-channel exponential smear (equal-weight taps at the quantiles of an exponential)
    const rad = (d: number) => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)];
    const smeared = p.smear > 0 && (p.lengthR > 0.5 || p.lengthG > 0.5 || p.lengthB > 0.5);
    if (smeared) {
      img = gpu.pass({
        label: 'chroma-smear',
        size: src,
        textures: { src: img },
        uniforms: {
          amount: p.smear,
          len: [p.lengthR, p.lengthG, p.lengthB],
          dr: rad(p.angleR),
          dg: rad(p.angleG),
          db: rad(p.angleB),
        },
        wgsl: /* wgsl */ `
fn chan(uv: vec2f, dir: vec2f, len: f32, ch: i32) -> vec2f {
  if (len < 0.5) { let s = textureSampleLevel(src, smpNearest, uv, 0.0); return vec2f(unpremul(s)[ch], s.a); }
  var acc = 0.0;
  var accA = 0.0;
  for (var j = 0; j < 28; j++) {
    let q = (f32(j) + 0.5) / 28.0 * 0.985;
    let d = -len * log(1.0 - q);
    let s = textureSampleLevel(src, smp, uv - dir * d / u.size, 0.0);
    acc += s[ch];
    accA += s.a;
  }
  return vec2f(select(0.0, acc / accA, accA > 0.0001), accA / 28.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let o = textureSampleLevel(src, smpNearest, uv, 0.0);
  let so = unpremul(o);
  let r = chan(uv, u.dr, u.len.x, 0);
  let g = chan(uv, u.dg, u.len.y, 1);
  let b = chan(uv, u.db, u.len.z, 2);
  let a = mix(so.a, max(r.y, max(g.y, b.y)), u.amount);
  return vec4f(mix(so.rgb, vec3f(r.x, g.x, b.x), u.amount), a);
}`,
      });
    }

    // 3. colour: saturation, brightness bands through the palette, interference lines
    const tex: Record<string, { texture: GPUTexture } | null> = { src: img };
    if (hasPalette) tex.pal = paletteTexture(gpu, p.palette);
    const image = gpu.pass({
      label: 'chroma-color',
      size: src,
      textures: tex as never,
      uniforms: {
        sat: p.saturation,
        mixp: hasPalette ? p.paletteMix : 0,
        bands: p.bands,
        n: Math.max(1, p.palette.length),
        shift: (p.hueOffset as number) + phase,
        inter: p.interference,
        seed: p.seed * 7.7,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s0 = textureSampleLevel(src, smpNearest, uv, 0.0);
  var c = ${smeared ? 's0.rgb' : 'unpremul(s0).rgb'};
  let l0 = luma(c);
  c = clamp(mix(vec3f(l0), c, u.sat), vec3f(0.0), vec3f(1.0));
  ${
    hasPalette
      ? `if (u.mixp > 0.0) {
    let l = clamp(luma(c), 0.0, 0.9999);
    let band = floor(l * u.bands);
    let t = fract(band / max(u.bands - 1.0, 1.0) + u.shift);
    let tt = select(t, min(band / max(u.bands - 1.0, 1.0) + u.shift, 0.9999), u.shift == 0.0);
    let pos = tt * f32(i32(u.n) - 1);
    let i0 = i32(floor(pos));
    let i1 = min(i0 + 1, i32(u.n) - 1);
    let pc = mix(textureLoad(pal, vec2i(i0, 0), 0).rgb, textureLoad(pal, vec2i(i1, 0), 0).rgb, pos - f32(i0));
    c = mix(c, clamp(pc * (0.55 + 0.9 * (l * u.bands - band)), vec3f(0.0), vec3f(1.0)), u.mixp);
  }`
      : ''
  }
  if (u.inter > 0.0) {
    let row = floor(px.y);
    let h = hash21(vec2f(row, u.seed));
    let band = 0.5 + 0.5 * sin(px.y * 0.35 + u.seed);
    c = c * (1.0 - u.inter * 0.25 * band);
    if (h > 0.93) {
      let h2 = hash21(vec2f(row + 31.0, u.seed));
      let start = hash21(vec2f(row, u.seed + 3.0)) * u.size.x * 0.7;
      let span = (0.1 + h2 * 0.5) * u.size.x;
      if (px.x > start && px.x < start + span) { c = mix(c, vec3f(0.9, 0.95, 1.0), u.inter * (0.35 + 0.5 * h2)); }
    }
    c = c * (1.0 - u.inter * 0.12 * hash21(vec2f(row, u.seed + 9.0)));
  }
  return premul(vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), s0.a));
}`,
    });
    return { image };
  },
});
