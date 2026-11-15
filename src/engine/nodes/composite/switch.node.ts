import { defineNode } from '../../define';
import { mod } from '../../lib/util-time';

export default defineNode({
  id: 'switch',
  title: 'Switch',
  category: 'composite',
  description: 'Pick one of several images by number. The index wraps around, so it pairs well with Batch Item or Time numbers.',
  keywords: ['select', 'choose', 'pick', 'index', 'cycle', 'sequence'],
  inputs: { images: { type: 'image', multi: true, label: 'Images' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    index: { type: 'number', default: 0, min: -100000, max: 100000, step: 1, integer: true, label: 'Index', hint: '0 = first wire. Past the last one it wraps back to the first; negative counts from the end.' },
  },
  summary: (p) => `#${p.index}`,
  render(ctx) {
    const list = ctx.in.images;
    if (!list.length) return { image: null };
    return { image: list[mod(ctx.params.index, list.length)] };
  },
});
