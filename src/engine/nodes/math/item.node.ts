import { defineNode } from '../../define';

export default defineNode({
  id: 'item',
  title: 'Batch Item',
  category: 'math',
  description: 'Which file of a batch is being processed: its number, how many there are, and its position from 0 to 1.',
  keywords: ['batch', 'index', 'count', 'file number', 'position', 'sequence'],
  inputs: {},
  outputs: {
    index: { type: 'number', label: 'Item number (0, 1, 2…)' },
    count: { type: 'number', label: 'Total items' },
    fraction: { type: 'number', label: 'Position (0..1)' },
  },
  params: {},
  summary: () => 'index · count · 0..1',
  render(ctx) {
    const { index, count } = ctx.item;
    return { index, count, fraction: count > 1 ? index / (count - 1) : 0 };
  },
});
