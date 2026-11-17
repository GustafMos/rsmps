import { defineNode } from '../../define';
import { mixColors, type MixSpace } from '../../lib/util-color';

export default defineNode({
  id: 'mix-color',
  title: 'Mix Colors',
  category: 'math',
  description: 'Blend between two colors. Wire a number into Factor to fade over time.',
  keywords: ['blend', 'gradient', 'lerp', 'interpolate', 'colour', 'fade'],
  inputs: {},
  outputs: { color: { type: 'color', label: 'Color' } },
  params: {
    a: { type: 'color', default: [0, 0, 0, 1], label: 'Color A' },
    b: { type: 'color', default: [1, 1, 1, 1], label: 'Color B' },
    factor: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Factor', hint: '0 = A, 1 = B.' },
    space: {
      type: 'enum',
      default: 'oklab',
      options: [
        { value: 'oklab', label: 'Perceptual' },
        { value: 'srgb', label: 'Plain RGB' },
        { value: 'linear', label: 'Light-accurate' },
      ],
      label: 'Blend in',
    },
  },
  summary: (p) => `${Math.round(p.factor * 100)}% toward B`,
  render(ctx) {
    const p = ctx.params;
    return { color: mixColors(p.a, p.b, p.factor, p.space as MixSpace) };
  },
});
