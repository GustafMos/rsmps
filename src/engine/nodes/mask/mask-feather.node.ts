import { defineNode } from '../../define';
import { blurMask } from '../../lib/mask-util';

export default defineNode({
  id: 'mask-feather',
  title: 'Feather Mask',
  category: 'mask',
  description: 'Softens the edge of a mask with a gaussian blur.',
  keywords: ['blur', 'soften', 'smooth', 'edge'],
  inputs: { mask: { type: 'mask', required: true, label: 'Mask' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    radius: { type: 'number', default: 8, min: 0, max: 400, step: 0.5, unit: 'px', label: 'Radius' },
  },
  summary: (p) => `${p.radius} px`,
  render(ctx) {
    return { mask: blurMask(ctx.gpu, ctx.in.mask, ctx.params.radius) };
  },
});
