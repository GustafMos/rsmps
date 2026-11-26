import { defineNode } from '../../define';

export default defineNode({
  id: 'separate-xyz',
  title: 'Separate XYZ',
  category: 'math',
  description: 'Split a vector wire into its three numbers.',
  keywords: ['vector', 'xyz', 'split', 'unbundle', 'break', 'extract', 'unpack', 'component'],
  inputs: { vector: { type: 'vector', required: true, label: 'Vector' } },
  outputs: {
    x: { type: 'number', label: 'X' },
    y: { type: 'number', label: 'Y' },
    z: { type: 'number', label: 'Z' },
  },
  params: {},
  summary: () => 'X · Y · Z',
  render(ctx) {
    const [x, y, z] = ctx.in.vector;
    return { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
  },
});
