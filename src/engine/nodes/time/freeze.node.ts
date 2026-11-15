import { defineNode } from '../../define';

export default defineNode({
  id: 'freeze',
  title: 'Freeze Frame',
  category: 'time',
  description: 'Hold one moment of the footage for the whole project, like a still photo taken from a video or animation.',
  keywords: ['hold', 'still', 'pause', 'snapshot', 'stop', 'poster frame'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    at: { type: 'number', default: 0, min: 0, max: 36000, step: 0.05, unit: 's', label: 'Freeze at', hint: 'Time in seconds of the frame to hold.' },
  },
  summary: (p) => `hold ${p.at}s`,
  async render(ctx) {
    return { image: await ctx.pull('image', { seconds: ctx.params.at }) };
  },
});
