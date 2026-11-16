import { describe, expect, it } from 'vitest';
import { Registry } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { registerBuiltins } from '../engine/nodes';
import { renderHash } from './util';

/** The player's frame cache is valid as long as this hash is: it must change exactly when the VIEWED picture can change. */
describe('renderHash (player frame-cache key)', () => {
  const registry = new Registry();
  registerBuiltins(registry);
  let g = createGraph('h');
  const a = addNode(g, registry, 'color-adjust'); g = a.graph;
  const b = addNode(g, registry, 'color-adjust'); g = b.graph;
  const other = addNode(g, registry, 'color-adjust'); g = other.graph;
  const out = addNode(g, registry, 'image-out'); g = out.graph;
  g = connect(g, registry, { node: a.node.id, port: 'image' }, { node: b.node.id, port: 'image' });
  const h0 = renderHash(g, b.node.id, undefined, 'x');

  it('ignores edits in a branch that does not feed the viewed node', () => {
    expect(renderHash(setParam(g, other.node.id, 'brightness', 0.9), b.node.id, undefined, 'x')).toBe(h0);
    expect(renderHash({ ...g, nodes: g.nodes.map((n) => (n.id === other.node.id ? { ...n, x: 500 } : n)) }, b.node.id, undefined, 'x')).toBe(h0);
  });
  it('changes for an edit of the viewed node or anything upstream of it', () => {
    expect(renderHash(setParam(g, b.node.id, 'brightness', 0.9), b.node.id, undefined, 'x')).not.toBe(h0);
    expect(renderHash(setParam(g, a.node.id, 'brightness', 0.9), b.node.id, undefined, 'x')).not.toBe(h0);
    expect(renderHash({ ...g, project: { ...g.project, fps: g.project.fps + 1 } }, b.node.id, undefined, 'x')).not.toBe(h0);
    expect(renderHash(g, a.node.id, undefined, 'x')).not.toBe(h0); // another node viewed
  });
  it('an extra node (the active Output, whose frame size matters) is part of the key', () => {
    const withOut = renderHash(g, b.node.id, undefined, 'x', [out.node.id]);
    expect(renderHash(setParam(g, out.node.id, 'width', 123), b.node.id, undefined, 'x', [out.node.id])).not.toBe(withOut);
    expect(renderHash(setParam(g, out.node.id, 'width', 123), b.node.id, undefined, 'x')).toBe(h0);
  });
  it('does not depend on the key order of param objects', () => {
    const swapped = { ...g, nodes: g.nodes.map((n) => ({ ...n, params: Object.fromEntries(Object.entries(n.params).reverse()) })) };
    expect(renderHash(swapped, b.node.id, undefined, 'x')).toBe(h0);
  });
});
