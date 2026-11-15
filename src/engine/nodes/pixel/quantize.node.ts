import { defineNode } from '../../define';
import type { DitherSpace } from '../../lib/pixel-color';
import { PALETTE_WGSL, SPACE_INDEX, SPACE_OPTIONS, clampPalette, paletteTexture } from '../../lib/pixel-gpu';
import { FALLBACK_PARAM, paletteSummary, resolvePalette } from '../../lib/pixel-palettes';

/** Snap every pixel to its nearest palette colour. The palette arrives on a wire. */
export default defineNode({
  id: 'quantize',
  title: 'Quantize',
  category: 'pixel',
  description: 'Replaces every colour with the nearest colour of the wired palette. No dithering: hard, clean colour steps.',
  keywords: ['palette', 'posterize', 'reduce colors', 'snap', 'indexed'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    palette: { type: 'palette', label: 'Palette' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    fallback: FALLBACK_PARAM,
    colorSpace: { type: 'enum', default: 'oklab', options: SPACE_OPTIONS, label: 'Match in' },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', hint: '0 keeps the original colours, 1 snaps fully to the palette.' },
  },
  summary: (p) => `${p.colorSpace === 'oklab' ? 'OKLab' : p.colorSpace === 'linear' ? 'Linear' : 'RGB'} · ${Math.round(p.strength * 100)}% · ${paletteSummary(false, p.fallback)}`,
  render(ctx) {
    const src = ctx.in.image;
    const colors = clampPalette(resolvePalette(ctx.in.palette, ctx.params.fallback));
    if (colors.length === 0) return { image: src };
    const space = ctx.params.colorSpace as DitherSpace;
    const image = ctx.gpu.pass({
      label: 'quantize',
      size: src,
      textures: { src, pal: paletteTexture(ctx.gpu, colors, space) },
      uniforms: { palCount: colors.length, colorSpace: SPACE_INDEX[space], strength: ctx.params.strength },
      wgsl: /* wgsl */ `
${PALETTE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  if (s.a <= 0.0001) { return s; }
  let c = s.rgb / s.a;
  let q = palSrgb(nearestIdx(toSpace(c)));
  return premul(vec4f(mix(c, q, u.strength), s.a));
}`,
    });
    return { image };
  },
});
