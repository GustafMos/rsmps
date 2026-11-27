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
const { REGIONS_SETUPS, regionsSetupAvailable } = await import('../lib/regions-setup');
const { guideView, missingInputs, needsLine, summaryLine, socketHint } = await import('../lib/guide');
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

function setup(withOutput = false) {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  let g: GraphDoc = createGraph('t');
  const src = addNode(g, registry, 'noise', { x: 100, y: 100 });
  g = src.graph;
  let outId = '';
  if (withOutput) {
    const out = addNode(g, registry, 'image-out', { x: 400, y: 100 });
    g = connect(out.graph, registry, { node: src.node.id, port: 'image' }, { node: out.node.id, port: 'image' });
    outId = out.node.id;
  }
  ed.loadGraph(g);
  return { ed, src: src.node.id, outId };
}
type Ed = InstanceType<typeof Editor>;
const types = (ed: Ed) => ed.state.graph.nodes.map((n) => n.type).sort();
const edgesOf = (ed: Ed) => ed.state.graph.edges;
const noOverlap = (ed: Ed) => {
  const ns = ed.state.graph.nodes;
  for (const a of ns) for (const b of ns) if (a.id < b.id && Math.abs(a.x - b.x) < 216 && Math.abs(a.y - b.y) < 40) throw new Error(`${a.type} overlaps ${b.type}`);
};

describe('"Regions" one-step setups', () => {
  it.each([
    ['moving', ['detect-motion', 'noise', 'region-fx', 'track']],
    ['bright', ['detect-blobs', 'noise', 'region-fx', 'track']],
    ['boxes', ['detect-motion', 'noise', 'region-overlay', 'track']],
    ['except', ['detect-motion', 'noise', 'region-fx', 'track']],
  ] as const)('%s builds the chain, selects and views the main node, in one undo step', (id, expected) => {
    const s = setup();
    expect(regionsSetupAvailable(s.ed.level, registry, s.src)).toBe(true);
    const main = s.ed.addRegionsSetup(s.src, id);
    expect(main).toBeTruthy();
    expect(types(s.ed)).toEqual([...expected].sort());
    expect(s.ed.state.selection).toEqual([main]);
    expect(s.ed.state.viewedNodeId).toBe(main);
    const node = (nid: string) => s.ed.state.graph.nodes.find((n) => n.id === nid)!;
    const ports = edgesOf(s.ed).map((e) => `${node(e.from.node).type}.${e.from.port}>${node(e.to.node).type}.${e.to.port}`).sort();
    const last = node(main!).type;
    const det = s.ed.state.graph.nodes.find((n) => n.type.startsWith('detect'))!.type;
    expect(ports).toEqual([`noise.image>${det}.image`, `noise.image>${last}.image`, `${det}.regions>track.regions`, `track.regions>${last}.regions`].sort());
    noOverlap(s.ed);
    s.ed.undo();
    expect(types(s.ed)).toEqual(['noise']);
    s.ed.redo();
    expect(types(s.ed)).toEqual([...expected].sort());
  });

  it('"except" turns Invert on with a blur; "moving" keeps the new node defaults', () => {
    const s = setup();
    const m = s.ed.addRegionsSetup(s.src, 'except')!;
    expect(s.ed.state.graph.nodes.find((n) => n.id === m)!.params).toMatchObject({ invert: true, fxA: 'blur' });
    const s2 = setup();
    const m2 = s2.ed.addRegionsSetup(s2.src, 'moving')!;
    expect(s2.ed.state.graph.nodes.find((n) => n.id === m2)!.params).toMatchObject({ fxA: 'pixelate', fxB: 'off' });
  });

  it('splices the chain in ahead of what the picture node already fed', () => {
    const s = setup(true);
    const main = s.ed.addRegionsSetup(s.src, 'moving')!;
    const toOut = edgesOf(s.ed).filter((e) => e.to.node === s.outId);
    expect(toOut).toHaveLength(1);
    expect(toOut[0].from).toEqual({ node: main, port: 'image' });
    const outNode = s.ed.state.graph.nodes.find((n) => n.id === s.outId)!;
    const mainNode = s.ed.state.graph.nodes.find((n) => n.id === main)!;
    expect(outNode.x).toBeGreaterThanOrEqual(mainNode.x + 216);
    noOverlap(s.ed);
  });

  it('is offered for picture nodes only', () => {
    const s = setup(true);
    expect(regionsSetupAvailable(s.ed.level, registry, s.outId)).toBe(false);
    expect(s.ed.addRegionsSetup(s.outId, 'moving')).toBeNull();
    expect(REGIONS_SETUPS.map((x) => x.label)).toEqual([
      'Effect on moving things',
      'Effect on bright or colored things',
      'Boxes and labels on things',
      'Blur everything except the things',
    ]);
  });
});

