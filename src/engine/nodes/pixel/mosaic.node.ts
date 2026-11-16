import { defineNode } from '../../define';
import { withArtGrid } from '../../lib/art-grid';

/** Flat blocks painted on the full-resolution image (no art grid, size unchanged). For a real art-resolution image, or a masked art grid that Dither can follow, use Pixelate. */
export default defineNode({
  id: 'mosaic',
  title: 'Mosaic',
  category: 'pixel',
  description: 'Paints flat blocks on the image and keeps its size and resolution (no art grid; use Pixelate for a real low-resolution pixel-art image). Each block becomes one flat colour.',
  keywords: ['pixelate', 'blocks', 'tiles', 'censor'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    block: { type: 'number', default: 8, min: 1, max: 256, step: 1, unit: 'px', label: 'Block size', hint: 'Scales with the media; rounded to whole texels, minimum 1.' },
    mode: {
      type: 'enum',
      default: 'average',
      label: 'Colour',
      options: [
        { value: 'average', label: 'Average of block' },
        { value: 'center', label: 'Centre sample' },
      ],
    },
  },
  summary: (p) => `${p.block} px`,
  render(ctx) {
    const input = ctx.in.image;
    // A block is a whole number of texels, never smaller than one (coarse render grids give sub-texel lengths).
    const image = withArtGrid(ctx.gpu, input, 0, (src, grid) => {
      const block = Math.max(1, Math.round(grid.toArt(ctx.params.block)));
      return ctx.gpu.pass({
      label: 'mosaic',
      size: src,
      textures: { src },
      uniforms: { block, center: ctx.params.mode === 'center' },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let cell = floor(px / u.block);
  let lo = cell * u.block;
  let hi = min(lo + vec2f(u.block), dims);
  if (u.center > 0.5) {
    return textureSampleLevel(src, smp, (lo + hi) * 0.5 / dims, 0.0);
  }
  let n = i32(clamp(ceil(u.block), 1.0, 12.0));
  var acc = vec4f(0.0);
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      let p = lo + (vec2f(f32(i), f32(j)) + 0.5) / f32(n) * (hi - lo);
      acc += textureSampleLevel(src, smp, p / dims, 0.0);
    }
  }
  return acc / f32(n * n);
}`,
      });
    });
    return { image };
  },
});
