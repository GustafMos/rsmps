import { describe, expect, it } from 'vitest';
import { layerRowIndex, layerRows, moveUpDelta } from './layerRows';

describe('layer rows', () => {
  it('2 layers: Top, Bottom', () => {
    expect(layerRows(2, true, 'sets size').map((r) => [r.k, r.label])).toEqual([[1, 'Top'], [0, 'Bottom · sets size']]);
  });
  it('3 layers: Top, 2, Bottom', () => {
    expect(layerRows(3, true, 'sets size').map((r) => [r.k, r.label])).toEqual([[2, 'Top'], [1, '2'], [0, 'Bottom · sets size']]);
  });
  it('5 layers count the middle ones from the top', () => {
    expect(layerRows(5, true).map((r) => r.label)).toEqual(['Top', '2', '3', '4', 'Bottom']);
    expect(layerRows(5, true).map((r) => r.k)).toEqual([4, 3, 2, 1, 0]);
  });
  it('one layer is the bottom; none is empty', () => {
    expect(layerRows(1, true, 'sets size').map((r) => r.label)).toEqual(['Bottom · sets size']);
    expect(layerRows(0, true)).toEqual([]);
  });
  it('other inputs keep wire order with plain numbers', () => {
    expect(layerRows(3, false).map((r) => [r.k, r.label])).toEqual([[0, '1'], [1, '2'], [2, '3']]);
  });
  it('socket row index mirrors for top-first only', () => {
    expect([0, 1, 2].map((k) => layerRowIndex(k, 3, true))).toEqual([2, 1, 0]);
    expect([0, 1, 2].map((k) => layerRowIndex(k, 3, false))).toEqual([0, 1, 2]);
  });
  it('move up goes to a later wire in a top-first list, an earlier one otherwise', () => {
    expect(moveUpDelta(true)).toBe(1);
    expect(moveUpDelta(false)).toBe(-1);
  });
});

describe('layer order is presentation only', () => {
  it('"move up" on the Top-first list moves the wire toward the end (top); stored order is otherwise untouched', async () => {
    const { Registry } = await import('../../engine/define');
    const { registerBuiltins } = await import('../../engine/nodes');
    const { addNode, connect, createGraph, wiresInto, moveWire } = await import('../../engine/graph');
    const registry = new Registry();
    registerBuiltins(registry);
    let g = createGraph('t');
    const st = addNode(g, registry, 'stack', { x: 0, y: 0 });
    g = st.graph;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const n = addNode(g, registry, 'noise', { x: 0, y: 0 });
      g = connect(n.graph, registry, { node: n.node.id, port: 'image' }, { node: st.node.id, port: 'images' });
      ids.push(n.node.id);
    }
    const order = () => wiresInto(g, st.node.id, 'images').map((e) => e.from.node);
    expect(order()).toEqual(ids); // first wire = bottom, as stored
    const shown = layerRows(3, true).map((r) => order()[r.k]);
    expect(shown).toEqual([ids[2], ids[1], ids[0]]); // the list shows the top first
    const mid = wiresInto(g, st.node.id, 'images')[1].id;
    g = moveWire(g, mid, moveUpDelta(true));
    expect(order()).toEqual([ids[0], ids[2], ids[1]]); // the middle layer is now the top one
  });
});