describe('How to use (guide)', () => {
  it('lists a to-do for each unwired required input and closes when satisfied', () => {
    const s = setup();
    const fx = s.ed.addNodeAt('region-fx', { x: 500, y: 100 })!;
    s.ed.select([fx]);
    let v = guideView(s.ed.level, registry, fx, null)!;
    expect(v.open).toBe(true);
    expect(v.todos.map((t) => t.input)).toEqual(['image', 'regions']);
    expect(v.todos[1].fixes.map((f) => f.kind)).toEqual(['add', 'add', 'menu']);
    expect(v.todos[0].fixes.map((f) => f.kind)).toEqual(['menu']);
    // a viewed picture node can fill the picture input
    v = guideView(s.ed.level, registry, fx, s.src)!;
    expect(v.todos[0].fixes.map((f) => f.kind)).toEqual(['viewed', 'menu']);
    expect(s.ed.fixInput(fx, 'image', v.todos[0].fixes[0])).toBe(true);
    v = guideView(s.ed.level, registry, fx, null)!;
    expect(v.todos.map((t) => t.input)).toEqual(['regions']);
    expect(v.todos[0].fixes.map((f) => f.label)).toEqual(['Add Detect Blobs', 'Add Detect Motion', 'Choose a node…']);
    // "Add Detect Blobs": added and wired, fed by the same picture, one undo step
    const before = s.ed.state.graph.nodes.length;
    expect(s.ed.fixInput(fx, 'regions', v.todos[0].fixes[0])).toBe(true);
    const g = s.ed.state.graph;
    expect(g.nodes.length).toBe(before + 1);
    const det = g.nodes.find((n) => n.type === 'detect-blobs')!;
    expect(g.edges.some((e) => e.from.node === s.src && e.to.node === det.id && e.to.port === 'image')).toBe(true);
    expect(g.edges.some((e) => e.from.node === det.id && e.from.port === 'regions' && e.to.node === fx && e.to.port === 'regions')).toBe(true);
    v = guideView(s.ed.level, registry, fx, null)!;
    expect(v.todos).toEqual([]);
    expect(v.open).toBe(false);
    s.ed.undo();
    expect(s.ed.state.graph.nodes.length).toBe(before);
  });

  it('the "menu" fix opens the Add menu linked to the empty input', () => {
    const s = setup();
    const fx = s.ed.addNodeAt('region-fx', { x: 500, y: 100 })!;
    const v = guideView(s.ed.level, registry, fx, null)!;
    s.ed.fixInput(fx, 'regions', v.todos[1].fixes.at(-1)!);
    expect(s.ed.state.addMenu?.link).toMatchObject({ side: 'in', node: fx, port: 'regions', type: 'regions' });
  });

  it('says the problem in words on the node and for each empty socket', () => {
    const def = registry.get('region-fx')!;
    expect(missingInputs(def, new Set(['image'])).map((m) => m.port)).toEqual(['regions']);
    expect(needsLine(def, new Set())).toBe('Needs picture and regions');
    expect(needsLine(def, new Set(['image', 'regions']))).toBeNull();
    expect(socketHint('regions')).toBe('needed');
    expect(summaryLine(def, {}, new Set(['image']))).toBe('Needs regions');
    expect(summaryLine(def, { fxA: 'pixelate', fxB: 'off', fxC: 'off', fxD: 'off', give: 'all' }, new Set(['image', 'regions']))).toBe('A pixelate');
  });

  it('every guide refers to real inputs and related nodes, and stays short', () => {
    const withGuide = registry.list().filter((d) => d.guide);
    expect(withGuide.length).toBeGreaterThanOrEqual(20);
    for (const d of withGuide) {
      const g = d.guide!;
      for (const n of g.needs ?? []) expect(Object.keys(d.inputs), `${d.id} needs ${n.input}`).toContain(n.input);
      for (const id of g.seeAlso ?? []) expect(registry.get(id), `${d.id} seeAlso ${id}`).toBeTruthy();
      expect(g.steps.length, d.id).toBeGreaterThanOrEqual(2);
      expect(g.steps.length, d.id).toBeLessThanOrEqual(4);
      expect(g.does.length, d.id).toBeLessThan(200);
      expect(d.id, 'physics has its own').not.toBe('physics');
    }
    const ids = withGuide.map((d) => d.id);
    for (const id of ['region-fx', 'detect-blobs', 'detect-color', 'detect-motion', 'regions-from-mask', 'track', 'region-filter', 'region-transform', 'region-info', 'regions-to-mask', 'region-overlay', 'region-trails', 'region-stamp', 'region-crop']) expect(ids).toContain(id);
  });
});
