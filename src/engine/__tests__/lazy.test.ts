import { expect, it } from 'vitest';
import { defineNode } from '../define';
import { addNode, connect, createGraph, setParam } from '../graph';
import { harness } from '../testing';

it('lazy inputs: analysis on a fixed frame runs once, not per frame, and re-runs when upstream is edited', async () => {
  let analysed = 0;
  const t = await harness([
    defineNode({
      id: 'clock-number',
      title: 'c',
      category: 'math',
      description: 'd',
      inputs: {},
      outputs: { v: { type: 'number' } },
      params: { gain: { type: 'number', default: 1 } },
      render: (ctx) => ({ v: ctx.time.frame * ctx.params.gain + 100 }),
    }),
    defineNode({
      id: 'analyse-first',
      title: 'a',
      category: 'math',
      description: 'd',
      inputs: { src: { type: 'number', required: true, lazy: true } },
      outputs: { v: { type: 'number' } },
      params: {},
      async render(ctx) {
        analysed++;
        return { v: (await ctx.pull('src', { seconds: 0 })) ?? -1 };
      },
    }),
  ]);
  let g = createGraph();
  const a = addNode(g, t.registry, 'clock-number');
  const b = addNode(a.graph, t.registry, 'analyse-first');
  g = connect(b.graph, t.registry, { node: a.node.id, port: 'v' }, { node: b.node.id, port: 'src' });
  for (const s of [0, 0.5, 1, 2]) {
    const r = await t.engine.evaluate({ graph: g, node: b.node.id, seconds: s });
    expect(r.value).toBe(100);
  }
  expect(analysed).toBe(1);
  g = setParam(g, a.node.id, 'gain', 2);
  await t.engine.evaluate({ graph: g, node: b.node.id, seconds: 1 });
  expect(analysed).toBe(2);
});
