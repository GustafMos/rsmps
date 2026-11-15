import { defineNode } from '../../define';
import { wrapSeconds } from '../../lib/util-time';

export default defineNode({
  id: 'time-offset',
  title: 'Time Offset',
  category: 'time',
  description: 'Shift footage earlier or later in time. With Wrap on, what falls off one end comes back on the other so a loop stays a loop.',
  keywords: ['delay', 'shift', 'slip', 'advance', 'lag', 'offset', 'stagger'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    offset: { type: 'number', default: 0.5, min: -600, max: 600, step: 0.05, unit: 's', label: 'Offset', hint: 'Positive shows footage from later on (the animation runs ahead); negative delays it.' },
    wrap: { type: 'bool', default: true, label: 'Wrap around the loop' },
  },
  summary: (p) => `${p.offset > 0 ? '+' : ''}${p.offset}s${p.wrap ? ' · wrap' : ''}`,
  async render(ctx) {
    const p = ctx.params;
    if (p.offset === 0) return { image: ctx.in.image };
    const target = ctx.time.seconds + p.offset;
    const seconds = p.wrap ? wrapSeconds(target, ctx.time.duration, ctx.time.fps) : Math.max(0, target);
    return { image: await ctx.pull('image', { seconds }) };
  },
});
