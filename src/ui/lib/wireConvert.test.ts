import { describe, expect, it } from 'vitest';
import { Registry, defineNode } from '../../engine/define';
import { addNode, connect, createGraph, validateGraph } from '../../engine/graph';
import imageToMask from '../../engine/nodes/composite/image-to-mask.node';
import { makeWire, wireError } from './wireConvert';

const stub = (id: string, inputs: Record<string, string>, outputs: Record<string, string>) =>
  defineNode({
    id,
    title: id,
    category: 'filter',
    description: 'Test node.',
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, type]) => [k, { type, label: k }])) as never,
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, type]) => [k, { type, label: k }])) as never,
    params: {},
    render: (() => ({})) as never,
  });

function setup(withConverter = true) {
  const registry = new Registry();
  registry.register(stub('pic', {}, { image: 'image' }) as never);
  registry.register(stub('fx', { image: 'image', mask: 'mask' }, { image: 'image' }) as never);
  registry.register(stub('matte', {}, { mask: 'mask' }) as never);
  registry.register(stub('tone', {}, { audio: 'audio' }) as never);
  if (withConverter) registry.register(imageToMask as never);
  let g = createGraph('t');
  const ids: Record<string, string> = {};
  for (const [key, type, x] of [['pic', 'pic', 0], ['depth', 'pic', 0], ['fx', 'fx', 600], ['matte', 'matte', 0], ['tone', 'tone', 0]] as const) {
    const a = addNode(g, registry, type, { x, y: 100 });
    g = a.graph;
    ids[key] = a.node.id;
  }
  g = connect(g, registry, { node: ids.pic, port: 'image' }, { node: ids.fx, port: 'image' });
  return { registry, g, ids };
}
const wires = (g: ReturnType<typeof createGraph>) => g.edges.map((e) => `${g.nodes.find((n) => n.id === e.from.node)!.type}.${e.from.port}>${g.nodes.find((n) => n.id === e.to.node)!.type}.${e.to.port}`).sort();

describe('a picture wire dropped on a mask input', () => {
  it('goes through a new Image to Mask node, placed left of the input', () => {
    const { registry, g, ids } = setup();
    const from = { node: ids.depth, port: 'image' };
    const to = { node: ids.fx, port: 'mask' };
    expect(wireError(g, registry, from, to)).toBeNull();
    const made = makeWire(g, registry, from, to)!;
    expect(made.converter).toBeTruthy();
    expect(wires(made.graph)).toEqual(['image-to-mask.mask>fx.mask', 'pic.image>fx.image', 'pic.image>image-to-mask.image']);
    expect(validateGraph(made.graph, registry)).toEqual([]);
    const conv = made.graph.nodes.find((n) => n.id === made.converter)!;
    const fx = made.graph.nodes.find((n) => n.id === ids.fx)!;
    expect(conv.x).toBeLessThan(fx.x);
  });
  it('replaces the wire that was in the mask input (one wire per input)', () => {
    const { registry, g, ids } = setup();
    const g1 = connect(g, registry, { node: ids.matte, port: 'mask' }, { node: ids.fx, port: 'mask' });
    const made = makeWire(g1, registry, { node: ids.depth, port: 'image' }, { node: ids.fx, port: 'mask' })!;
    expect(wires(made.graph).filter((w) => w.endsWith('>fx.mask'))).toEqual(['image-to-mask.mask>fx.mask']);
  });
  it('wires that already fit are made as they are; a mask into a picture input needs nothing', () => {
    const { registry, g, ids } = setup();
    const plain = makeWire(g, registry, { node: ids.matte, port: 'mask' }, { node: ids.fx, port: 'mask' })!;
    expect(plain.converter).toBeNull();
    expect(wires(plain.graph)).toContain('matte.mask>fx.mask');
    expect(makeWire(g, registry, { node: ids.matte, port: 'mask' }, { node: ids.fx, port: 'image' })!.converter).toBeNull();
  });
  it('still refuses what cannot be converted: other types, loops, a missing converter', () => {
    const { registry, g, ids } = setup();
    expect(wireError(g, registry, { node: ids.tone, port: 'audio' }, { node: ids.fx, port: 'mask' })).toMatch(/Cannot connect/);
    expect(makeWire(g, registry, { node: ids.tone, port: 'audio' }, { node: ids.fx, port: 'mask' })).toBeNull();
    // fx's own picture into its own mask input would be a loop, converter or not
    expect(wireError(g, registry, { node: ids.fx, port: 'image' }, { node: ids.fx, port: 'mask' })).toBeTruthy();
    expect(makeWire(g, registry, { node: ids.fx, port: 'image' }, { node: ids.fx, port: 'mask' })).toBeNull();
    const none = setup(false);
    expect(wireError(none.g, none.registry, { node: none.ids.depth, port: 'image' }, { node: none.ids.fx, port: 'mask' })).toMatch(/Cannot connect/);
  });
});
