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
const { createGraph } = await import('../../engine/graph');
const { groupData, GROUP_TYPE } = await import('../../engine/group');
import type { Io } from '../../io/api';
import type { GraphDoc } from '../../engine/types';

/** "Convert to SDF Scene" in the editor: in place, wires and selection follow, one undo step restores the node exactly. */
const registry = new Registry();
registerBuiltins(registry);

function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  const g = createGraph('t');
  const doc: GraphDoc = {
    ...g,
    nodes: [
      { id: 'cam', type: 'camera', x: 0, y: 0, params: {} },
      { id: 'val', type: 'value', x: 0, y: 100, params: { value: 0.3 } },
      { id: 'o', type: 'sdf-3d', x: 300, y: 80, params: { shape1: 'sphere', shape2: 'box', shape3: 'off', smooth2: 0.4, mirrorX: true, fold: 4 } },
      { id: 'out', type: 'output', x: 700, y: 80, params: {} },
      { id: 'other', type: 'value', x: 700, y: 200, params: { value: 1 } },
    ],
    edges: [
      { id: 'e1', from: { node: 'cam', port: 'camera' }, to: { node: 'o', port: 'camera' } },
      { id: 'e2', from: { node: 'val', port: 'value' }, to: { node: 'o', port: 'x2' } },
      { id: 'e3', from: { node: 'o', port: 'image' }, to: { node: 'out', port: 'image' } },
    ],
  };
  ed.loadGraph(doc);
  return { ed, before: JSON.stringify(ed.state.graph) };
}

describe('editor: Convert to SDF Scene', () => {
  it('replaces the node in place, keeps the wires and moves the selection; one undo restores the graph byte for byte', () => {
    const { ed, before } = setup();
    ed.select(['other']);
    const id = ed.convertToSdfScene('o');
    expect(id).toBe('o');
    const g = ed.state.graph;
    const n = g.nodes.find((x) => x.id === 'o')!;
    expect(n.type).toBe(GROUP_TYPE);
    expect(groupData(n).sdfScene).toBe(true);
    expect([n.x, n.y]).toEqual([300, 80]);
    expect(g.nodes.map((x) => x.id)).toEqual(['cam', 'val', 'o', 'out', 'other']);
    expect(g.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`)).toEqual(['cam.camera>o.camera', 'val.value>o.s2_posX', 'o.image>out.image']);
    expect(ed.state.selection).toEqual(['o']);
    // the notes (fold has no equivalent) are shown in the app's own dialog
    expect(ed.state.confirm?.items?.join(' ')).toContain('Kaleidoscope');
    expect(ed.state.confirm?.text).toContain('Double-click the scene to open it');
    ed.undo();
    expect(JSON.stringify(ed.state.graph)).toBe(before);
    ed.redo();
    expect(ed.state.graph.nodes.find((x) => x.id === 'o')!.type).toBe(GROUP_TYPE);
  });

  it('a copy keeps the original and its wires and selects the new scene; one undo removes it', () => {
    const { ed, before } = setup();
    const id = ed.convertToSdfScene('o', true)!;
    expect(id).not.toBe('o');
    const g = ed.state.graph;
    expect(g.nodes.find((x) => x.id === 'o')!.type).toBe('sdf-3d');
    expect(g.nodes.find((x) => x.id === id)!.type).toBe(GROUP_TYPE);
    expect(g.edges.filter((e) => e.to.node === id).map((e) => `${e.from.node}>${e.to.port}`)).toEqual(['cam>camera', 'val>s2_posX']);
    expect(g.edges.some((e) => e.from.node === 'o' && e.to.node === 'out')).toBe(true);
    expect(ed.state.selection).toEqual([id]);
    ed.undo();
    expect(JSON.stringify(ed.state.graph)).toBe(before);
  });

  it('says so with a toast when nothing needed a note, and refuses other nodes', () => {
    const { ed } = setup();
    ed.setParams('o', { fold: 0, mirrorX: false }, 'x');
    ed.convertToSdfScene('o');
    expect(ed.state.confirm).toBeNull();
    expect(ed.state.toasts[ed.state.toasts.length - 1].text).toContain('Converted to an SDF Scene');
    expect(ed.convertToSdfScene('val')).toBeNull();
  });
});
