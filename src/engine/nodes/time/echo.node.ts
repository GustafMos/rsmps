import { defineNode } from '../../define';
import { blendImages, wrapSeconds } from '../../lib/util-time';
import type { ImageValue } from '../../types';

export default defineNode({
  id: 'echo',
  title: 'Frame Echo',
  category: 'time',
  description: 'Plain frame echoes: blends the current frame with earlier frames, each one fainter than the last, with no movement or recoloring. In a looping project the trail wraps around so the loop stays seamless. For echoes that drift, zoom or turn, see Warped Echo; for endless recursion, see Feedback.',
  keywords: ['trail', 'ghost', 'afterimage', 'feedback', 'motion trail', 'smear', 'persistence', 'echo', 'trails', 'onion'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    count: { type: 'number', default: 4, min: 0, max: 16, step: 1, integer: true, label: 'Number of echoes' },
    spacing: { type: 'number', default: 0.1, min: 0.01, max: 5, step: 0.01, unit: 's', label: 'Echo spacing' },
    decay: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Fade per echo', hint: '0.6 = each echo is 60% as strong as the one before.' },
    style: {
      type: 'enum',
      default: 'average',
      options: [
        { value: 'average', label: 'Smear' },
        { value: 'lighten', label: 'Glow' },
      ],
      label: 'Trail style',
    },
  },
  summary: (p) => `${p.count} × ${p.spacing}s · fade ${p.decay}`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (p.count <= 0 || p.decay <= 0) return { image: src };
    const { fps, duration, loop } = ctx.time;
    const now = ctx.time.seconds;
    const images: ImageValue[] = [src];
    const weights = [1];
    for (let i = 1; i <= p.count; i++) {
      const target = now - i * p.spacing;
      const seconds = loop ? wrapSeconds(target, duration, fps) : Math.max(0, target);
      const past = await ctx.pull('image', { seconds });
      if (!past) continue;
      images.push(past);
      weights.push(Math.pow(p.decay, i));
    }
    if (images.length === 1) return { image: src };
    return { image: blendImages(ctx.gpu, images, weights, p.style as 'average' | 'lighten') };
  },
});
