import { defineNode } from '../../define';

/**
 * Iteration: inside a Repeat group, which pass this is. The engine unrolls a Repeat and writes each pass's index into the hidden `iter`
 * param of its own copy of this node, so every pass has its own cache entry and a param wired from here varies per pass (hue step per
 * pass, scale per pass...). Outside a Repeat it gives pass 0 of 1.
 */
const hidden = () => false;

export default defineNode({
  id: 'iteration',
  title: 'Iteration',
  category: 'math',
  description: 'Inside a Repeat group: the number of the current pass (0, 1, 2...), the same as a fraction 0..1, and the pass count. Wire it into any parameter to change it from pass to pass.',
  keywords: ['repeat', 'loop', 'pass', 'index', 'step', 'counter', 'for'],
  inputs: {},
  outputs: {
    index: { type: 'number', label: 'Index' },
    fraction: { type: 'number', label: 'Fraction' },
    count: { type: 'number', label: 'Count' },
  },
  params: {
    iter: { type: 'json', default: null, label: 'Pass', visibleIf: hidden },
  },
  summary: () => 'pass of the enclosing Repeat',
  render(ctx) {
    const it = ctx.params.iter as { index?: unknown; count?: unknown } | null;
    const count = it && typeof it.count === 'number' && it.count >= 1 ? Math.round(it.count) : 1;
    const index = it && typeof it.index === 'number' ? Math.min(count - 1, Math.max(0, Math.round(it.index))) : 0;
    return { index, fraction: count > 1 ? index / (count - 1) : 0, count };
  },
});
