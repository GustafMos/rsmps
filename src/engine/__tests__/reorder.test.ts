import { expect, it } from 'vitest';
import { addNode, connect, createGraph, moveWire, wiresInto } from '../graph';
import { harness } from '../testing';

it('moveWire changes which Stack layer is on top', async () => {
  const t = await harness();
  let g = createGraph();
  const red = addNode(g, t.registry, 'solid', { x: 0, y: 0 }, { color: [1, 0, 0, 1] });
  const blue = addNode(red.graph, t.registry, 'solid', { x: 0, y: 0 }, { color: [0, 0, 1, 1] });
  const stack = addNode(blue.graph, t.registry, 'stack');
  g = stack.graph;
  const port = Object.keys(t.registry.get('stack')!.inputs)[0];
  g = connect(g, t.registry, { node: red.node.id, port: 'image' }, { node: stack.node.id, port });
  g = connect(g, t.registry, { node: blue.node.id, port: 'image' }, { node: stack.node.id, port });
  const top = async () => (await t.pixels((await t.evalGraph(g, stack.node.id)) as never)).at(4, 4);
  expect((await top())[2]).toBe(255); // blue wired last → on top
  g = moveWire(g, wiresInto(g, stack.node.id, port)[1].id, -1);
  expect((await top())[0]).toBe(255); // red now on top
});
