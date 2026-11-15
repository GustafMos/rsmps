import { defineNode } from '../../define';

export default defineNode({
  id: 'separate-color',
  title: 'Separate Color',
  category: 'math',
  description: 'Split a colour into red, green, blue and alpha numbers (0..1).',
  keywords: ['rgb', 'split', 'channels', 'break', 'extract'],
  inputs: { color: { type: 'color', required: true, label: 'Color' } },
  outputs: {
    r: { type: 'number', label: 'Red' },
    g: { type: 'number', label: 'Green' },
    b: { type: 'number', label: 'Blue' },
    a: { type: 'number', label: 'Alpha' },
  },
  params: {},
  summary: () => 'R · G · B · A',
  render(ctx) {
    const [r, g, b, a] = ctx.in.color;
    return { r, g, b, a };
  },
});
