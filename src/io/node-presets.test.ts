import { describe, expect, it } from 'vitest';
import { Registry } from '../engine/define';
import { addNode, connect, createGraph } from '../engine/graph';
import { exposeParam, flattenGraph, groupData, GROUP_MAX_DEPTH, makeGroup } from '../engine/group';
import { registerBuiltins } from '../engine/nodes';
import type { NodeInstance } from '../engine/types';
import { NODE_FILE_MAX_BYTES, NodePresetStore, parseNodePresetFile, type NodePreset, type NodePresetStorage } from './node-presets';

/** Saved group nodes: save / load / export / import, and import validation (unknown types, depth, size, not a node file). */
const registry = new Registry();
registerBuiltins(registry);

function memoryStorage(): NodePresetStorage & { map: Map<string, NodePreset> } {
  const map = new Map<string, NodePreset>();
  return { map, all: async () => [...map.values()], put: async (p) => void map.set(p.id, structuredClone(p)), delete: async (id) => void map.delete(id) };
}

function sampleGroup(): NodeInstance {
  let g = createGraph('p');
  const a = addNode(g, registry, 'noise');
  const b = addNode(a.graph, registry, 'color-adjust', { x: 300, y: 0 });
  const c = addNode(b.graph, registry, 'cache', { x: 600, y: 0 }, { baked: 'asset-9', bakedSignature: 's' });
  g = connect(c.graph, registry, { node: a.node.id, port: 'image' }, { node: b.node.id, port: 'image' });
  g = connect(g, registry, { node: b.node.id, port: 'image' }, { node: c.node.id, port: 'image' });
  const made = makeGroup(g, registry, [b.node.id, c.node.id], { title: 'Recolor pass' });
  const exposed = exposeParam(made.graph, made.group.id, b.node.id, 'hue', registry, 'Hue');
  return { ...exposed.nodes.find((n) => n.id === made.group.id)!, params: { ...exposed.nodes.find((n) => n.id === made.group.id)!.params, __process: { signature: 'x', items: {} } } };
}

const clearOf = (n: NodeInstance) => (n.type === 'cache' ? { baked: '', bakedSignature: '' } : null);

describe('saved group nodes', () => {
  it('save, list, restore, remove; a saved node carries no stored results', async () => {
    const storage = memoryStorage();
    const store = new NodePresetStore(registry, storage, clearOf);
    let notified = 0;
    store.subscribe(() => notified++);
    const p = await store.save(sampleGroup(), { name: 'Recolor', category: 'color', keywords: ['hue'], description: 'One pass.' });
    expect(p.id.startsWith('node:')).toBe(true);
    expect(store.list().map((x) => x.name)).toEqual(['Recolor']);
    expect(p.group.params.__process).toBeUndefined();
    expect(groupData(p.group).nodes.find((n) => n.type === 'cache')!.params.baked).toBe('');
    const again = new NodePresetStore(registry, storage, clearOf);
    await again.restore();
    expect(again.list()[0]).toMatchObject({ name: 'Recolor', category: 'color', keywords: ['hue'] });
    await again.remove(p.id);
    expect(again.list()).toEqual([]);
    expect(notified).toBeGreaterThan(0);
  });

  it('export then import round-trips; an instance is an editable copy that evaluates', async () => {
    const store = new NodePresetStore(registry, memoryStorage(), clearOf);
    const text = store.toFile(sampleGroup(), { name: 'Recolor', category: 'color' });
    const parsed = store.parse(text);
    expect(parsed).toMatchObject({ schema: 'rsmps/node', version: 1, name: 'Recolor', category: 'color' });
    const imported = await store.importFile(new Blob([text]));
    const inst = store.instantiate(imported);
    expect(inst.type).toBe('group');
    expect(groupData(inst).exposed[0].label).toBe('Hue');
    // the copy is independent of the saved one
    (inst.params.nodes as NodeInstance[])[0].params.brightness = 0.9;
    expect((imported.group.params.nodes as NodeInstance[])[0].params.brightness).not.toBe(0.9);
    // it flattens like any group
    const g = { ...createGraph('x'), nodes: [{ ...inst, id: 'g1' }] };
    expect(flattenGraph(g).graph.nodes.length).toBe(groupData(inst).nodes.length);
  });

  it('a project with groups survives saving (JSON + parseGraph); old projects without groups load unchanged', async () => {
    const { parseGraph } = await import('./projects');
    const group = sampleGroup();
    const doc = { ...createGraph('saved'), nodes: [{ ...group, id: 'g1' }] };
    const back = parseGraph(JSON.parse(JSON.stringify(doc)));
    expect(back.nodes[0]).toEqual(doc.nodes[0]);
    expect(flattenGraph(back).graph.nodes.map((n) => n.id)).toEqual(flattenGraph(doc).graph.nodes.map((n) => n.id));
    // a built-in preset (written before groups existed) has no group: flattening hands back the very same document
    const old = parseGraph((await import('./presets/vhs-tape.json')).default);
    expect(flattenGraph(old).graph).toBe(old);
  });

  it('import refuses unknown node types, too deep nesting, oversized files and other files', () => {
    const store = new NodePresetStore(registry, memoryStorage(), clearOf);
    const good = JSON.parse(store.toFile(sampleGroup(), { name: 'R' }));
    const bad = structuredClone(good);
    bad.group.params.nodes[0].type = 'someone/missing-plugin';
    expect(() => parseNodePresetFile(JSON.stringify(bad), registry)).toThrow(/unknown node type "someone\/missing-plugin"/);
    // too deep: wrap the group in groups beyond the cap
    let inner: NodeInstance = { id: 'g0', type: 'group', x: 0, y: 0, params: good.group.params };
    for (let i = 1; i <= GROUP_MAX_DEPTH + 1; i++) inner = { id: `g${i}`, type: 'group', x: 0, y: 0, params: { kind: 'group', nodes: [inner], edges: [], inputs: [], outputs: [], exposed: [] } };
    expect(() => parseNodePresetFile(JSON.stringify({ ...good, group: { type: 'group', params: inner.params } }), registry)).toThrow(/nested more than/);
    expect(() => parseNodePresetFile('x'.repeat(NODE_FILE_MAX_BYTES + 1), registry)).toThrow(/too large/);
    expect(() => parseNodePresetFile('{"schema":"rsmps/graph","version":2}', registry)).toThrow(/not a saved node/);
    expect(() => parseNodePresetFile('not json', registry)).toThrow(/not valid JSON/);
    // a damaged wire is named
    const wired = structuredClone(good);
    wired.group.params.edges.push({ id: 'e', from: { node: 'nope', port: 'image' }, to: { node: '@out', port: 'out1' } });
    expect(() => parseNodePresetFile(JSON.stringify(wired), registry)).toThrow(/missing node "nope"/);
  });
});
