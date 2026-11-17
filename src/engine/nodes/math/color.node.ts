import { defineNode } from '../../define';

export default defineNode({
  id: 'color',
  title: 'Color',
  category: 'math',
  description: 'A single color you can wire into any color setting.',
  keywords: ['constant', 'swatch', 'colour', 'rgb'],
  inputs: {},
  outputs: { color: { type: 'color', label: 'Color' } },
  params: {
    color: { type: 'color', default: [1, 1, 1, 1], label: 'Color' },
  },
  summary: (p) => {
    const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
    return `#${hex(p.color[0])}${hex(p.color[1])}${hex(p.color[2])}${p.color[3] < 1 ? hex(p.color[3]) : ''}`;
  },
  render(ctx) {
    return { color: ctx.params.color };
  },
});
