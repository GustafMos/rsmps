import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

export default defineNode({
  id: 'line-modulation',
  title: 'Scan Line Relief',
  category: 'filter',
  description:
    'Redraws the picture as a stack of lines, each pushed sideways off its straight path by the brightness (or an optional height image) beneath it: glowing scan-line portraits, ridge-line "terrain" plots, oscilloscope looks.',
  keywords: ['lines', 'ridgeline', 'unknown pleasures', 'scanline', 'oscilloscope', 'waveform', 'relief', 'displacement', 'contour', 'vector', 'joy division', 'raster', 'topographic'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    height: { type: 'image', label: 'Height (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    lineCount: { type: 'number', default: 64, min: 2, max: 1000, softMax: 300, step: 1, integer: true, label: 'Line count', group: 'Lines' },
    angle: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Line angle', group: 'Lines', hint: '0 = horizontal lines, 90 = vertical.' },
    thickness: { type: 'number', default: 1.6, min: 0.2, max: 40, softMax: 12, step: 0.1, unit: 'px', label: 'Line thickness', group: 'Lines' },
    amount: { type: 'number', default: 24, min: 0, max: 400, softMax: 150, step: 0.5, unit: 'px', label: 'Displacement', group: 'Lines', hint: 'How far a fully bright spot pushes a line.' },
    smoothing: { type: 'number', default: 2, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'Smooth the height', group: 'Lines' },
    contrast: { type: 'number', default: 1.6, min: 0, max: 4, step: 0.01, label: 'Height contrast', group: 'Lines' },
    invert: { type: 'bool', default: false, label: 'Dark pushes up', group: 'Lines' },
    modulate: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Brightness lights the lines', group: 'Lines', hint: 'Lines glow where the picture is bright and fade where it is dark, so the subject emerges from the lines.' },
    occlusion: { type: 'bool', default: false, label: 'Lines hide the ones behind', group: 'Lines', hint: 'Classic ridge-line plot: a raised line blocks the lines above it.' },
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
    lineColor: { type: 'color', default: [0.35, 1, 0.9, 1], label: 'Line colour', group: 'Colour', visibleIf: (p) => p.colorMode === 'fixed' },
    background: { type: 'color', default: [0, 0, 0, 1], label: 'Background', group: 'Colour', hint: 'Set alpha to 0 for a transparent background.' },
    glow: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.01, label: 'Glow', group: 'Glow' },
    glowRadius: { type: 'number', default: 4, min: 0.5, max: 60, softMax: 20, step: 0.5, unit: 'px', label: 'Glow size', group: 'Glow', visibleIf: (p) => (p.glow as number) > 0 },
  },
  summary: (p) => `${p.lineCount} lines · ${p.amount} px`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const rad = (p.angle * Math.PI) / 180;
    const d: [number, number] = [Math.cos(rad), Math.sin(rad)];
    const n: [number, number] = [-Math.sin(rad), Math.cos(rad)];
    const extent = Math.abs(src.width * n[0]) + Math.abs(src.height * n[1]);
    const spacing = extent / p.lineCount;
    const reach = p.amount + Math.max(p.thickness, p.glow > 0 ? p.glowRadius * 2.5 : 0);
    const window = Math.max(1, Math.min(24, Math.ceil(reach / spacing) + 1));

    // 1. height field: brightness (times alpha) of the height input or the picture, smoothed
    const hsrc = ctx.in.height ?? src;
    let height = gpu.pass({
      label: 'line-height',
      size: src,
      textures: { hsrc },
      uniforms: { contrast: p.contrast, invert: p.invert },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(hsrc, smp, uv, 0.0);
  var h = luma(s.rgb) * 1.0;
  if (u.invert > 0.5) { h = s.a - h; }
  h = clamp((h - 0.5) * u.contrast + 0.5, 0.0, 1.0) * s.a;
  return vec4f(h, h, h, 1.0);
}`,
    });
    height = gaussianBlur(gpu, height, p.smoothing);

    // 2. draw the lines (painter's algorithm, back to front)
    const fromSource = p.colorMode === 'source';
    const image = gpu.pass({
      label: 'line-draw',
      size: src,
      textures: { hgt: height, pic: src },
      uniforms: {
        ctr: [src.width / 2, src.height / 2],
        dirv: d,
        nrm: n,
        extent,
        spacing,
        lines: p.lineCount,
        window,
        amount: p.amount,
        half: p.thickness / 2,
        modul: p.modulate,
        glow: p.glow,
        gr: p.glowRadius,
        occlude: p.occlusion,
        color: p.lineColor,
        bg: p.background,
      },
      wgsl: /* wgsl */ `
fn uvAt(a: f32, b: f32) -> vec2f { return (u.ctr + a * u.dirv + b * u.nrm) / u.size; }
fn hAt(a: f32, b: f32) -> f32 { return textureSampleLevel(hgt, smp, uvAt(a, b), 0.0).r; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let rel = px - u.ctr;
  let a = dot(rel, u.dirv);
  let b = dot(rel, u.nrm);
  let ic = i32(floor((b + u.extent * 0.5) / u.spacing));
  let w = i32(u.window);
  let bgp = vec4f(u.bg.rgb * u.bg.a, u.bg.a);
  var acc = bgp;
  for (var i = ic - w; i <= ic + w; i++) {
    if (i < 0 || i >= i32(u.lines)) { continue; }
    let bi = (f32(i) + 0.5) * u.spacing - u.extent * 0.5;
    let h = hAt(a, bi);
    let slope = (hAt(a + 1.5, bi) - hAt(a - 1.5, bi)) / 3.0 * u.amount;
    let yi = bi - u.amount * h;
    let dv = b - yi;
    if (u.occlude > 0.5 && dv > 0.0) { acc = bgp; }
    let dist = abs(dv) / sqrt(1.0 + slope * slope);
    var cover = 1.0 - smoothstep(u.half - 0.5, u.half + 0.5, dist);
    cover = max(cover, 0.0);
    var light = cover;
    if (u.glow > 0.0) { light = light + u.glow * 0.55 * exp(-(dist * dist) / (2.0 * u.gr * u.gr)); }
    light = clamp(light * mix(1.0, clamp(h * 2.2 + 0.06, 0.0, 1.0), u.modul), 0.0, 1.0);
    if (light <= 0.002) { continue; }
    ${fromSource ? 'let sc = unpremul(textureSampleLevel(pic, smp, uvAt(a, bi), 0.0)); let col = sc.rgb * (0.35 + 0.65 * h * 1.0 + 0.2); let la = light * sc.a;' : 'let col = u.color.rgb; let la = light * u.color.a;'}
    acc = vec4f(col * la + acc.rgb * (1.0 - la), la + acc.a * (1.0 - la));
  }
  return vec4f(clamp(acc.rgb, vec3f(0.0), vec3f(1.0)), clamp(acc.a, 0.0, 1.0));
}`,
    });
    return { image };
  },
});
