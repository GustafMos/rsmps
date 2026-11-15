import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import type { ImageValue } from '../../types';
import { harness } from '../../testing';

const RED: [number, number, number] = [1, 0, 0];
const GREEN: [number, number, number] = [0, 1, 0];
const BLUE: [number, number, number] = [0, 0, 1];
const ORANGE: [number, number, number] = [1, 0.5, 0];
const CYAN: [number, number, number] = [0, 1, 1];

async function swap(t: Awaited<ReturnType<typeof harness>>, image: ImageValue, from: [number, number, number][], to: [number, number, number][], params: Record<string, unknown> = {}) {
  let g = createGraph('swap');
  const node = addNode(g, t.registry, 'palette-swap', { x: 0, y: 0 }, params);
  g = node.graph;
  const src = addNode(g, t.registry, t.source(image));
  g = connect(src.graph, t.registry, { node: src.node.id, port: 'out' }, { node: node.node.id, port: 'image' });
  for (const [port, colors] of [['from', from], ['to', to]] as const) {
    const pal = addNode(g, t.registry, 'palette', { x: 0, y: 0 }, { source: 'custom', custom: colors });
    g = connect(pal.graph, t.registry, { node: pal.node.id, port: 'palette' }, { node: node.node.id, port });
  }
  return t.pixels((await t.evalGraph(g, node.node.id, { port: 'image' })) as ImageValue);
}

describe('palette-swap', () => {
  it('remaps colours by index and keeps alpha', async () => {
    const t = await harness();
    const img = t.fromFn(3, 1, (x) => (x === 0 ? [255, 0, 0, 255] : x === 1 ? [0, 255, 0, 255] : [0, 0, 255, 128]));
    const px = await swap(t, img, [RED, GREEN, BLUE], [ORANGE, CYAN, [1, 1, 1]]);
    expect(px.at(0, 0)[1]).toBeGreaterThanOrEqual(127);
    expect(px.at(0, 0)[1]).toBeLessThanOrEqual(128);
    expect([px.at(0, 0)[0], px.at(0, 0)[2], px.at(0, 0)[3]]).toEqual([255, 0, 255]);
    expect(px.at(1, 0)).toEqual([0, 255, 255, 255]);
    expect(px.at(2, 0)).toEqual([255, 255, 255, 128]);
  });

  it('near colours go to the nearest source colour; a shorter target reuses its last colour', async () => {
    const t = await harness();
    const img = t.fromFn(2, 1, (x) => (x === 0 ? [240, 20, 20, 255] : [20, 20, 230, 255]));
    const px = await swap(t, img, [RED, GREEN, BLUE], [ORANGE, CYAN]);
    expect(px.at(0, 0)[0]).toBe(255);
    expect(px.at(0, 0)[2]).toBe(0);
    expect(px.at(1, 0)).toEqual([0, 255, 255, 255]); // index 2 -> last colour of "to"
  });

  it('tolerance leaves colours that are not close to any source colour untouched', async () => {
    const t = await harness();
    const img = t.fromFn(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [120, 120, 120, 255]));
    const px = await swap(t, img, [RED], [BLUE], { tolerance: 0.1 });
    expect(px.at(0, 0)).toEqual([0, 0, 255, 255]);
    expect(px.at(1, 0)[0]).toBeGreaterThan(110);
    expect(px.at(1, 0)[0]).toBeLessThan(130);
  });
});
