import { describe, expect, it, vi } from 'vitest';

// the store modules read localStorage at construction
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
const { groupData, GROUP_IN, GROUP_OUT, NEW_PORT } = await import('../../engine/group');
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';

/** Editor store logic of group nodes on the real registry: group / ungroup, open / close (path state), expose, ports, copies. */
const registry = new Registry();
registerBuiltins(registry);

function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  let g: GraphDoc = createGraph('t');
  const ids: Record<string, string> = {};
  let x = 0;
  const add = (name: string, type: string, params: Record<string, unknown> = {}) => {
    const r = addNode(g, registry, type, { x: (x += 300), y: 0 }, params);
    g = r.graph;
    ids[name] = r.node.id;
  };
  add('src', 'noise');
  add('a', 'color-adjust');
  add('b', 'blur');
  add('o', 'image-out');
  g = connect(g, registry, { node: ids.src, port: 'image' }, { node: ids.a, port: 'image' });
  g = connect(g, registry, { node: ids.a, port: 'image' }, { node: ids.b, port: 'image' });
  g = connect(g, registry, { node: ids.b, port: 'image' }, { node: ids.o, port: 'image' });
  ed.loadGraph(g);
  return { ed, ids, original: ed.state.graph };
}

const edgeSet = (g: GraphDoc) => g.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();

