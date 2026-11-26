import { defineNode } from '../../define';

const short = (n: number): string => String(Number(n.toFixed(2)));

export default defineNode({
  id: 'vector',
  title: 'Vector',
  category: 'math',
  description: 'Three numbers (X, Y, Z) on one wire: a position, a rotation, a scale. One wire into a vector socket sets all three settings at once.',
  keywords: ['xyz', 'vec3', 'constant', 'position', 'rotation', 'direction', 'point', 'three numbers', 'bundle'],
  inputs: {},
  outputs: { vector: { type: 'vector', label: 'Vector' } },
  params: {
    x: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'X' },
    y: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Y' },
    z: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Z' },
    amount: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'Multiply all by', hint: 'Scales X, Y and Z together. Wire a number here to fade or animate the whole vector.' },
  },
  summary: (p) => `${short(p.x * p.amount)}, ${short(p.y * p.amount)}, ${short(p.z * p.amount)}`,
  render(ctx) {
    const p = ctx.params;
    return { vector: [p.x * p.amount, p.y * p.amount, p.z * p.amount] };
  },
});
