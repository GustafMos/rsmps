import { defineNode } from '../../define';

export default defineNode({
  id: 'value',
  title: 'Number',
  category: 'math',
  description: 'A single number you can wire into any number setting, so one slider drives many nodes.',
  keywords: ['constant', 'float', 'slider', 'parameter', 'value'],
  inputs: {},
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    value: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'Number' },
  },
  summary: (p) => String(p.value),
  render(ctx) {
    return { value: ctx.params.value };
  },
});
