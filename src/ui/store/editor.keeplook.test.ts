import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('./editor');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { addNode, connect, createGraph } = await import('../../engine/graph');
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

function setup(types: string[]) {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  let g: GraphDoc = createGraph('t');
  const ids: string[] = [];
  types.forEach((type, i) => {
    const r = addNode(g, registry, type, { x: i * 400, y: 0 });
    g = r.graph;
    ids.push(r.node.id);
  });
  for (let i = 0; i + 1 < ids.length; i++) {
    const out = Object.keys(registry.get(types[i])!.outputs)[0];
    const inn = Object.keys(registry.get(types[i + 1])!.inputs)[0];
    g = connect(g, registry, { node: ids[i], port: out }, { node: ids[i + 1], port: inn });
  }
  ed.loadGraph(g);
  return { ed, ids };
}

const rsNodes = (g: GraphDoc) => g.nodes.filter((n) => n.type === 'render-scale');

describe('keepPreviewLook', () => {
  it('viewing an Output: inserts Render Scale in front of it, one undo step, selected, toast', () => {
    const { ed, ids } = setup(['noise', 'blur', 'image-out']);
    ed.setViewed(ids[2]);
    const id = ed.keepPreviewLook(25);
    const g = ed.state.graph;
    expect(rsNodes(g)).toHaveLength(1);
    const rs = rsNodes(g)[0];
    expect(rs.id).toBe(id);
    expect(rs.params).toMatchObject({ scale: 25, filter: 'smooth' });
    expect(g.edges.some((e) => e.from.node === ids[1] && e.to.node === rs.id)).toBe(true);
    expect(g.edges.some((e) => e.from.node === rs.id && e.to.node === ids[2])).toBe(true);
    expect(g.edges.some((e) => e.from.node === ids[1] && e.to.node === ids[2])).toBe(false);
    expect(ed.state.selection).toEqual([rs.id]);
    expect(ed.state.toasts.at(-1)?.text).toBe('Render Scale 25% added');
    ed.undo();
    expect(rsNodes(ed.state.graph)).toHaveLength(0);
    expect(ed.state.graph.edges.some((e) => e.from.node === ids[1] && e.to.node === ids[2])).toBe(true);
  });

  it('a second press updates the existing Render Scale instead of stacking', () => {
    const { ed, ids } = setup(['noise', 'image-out']);
    ed.setViewed(ids[1]);
    ed.keepPreviewLook(25);
    ed.keepPreviewLook(50);
    const g = ed.state.graph;
    expect(rsNodes(g)).toHaveLength(1);
    expect(rsNodes(g)[0].params.scale).toBe(50);
    expect(ed.state.toasts.at(-1)?.text).toBe('Render Scale 50% updated');
  });

  it('viewing another node: inserts after it, between it and its consumers', () => {
    const { ed, ids } = setup(['noise', 'blur', 'image-out']);
    ed.setViewed(ids[1]);
    ed.keepPreviewLook(35);
    const g = ed.state.graph;
    const rs = rsNodes(g)[0];
    expect(g.edges.some((e) => e.from.node === ids[1] && e.to.node === rs.id)).toBe(true);
    expect(g.edges.some((e) => e.from.node === rs.id && e.to.node === ids[2])).toBe(true);
    expect(rs.params.scale).toBe(35);
  });

  it('an Output with nothing wired: no node, a hint', () => {
    const { ed, ids } = setup(['image-out']);
    ed.setViewed(ids[0]);
    expect(ed.keepPreviewLook(25)).toBeNull();
    expect(rsNodes(ed.state.graph)).toHaveLength(0);
  });
});
