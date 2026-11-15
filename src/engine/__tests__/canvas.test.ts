import { expect, it } from 'vitest';
import { addNode, createGraph } from '../graph';
import { harness } from '../testing';
import type { ImageValue } from '../types';

it('a canvas override re-renders generators for another frame with the same unit (same look)', async () => {
  const t = await harness();
  const a = addNode(createGraph(), t.registry, 'noise');
  const land = (await t.engine.evaluate({ graph: a.graph, node: a.node.id })).value as ImageValue;
  const port = (await t.engine.evaluate({ graph: a.graph, node: a.node.id, canvas: { width: 1080, height: 1920 } })).value as ImageValue;
  expect([land.width, land.height]).toEqual([1920, 1080]);
  expect([port.width, port.height]).toEqual([1080, 1920]);
  expect(port.unit).toBe(land.unit);
  const again = (await t.engine.evaluate({ graph: a.graph, node: a.node.id })).value as ImageValue;
  expect(again.width).toBe(1920); // the two frames are cached separately
});
