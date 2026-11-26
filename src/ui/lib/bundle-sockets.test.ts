/**
 * Bundle sockets (one vector wire for an X / Y / Z group of settings) in the UI: they take no room on a node until they are used,
 * and every list of sockets (drop picker, add menu, type conversion) knows them.
 */
import { describe, expect, it } from 'vitest';
import { Registry, defineNode } from '../../engine/define';
import { addNode, connect, createGraph } from '../../engine/graph';
import { compatibleSockets } from './compat';
import { ROW_H, layoutNode, type BodyView, type Row } from './layout';
import { inputsAccepting } from './sockets';

const num = (label: string) => ({ type: 'number' as const, default: 0, label });
const body = defineNode({
  id: 'body',
  title: 'Body',
  category: 'generate',
  description: 'Test node.',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: {
    size: num('Size'),
    posX: { ...num('Move X'), group: 'Object' },
    posY: { ...num('Move Y'), group: 'Object' },
    posZ: { ...num('Move Z'), group: 'Object' },
    rotX: num('Rotate X'),
    rotY: num('Rotate Y'),
    rotZ: num('Rotate Z'),
    center: { type: 'vec2', default: [0.5, 0.5], label: 'Center' },
    extra: num('Extra'),
  },
  render: (() => ({})) as never,
});
const vec = defineNode({ id: 'vec', title: 'Vec', category: 'math', description: 'Test.', inputs: {}, outputs: { vector: { type: 'vector' } }, params: {}, render: (() => ({})) as never });
const one = defineNode({ id: 'one', title: 'One', category: 'math', description: 'Test.', inputs: {}, outputs: { value: { type: 'number' } }, params: {}, render: (() => ({})) as never });

function setup() {
  const registry = new Registry();
  for (const d of [body, vec, one]) registry.register(d as never);
  let g = createGraph('t');
  const b = addNode(g, registry, 'body');
  const v = addNode(b.graph, registry, 'vec');
  const o = addNode(v.graph, registry, 'one');
  g = o.graph;
  return { registry, g, b: b.node, v: v.node, o: o.node, def: registry.get('body')! };
}
const names = (rows: Row[]) => rows.map((r) => (r.kind === 'param' ? r.key : r.kind === 'bundle' ? `[${r.bundle.port}]` : r.kind));
const view = (v: Partial<BodyView>): BodyView => ({ expanded: false, wired: [], ...v });

describe('bundle sockets on the node', () => {
  it('an unused bundle takes no row: the node is exactly as tall as before', () => {
    const { b, def } = setup();
    const l = layoutNode({ ...b }, def, undefined, false, {}, view({}));
    expect(names(l.rows)).toEqual(['io', 'size', 'posX', 'posY', 'posZ', 'rotX', 'rotY', 'more']);
    // the vec2 setting has a socket of its own on its row; hidden bundles share the expander row like hidden settings
    expect(l.sockets['in:pos@xyz']).toEqual(l.sockets['in:extra']);
    expect(l.sockets['in:posX'].y).toBeLessThan(l.sockets['in:pos@xyz'].y);
  });

  it('a wired bundle gets one row right above its first setting, and its settings show as driven', () => {
    const { b, def } = setup();
    const plain = layoutNode({ ...b }, def, undefined, false, {}, view({}));
    const l = layoutNode({ ...b }, def, undefined, false, {}, view({ wired: ['rot@xyz'] }));
    expect(names(l.rows)).toEqual(['io', 'size', 'posX', 'posY', 'posZ', '[rot@xyz]', 'rotX', 'rotY', 'more']);
    expect(l.height).toBe(plain.height + ROW_H);
    const row = (key: string) => l.rows.find((r) => r.kind === 'param' && r.key === key) as Extract<Row, { kind: 'param' }>;
    expect(row('rotX').via).toBe('rot@xyz');
    expect(row('posX').via).toBeUndefined();
    expect(l.sockets['in:rot@xyz'].y).toBe(l.sockets['in:rotX'].y - ROW_H);
    // a setting with a wire of its own is not "driven by the bundle"
    const over = layoutNode({ ...b }, def, undefined, false, {}, view({ wired: ['rot@xyz', 'rotY'] }));
    const rotY = over.rows.find((r) => r.kind === 'param' && r.key === 'rotY') as Extract<Row, { kind: 'param' }>;
    expect(rotY.via).toBeUndefined();
  });

  it('a wired bundle shows even when none of its settings are on the node', () => {
    const { b, def } = setup();
    const l = layoutNode({ ...b }, def, undefined, false, {}, view({ pinned: ['size'], wired: ['rot@xyz'] }));
    expect(names(l.rows)).toEqual(['io', 'size', '[rot@xyz]', 'more']);
  });

  it('all rows shown, or a vector wire being placed: every bundle socket is on the node', () => {
    const { b, def } = setup();
    const all = layoutNode({ ...b }, def, undefined, false, {}, view({ expanded: true }));
    expect(names(all.rows)).toEqual(['io', 'size', '[pos@xyz]', 'posX', 'posY', 'posZ', '[rot@xyz]', 'rotX', 'rotY', 'rotZ', 'center', 'extra', 'more']);
    const placing = layoutNode({ ...b }, def, undefined, false, {}, view({ bundles: true }));
    expect(names(placing.rows)).toEqual(['io', 'size', '[pos@xyz]', 'posX', 'posY', 'posZ', '[rot@xyz]', 'rotX', 'rotY', 'more']);
    expect((all.rows.find((r) => r.kind === 'param' && r.key === 'center') as Extract<Row, { kind: 'param' }>).socket).toBe('vector');
  });

  it('collapsed: every socket, bundles included, sits on the header', () => {
    const { b, def } = setup();
    const l = layoutNode({ ...b, collapsed: true }, def, undefined, false, {}, view({}));
    expect(l.sockets['in:rot@xyz']).toEqual(l.sockets['in:rotX']);
  });
});

describe('bundle sockets in socket lists', () => {
  it('a vector wire dropped on a node is offered the bundles and vec2 settings, a number wire only the numbers', () => {
    const { registry, g, b, v, o, def } = setup();
    const forVec = compatibleSockets(g, registry, b.id, { node: v.id, port: 'vector' });
    expect(forVec.map((s) => `${s.port}|${s.label}|${s.group}|${s.type}`)).toEqual(['pos@xyz|Move XYZ|Object|vector', 'rot@xyz|Rotate XYZ|Parameters|vector', 'center|Center|Parameters|vector']);
    expect(forVec[0].current).toBe('0, 0, 0');
    expect(forVec[2].current).toBe('0.5, 0.5');
    const forNum = compatibleSockets(g, registry, b.id, { node: o.id, port: 'value' });
    expect(forNum.map((s) => s.port)).toEqual(['size', 'posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'extra']);
    expect(inputsAccepting(def, 'vector')).toEqual(['pos@xyz', 'rot@xyz', 'center']);
    expect(inputsAccepting(def, 'number')).toEqual(['size', 'posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'extra']);
    const wired = connect(g, registry, { node: v.id, port: 'vector' }, { node: b.id, port: 'rot@xyz' });
    expect(compatibleSockets(wired, registry, b.id, { node: v.id, port: 'vector' }).find((s) => s.port === 'rot@xyz')?.wired).toBe(true);
  });
});
