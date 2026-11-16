import { defineNode } from '../../define';
import { withArtGrid } from '../../lib/art-grid';
import type { DitherSpace } from '../../lib/pixel-color';
import { PALETTE_WGSL, SPACE_INDEX, clampPalette, paletteTexture } from '../../lib/pixel-gpu';

/**
 * Recolour by index: every pixel is matched to the nearest colour of `From`, then replaced by the colour at
 * the same position in `To`. If `To` is shorter, the last colour is reused.
 */
export default defineNode({
  id: 'palette-swap',
  title: 'Palette Swap',
  category: 'pixel',
  description: 'Remaps an image from one palette to another by colour index. Handy for sprite recolours and day/night variants.',
  keywords: ['recolor', 'remap', 'index', 'sprite', 'variant'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    from: { type: 'palette', required: true, label: 'From' },
    to: { type: 'palette', required: true, label: 'To' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    colorSpace: {
      type: 'enum',
      default: 'oklab',
      label: 'Match in',
      options: [
        { value: 'oklab', label: 'OKLab (perceptual)' },
        { value: 'linear', label: 'Linear RGB' },
        { value: 'srgb', label: 'RGB (sRGB)' },
      ],
    },
    tolerance: {
      type: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Tolerance',
      hint: 'Pixels farther than this from every "From" colour are left alone. 1 remaps everything.',
    },
  },
  render(ctx) {
    const input = ctx.in.image;
    const from = clampPalette(ctx.in.from.colors);
    const to = clampPalette(ctx.in.to.colors);
    if (from.length === 0 || to.length === 0) return { image: input };
    const space = ctx.params.colorSpace as DitherSpace;
    // The "to" colours reuse the palette texture layout; only row 0 (sRGB) is read from it.
    const image = withArtGrid(ctx.gpu, input, 0, (src) => ctx.gpu.pass({
      label: 'palette-swap',
      size: src,
      textures: { src, pal: paletteTexture(ctx.gpu, from, space), dst: paletteTexture(ctx.gpu, to, space) },
      uniforms: { palCount: from.length, toCount: to.length, colorSpace: SPACE_INDEX[space], tol: ctx.params.tolerance },
      wgsl: /* wgsl */ `
${PALETTE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  if (s.a <= 0.0001) { return s; }
  let c = s.rgb / s.a;
  let t = toSpace(c);
  let i = nearestIdx(t);
  var out = c;
  // Lab distances are ~0..1.5; the tolerance slider covers that range.
  if (u.tol >= 0.999 || sqrt(spaceDist(t, palSpace(i))) <= u.tol) {
    out = textureLoad(dst, vec2i(min(i, i32(u.toCount) - 1), 0), 0).rgb;
  }
  return premul(vec4f(out, s.a));
}`,
    }));
    return { image };
  },
});