describe('editor: groups', () => {
  it('group (one undo step) then ungroup restores the wiring; the viewed node is followed into the group', () => {
    const { ed, ids, original } = setup();
    ed.setViewed(ids.b);
    ed.select([ids.a, ids.b]);
    const gid = ed.groupNodes()!;
    expect(gid).toBeTruthy();
    expect(ed.state.graph.nodes.map((n) => n.id).sort()).toEqual([ids.src, ids.o, gid].sort());
    expect(ed.state.selection).toEqual([gid]);
    expect(ed.state.viewedNodeId).toBe(`${gid}/${ids.b}`);
    ed.undo();
    expect(edgeSet(ed.state.graph)).toEqual(edgeSet(original));
    ed.redo();
    ed.setViewed(`${gid}/${ids.b}`); // undo / redo do not remember the view
    ed.select([gid]);
    ed.ungroupNodes();
    expect(edgeSet(ed.state.graph)).toEqual(edgeSet(original));
    expect(ed.state.viewedNodeId).toBe(ids.b);
    // output nodes are refused with a message, nothing changes
    ed.select([ids.b, ids.o]);
    expect(ed.groupNodes()).toBeNull();
  });

  it('enter / exit: the level shows the inside with its boundary, edits inside are written back, undo works across levels', () => {
    const { ed, ids } = setup();
    ed.select([ids.a, ids.b]);
    const gid = ed.groupNodes()!;
    ed.enterGroup(gid);
    expect(ed.state.path).toEqual([gid]);
    expect(ed.state.level.nodes.map((n) => n.id)).toEqual([GROUP_IN, ids.a, ids.b, GROUP_OUT]);
    expect(ed.fullId(ids.a)).toBe(`${gid}/${ids.a}`);
    ed.setParam(ids.a, 'brightness', 0.3);
    const inner = () => groupData(ed.state.graph.nodes.find((n) => n.id === gid)!).nodes.find((n) => n.id === ids.a)!;
    expect(inner().params.brightness).toBe(0.3);
    ed.undo();
    expect(inner().params.brightness).not.toBe(0.3);
    expect(ed.state.path).toEqual([gid]); // still open
    // deleting inside heals the chain inside
    ed.select([ids.a]);
    ed.deleteSelection();
    const d = groupData(ed.state.graph.nodes.find((n) => n.id === gid)!);
    expect(d.nodes.map((n) => n.id)).toEqual([ids.b]);
    expect(d.edges.some((e) => e.from.node === GROUP_IN && e.to.node === ids.b)).toBe(true);
    ed.exitGroup(0);
    expect(ed.state.path).toEqual([]);
    expect(ed.state.selection).toEqual([gid]);
    // a path that no longer exists (undo of the grouping) closes by itself
    ed.enterGroup(gid);
    ed.undo();
    ed.undo();
    expect(ed.state.path).toEqual([]);
  });

  it('expose a param, rename it, unexpose; add a port by wiring to the boundary "+"', () => {
    const { ed, ids } = setup();
    ed.select([ids.a]);
    const gid = ed.groupNodes()!;
    ed.enterGroup(gid);
    ed.exposeParam(ids.a, 'brightness', 'Light');
    const group = () => ed.state.graph.nodes.find((n) => n.id === gid)!;
    const x = groupData(group()).exposed[0];
    expect(x).toMatchObject({ node: ids.a, param: 'brightness', label: 'Light' });
    // a wire from an inner input to the "+" of the group input adds an input port
    ed.connect({ node: GROUP_IN, port: NEW_PORT }, { node: ids.a, port: 'saturation' });
    const ports = groupData(group()).inputs;
    expect(ports.length).toBe(2);
    expect(ports[1]).toMatchObject({ type: 'number', name: 'Saturation' });
    ed.exitGroup(0);
    ed.setParam(gid, x.id, 0.25);
    expect(group().params[x.id]).toBe(0.25);
    ed.editExposed(gid, { rename: { [x.id]: 'Lightness' } });
    expect(groupData(group()).exposed[0].label).toBe('Lightness');
    ed.unexposeParam(gid, x.id);
    expect(groupData(group()).exposed).toEqual([]);
    expect(groupData(group()).nodes[0].params.brightness).toBe(0.25);
  });

  it('a pasted or duplicated node does not share a stored result', () => {
    const { ed, ids } = setup();
    ed.setParam(ids.b, 'radius', 4);
    const cacheId = ed.addNodeAt('cache', { x: 0, y: 500 })!;
    ed.setParam(cacheId, 'baked', 'asset-1');
    ed.setParam(cacheId, 'bakedSignature', 'sig');
    ed.select([cacheId]);
    ed.duplicate();
    const copy = ed.state.graph.nodes.find((n) => n.type === 'cache' && n.id !== cacheId)!;
    expect(copy.params.baked).toBe('');
    expect(ed.state.graph.nodes.find((n) => n.id === cacheId)!.params.baked).toBe('asset-1');
    // a group copy loses its own bake and the bakes inside
    ed.select([cacheId]);
    const gid = ed.groupNodes()!;
    ed.setParam(gid, '__process', { signature: 's', items: {} });
    ed.select([gid]);
    ed.copy();
    ed.paste({ x: 0, y: 900 });
    const pasted = ed.state.graph.nodes.find((n) => n.type === 'group' && n.id !== gid)!;
    expect(pasted.params.__process).toBeUndefined();
    expect(groupData(pasted).nodes[0].params.baked).toBe('');
  });

  it('Repeat from the selection; removing a port drops its wires inside and outside; nested groups open by path', () => {
    const { ed, ids } = setup();
    ed.select([ids.a]);
    const rid = ed.groupNodes('repeat')!;
    const rep = () => ed.state.graph.nodes.find((n) => n.id === rid)!;
    expect(groupData(rep()).kind).toBe('repeat');
    expect(groupData(rep()).inputs[0].loop).toBe(true);
    expect(rep().params.count).toBe(4);
    // remove the input port from the parent level: the outer wire into it goes too
    ed.removeGroupPort('in', 'in1', rid);
    expect(groupData(rep()).inputs).toEqual([]);
    expect(ed.state.graph.edges.some((e) => e.to.node === rid)).toBe(false);
    expect(groupData(rep()).edges.some((e) => e.from.node === GROUP_IN)).toBe(false);
    // a group inside a group: the path grows, the breadcrumb levels close one by one
    ed.select([rid, ids.b]);
    const outer = ed.groupNodes()!;
    ed.enterGroup(outer);
    ed.enterGroup(rid);
    expect(ed.state.path).toEqual([outer, rid]);
    expect(ed.fullId(ids.a)).toBe(`${outer}/${rid}/${ids.a}`);
    ed.setParam(ids.a, 'contrast', 1.5);
    const innerA = groupData(groupData(ed.state.graph.nodes.find((n) => n.id === outer)!).nodes.find((n) => n.id === rid)!).nodes[0];
    expect(innerA.params.contrast).toBe(1.5);
    ed.exitGroup();
    expect(ed.state.path).toEqual([outer]);
    expect(ed.state.selection).toEqual([rid]);
  });
});
