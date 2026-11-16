import { defineNode } from '../../define';
import { evalCurve, presetLinear } from '../../lib/util-curve';

export default defineNode({
  id: 'curve-remap',
  title: 'Curve Remap',
  category: 'math',
  description: 'Reshape any number with a drawn curve: a number goes in, the curve decides what comes out. Good for loudness to height, or any non-straight response.',
  keywords: ['transfer function', 'response', 'gamma', 'shape', 'map', 'curve', 'remap', 'envelope', 'lookup'],
  inputs: {},
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    value: { type: 'number', default: 0.5, min: -1000000, max: 1000000, step: 0.01, label: 'Number in' },
    inMin: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Curve start' },
    inMax: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'Input at curve end' },
    curve: { type: 'curve', default: presetLinear(), label: 'Curve' },
    clamp: { type: 'bool', default: true, label: 'Clamp ends', hint: 'Hold the end values outside the input range.' },
  },
  summary: (p) => `${p.curve.keys.length} keys · ${p.inMin}..${p.inMax}`,
  render(ctx) {
    const p = ctx.params;
    const span = p.inMax - p.inMin;
    let u = span === 0 ? 0 : (p.value - p.inMin) / span;
    if (p.clamp) u = Math.min(1, Math.max(0, u));
    return { value: evalCurve(p.curve, u, { loop: false }) };
  },
});
