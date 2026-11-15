import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../graph';
import { harness } from '../testing';
import type { ImageValue } from '../types';

it('a number wired into the 3D object rotation socket turns the object over time', async () => {
  const t = await harness();
  let g = createGraph();
  g.project = { ...g.project, width: 96, height: 96, fps: 10, duration: 2 };
  const anim = addNode(g, t.registry, 'animate', { x: 0, y: 0 }, { from: 0, to: 180 });
  const cube = addNode(anim.graph, t.registry, 'object-3d');
  const out = Object.keys(t.registry.get('animate')!.outputs)[0];
  g = connect(cube.graph, t.registry, { node: anim.node.id, port: out }, { node: cube.node.id, port: 'rotY' });
  const a = (await t.evalGraph(g, cube.node.id, { seconds: 0 })) as ImageValue;
  const b = (await t.evalGraph(g, cube.node.id, { seconds: 0.5 })) as ImageValue;
  expect(await t.diff(a, b)).toBeGreaterThan(0.5);
});
