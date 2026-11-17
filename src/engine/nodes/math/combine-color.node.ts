import { defineNode } from '../../define';

export default defineNode({
  id: 'combine-color',
  title: 'Combine Color',
  category: 'math',
  description: 'Build a color from red, green, blue and alpha numbers (0..1).',
  keywords: ['rgb', 'make color', 'colour', 'compose', 'join'],
  inputs: {},
  outputs: { color: { type: 'color', label: 'Color' } },
  params: {
    r: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Red' },
    g: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Green' },
    b: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Blue' },
    a: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Alpha' },
  },
  summary: (p) => `${p.r.toFixed(2)}, ${p.g.toFixed(2)}, ${p.b.toFixed(2)}, ${p.a.toFixed(2)}`,
  render(ctx) {
    const p = ctx.params;
    return { color: [p.r, p.g, p.b, p.a] };
  },
});
