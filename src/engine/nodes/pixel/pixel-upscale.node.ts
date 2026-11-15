import { defineNode } from '../../define';

/** Integer nearest-neighbour enlarge: every pixel becomes an exact factor×factor block. */
export default defineNode({
  id: 'pixel-upscale',
  title: 'Pixel Upscale',
  category: 'pixel',
  description: 'Enlarges by a whole number with nearest-neighbour sampling, so pixel art stays perfectly crisp.',
  keywords: ['enlarge', 'scale', 'nearest', 'integer', 'zoom', 'export'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'factor',
      label: 'Mode',
      options: [
        { value: 'factor', label: 'Factor' },
        { value: 'fit-height', label: 'Fit to height' },
        { value: 'fit-width', label: 'Fit to width' },
      ],
    },
    factor: { type: 'number', default: 4, min: 1, max: 64, step: 1, integer: true, label: 'Factor', visibleIf: (p) => p.mode === 'factor' },
    target: {
      type: 'number',
      default: 1080,
      min: 1,
      max: 16384,
      step: 1,
      integer: true,
      label: 'Target size',
      hint: 'Uses the largest whole factor that does not exceed this many pixels.',
      visibleIf: (p) => p.mode !== 'factor',
    },
  },
  summary: (p) => (p.mode === 'factor' ? `×${p.factor}` : `fit ${p.target}`),
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    let k = p.factor;
    if (p.mode === 'fit-height') k = Math.floor(p.target / src.height);
    else if (p.mode === 'fit-width') k = Math.floor(p.target / src.width);
    k = Math.max(1, Math.min(k, Math.floor(8192 / Math.max(src.width, src.height)) || 1));
    if (k === 1) return { image: src };
    const image = ctx.gpu.pass({
      label: 'pixel-upscale',
      size: { width: src.width * k, height: src.height * k, unit: src.unit * k },
      textures: { src },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }',
    });
    return { image };
  },
});
