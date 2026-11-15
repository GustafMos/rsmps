import { defineNode } from '../../define';
import { cutoutImage } from './cutout.node';
import { inpaintImage } from './inpaint.node';

/**
 * One node for the common parallax prep: image + subject mask → the subject on its own (`foreground`) and the scene
 * with the subject removed and filled from the surrounding edge pixels (`background`). Both outputs are produced by
 * the same helpers the `cutout` and `inpaint` nodes use.
 */
export default defineNode({
  id: 'split-layers',
  title: 'Split Layers',
  category: 'composite',
  description:
    'Splits an image into a foreground cutout and a background with the subject removed and filled in, ready for the Parallax node.',
  keywords: ['parallax', 'separate', 'foreground', 'background', 'layers', 'cut out', 'subject'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    mask: { type: 'mask', required: true, label: 'Subject mask' },
  },
  outputs: {
    foreground: { type: 'image', label: 'Foreground' },
    background: { type: 'image', label: 'Background' },
  },
  params: {
    shrink: { type: 'number', default: 0.5, min: 0, max: 50, step: 0.25, unit: 'px', label: 'Shrink foreground edge' },
    feather: { type: 'number', default: 0.75, min: 0, max: 50, step: 0.25, unit: 'px', label: 'Feather foreground' },
    decontaminate: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Decontaminate edge' },
    grow: { type: 'number', default: 4, min: 0, max: 200, step: 0.5, unit: 'px', label: 'Grow hole', hint: 'How far past the mask the background fill starts, so the subject halo is not smeared in.' },
    smoothness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Fill smoothness' },
    texture: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Fill texture' },
  },
  summary: () => 'foreground + filled background',
  render(ctx) {
    const { image, mask } = ctx.in;
    const p = ctx.params;
    return {
      foreground: cutoutImage(ctx.gpu, image, mask, { shrink: p.shrink, feather: p.feather, decontaminate: p.decontaminate }),
      background: inpaintImage(ctx.gpu, image, mask, { grow: p.grow, feather: 1.5, smoothness: p.smoothness, texture: p.texture }),
    };
  },
});
