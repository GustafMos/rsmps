import { defineNode } from '../../define';
import { sdfCombine, sdfJoin, sdfValue } from '../../lib/sdf-scene';

/**
 * SDF Combine: joins the shapes on its input into one. Union adds them together, Subtract cuts every later shape out of the first one,
 * Intersect keeps only where all of them overlap. Smoothness blends the join (0 = hard edge); colours blend the same way.
 * The order of the wires matters for Subtract. The result is again an `sdf`, so it can be combined further.
 */
export default defineNode({
  id: 'sdf-combine',
  title: 'SDF Combine',
  category: 'sdf',
  description: 'Joins shapes: Union adds them, Subtract cuts every later shape out of the first one, Intersect keeps only the overlap. Smoothness rounds the join and blends the colors.',
  keywords: ['sdf', 'union', 'subtract', 'intersect', 'boolean', 'smooth union', 'merge', 'cut', 'blend', 'metaball', 'model'],
  inputs: { items: { type: 'sdf', multi: true, label: 'Shapes', firstNote: 'base' } },
  outputs: { sdf: { type: 'sdf', label: 'Combined' } },
  params: {
    operation: {
      type: 'enum',
      default: 'union',
      label: 'Operation',
      hint: 'Subtract cuts shapes 2 and up out of shape 1 (the base). Union and Intersect ignore the order.',
      options: [
        { value: 'union', label: 'Union' },
        { value: 'subtract', label: 'Subtract' },
        { value: 'intersect', label: 'Intersect' },
      ],
    },
    smoothness: { type: 'number', default: 0, min: 0, max: 3, step: 0.01, label: 'Smoothness', hint: 'Blend radius of the join. 0 = hard edge. Colors blend too.' },
  },
  titleSuffix: (p) => (p.operation === 'subtract' ? 'Subtract' : p.operation === 'intersect' ? 'Intersect' : 'Union'),
  summary: (p) => `${p.operation}${p.smoothness > 0 ? ` · smooth ${p.smoothness}` : ''}`,
  render(ctx) {
    const { roots, picture } = sdfJoin(ctx.in.items ?? []);
    if (!roots.length) return { sdf: sdfValue(null) };
    const op = ctx.params.operation as 'union' | 'subtract' | 'intersect';
    return { sdf: sdfValue(sdfCombine(ctx.path, op, roots, ctx.params.smoothness as number), picture) };
  },
});
