import { defineNode } from '../../define';
import { blendImages, wrapSeconds } from '../../lib/util-time';
import type { ImageValue } from '../../types';

export default defineNode({
  id: 'frame-blend',
  title: 'Frame Blend',
  category: 'time',
  description: 'Motion-blur style smoothing: averages each frame with its neighbours in time. In a looping project the neighbours wrap around the loop.',
  keywords: ['motion blur', 'temporal', 'smooth', 'average', 'shutter', 'blur frames', 'interpolate'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    radius: { type: 'number', default: 2, min: 0, max: 8, step: 1, integer: true, label: 'Frames each side', hint: 'How many frames before and after are mixed in.' },
    shape: {
      type: 'enum',
      default: 'triangle',
      options: [
        { value: 'triangle', label: 'Centre-weighted' },
        { value: 'box', label: 'Even' },
      ],
      label: 'Weighting',
    },
  },
  summary: (p) => `±${p.radius} frames`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (p.radius <= 0) return { image: src };
    const { fps, duration, loop } = ctx.time;
    const now = ctx.time.seconds;
    const images: ImageValue[] = [src];
    const weights = [p.shape === 'box' ? 1 : p.radius + 1];
    for (let k = -p.radius; k <= p.radius; k++) {
      if (k === 0) continue;
      const target = now + k / fps;
      const seconds = loop ? wrapSeconds(target, duration, fps) : Math.max(0, target);
      const frame = await ctx.pull('image', { seconds });
      if (!frame) continue;
      images.push(frame);
      weights.push(p.shape === 'box' ? 1 : p.radius + 1 - Math.abs(k));
    }
    if (images.length === 1) return { image: src };
    return { image: blendImages(ctx.gpu, images, weights, 'average') };
  },
});
