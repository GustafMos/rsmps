import { defineNode } from '../../define';
import { growMask, morphSquare } from '../../lib/mask-util';

export default defineNode({
  id: 'mask-grow',
  title: 'Grow / Shrink Mask',
  category: 'mask',
  description: 'Expands (positive) or contracts (negative) a mask by a number of pixels. Round shape is an exact distance transform.',
  keywords: ['dilate', 'erode', 'expand', 'contract', 'choke', 'spread'],
  inputs: { mask: { type: 'mask', required: true, label: 'Mask' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    amount: { type: 'number', default: 4, min: -300, max: 300, step: 0.5, unit: 'px', label: 'Amount', hint: 'Positive grows, negative shrinks.' },
    shape: {
      type: 'enum',
      default: 'round',
      options: [
        { value: 'round', label: 'Round' },
        { value: 'square', label: 'Square' },
      ],
      label: 'Shape',
    },
  },
  summary: (p) => `${p.amount > 0 ? '+' : ''}${p.amount} px`,
  render(ctx) {
    const { mask } = ctx.in;
    const a = ctx.params.amount;
    if (Math.abs(a) < 0.01) return { mask };
    if (ctx.params.shape === 'square' && Math.abs(a) <= 48) return { mask: morphSquare(ctx.gpu, mask, Math.abs(a), a > 0) };
    return { mask: growMask(ctx.gpu, mask, a) };
  },
});
