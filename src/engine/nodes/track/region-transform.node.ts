import { defineNode } from '../../define';
import { centerOf, clampBox, sizeOf, validRegions, type Box } from '../../lib/track-core';

export default defineNode({
  id: 'region-transform',
  title: 'Transform Regions',
  category: 'track',
  description: 'Grows, shrinks, moves and reshapes the boxes of regions: scale them, add padding, offset them, force an aspect ratio, and keep them inside the frame.',
  keywords: ['grow', 'shrink', 'expand', 'pad', 'offset', 'aspect', 'square', 'clamp', 'box', 'region'],
  guide: {
    does: 'Makes the region boxes bigger, smaller, moved or a different shape.',
    steps: [
      'Wire regions into Regions to change.',
      'Set Scale, padding or offset.',
      'Wire the result into the node that uses the boxes.',
    ],
    needs: [
      { input: 'regions', hint: 'The regions whose boxes you want to change.' },
    ],
    seeAlso: ['region-filter', 'region-fx'],
  },
  inputs: { regions: { type: 'regions', required: true, label: 'Regions to change' } },
  outputs: { regions: { type: 'regions', label: 'Regions' } },
  params: {
    scale: { type: 'number', default: 1, min: 0.05, max: 10, step: 0.01, label: 'Scale', hint: '1 keeps the size, 1.5 is half again as big.' },
    grow: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, unit: 'norm', label: 'Grow each side by', hint: 'Fraction of the frame width/height added to every side; negative shrinks.' },
    offset: { type: 'vec2', default: [0, 0], min: -1, max: 1, step: 0.005, unit: 'norm', label: 'Move by' },
    aspect: { type: 'number', default: 0, min: 0, max: 10, step: 0.01, label: 'Force aspect', hint: '0 = leave. 1 = square, 1.78 = 16:9. Measured in image pixels, not frame fractions.' },
    aspectMode: {
      type: 'enum',
      default: 'grow',
      options: [
        { value: 'grow', label: 'Grow to fit' },
        { value: 'shrink', label: 'Shrink to fit' },
      ],
      label: 'Aspect by',
    },
    clamp: { type: 'bool', default: true, label: 'Keep in frame' },
  },
  summary: (p) => `×${p.scale}${p.grow ? ` +${p.grow}` : ''}${p.aspect ? ` · ${p.aspect}:1` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const frameAspect = ctx.canvas.width / Math.max(1, ctx.canvas.height);
    const items = validRegions(ctx.in.regions.items).map((r) => {
      const [cx, cy] = centerOf(r.box);
      let [w, h] = sizeOf(r.box);
      w = w * p.scale + 2 * p.grow;
      h = h * p.scale + 2 * p.grow;
      w = Math.max(w, 0.001);
      h = Math.max(h, 0.001);
      if (p.aspect > 0) {
        // Aspect in image pixels: (w * frameAspect) / h.
        const cur = (w * frameAspect) / h;
        const widen = p.aspectMode === 'grow' ? cur < p.aspect : cur > p.aspect;
        if (widen) w = (p.aspect * h) / frameAspect;
        else h = (w * frameAspect) / p.aspect;
      }
      const ncx = cx + p.offset[0];
      const ncy = cy + p.offset[1];
      let box: Box = [ncx - w / 2, ncy - h / 2, ncx + w / 2, ncy + h / 2];
      if (p.clamp) box = clampBox(box);
      return { ...r, box };
    });
    return { regions: { kind: 'regions', items: p.clamp ? items.filter((r) => r.box[2] > r.box[0] && r.box[3] > r.box[1]) : items } };
  },
});
