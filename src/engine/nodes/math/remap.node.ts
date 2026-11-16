import { defineNode } from '../../define';

export default defineNode({
  id: 'remap',
  title: 'Remap Range',
  category: 'math',
  description: 'Convert a number from one range to another, for example 0..1 to 0..360.',
  keywords: ['map range', 'scale', 'rescale', 'normalize', 'lerp', 'convert'],
  inputs: {},
  outputs: { value: { type: 'number', label: 'Result' } },
  params: {
    value: { type: 'number', default: 0.5, min: -1000000, max: 1000000, step: 0.01, label: 'Number' },
    fromMin: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'From min' },
    fromMax: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'From max' },
    toMin: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'To min' },
    toMax: { type: 'number', default: 100, min: -1000000, max: 1000000, step: 0.01, label: 'To max' },
    clamp: { type: 'bool', default: true, label: 'Clamp', hint: 'Stay inside the new range.' },
  },
  summary: (p) => `${p.fromMin}..${p.fromMax} → ${p.toMin}..${p.toMax}`,
  render(ctx) {
    const p = ctx.params;
    const span = p.fromMax - p.fromMin;
    let t = span === 0 ? 0 : (p.value - p.fromMin) / span;
    if (p.clamp) t = Math.min(1, Math.max(0, t));
    return { value: p.toMin + (p.toMax - p.toMin) * t };
  },
});
