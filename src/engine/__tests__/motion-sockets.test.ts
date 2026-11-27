/**
 * The Motion socket: ONE `motion` wire (position + rotation) into every node with the standard transform params, derived like the vector
 * bundles. A Motion wire must give the same picture as the six numbers typed in; a single-param wire or a vector bundle wire wins.
 */
import { describe, expect, it } from 'vitest';
import { MOTION_PORT, Registry, canConnect, defineNode, isInputPort, paramMotion, paramSocketPorts, paramSocketType } from '../define';
import { createGraph, connectError } from '../graph';
import { registerBuiltins } from '../nodes';
import { harness } from '../testing';
import type { AnyNodeDef, GraphDoc, ImageValue, MotionValue } from '../types';

const source = defineNode({
  id: 'motion-probe',
  title: 'Motion probe',
  category: 'math',
  description: 'Test node: a fixed motion.',
  inputs: {},
  outputs: { m: { type: 'motion' } },
  params: {
    px: { type: 'number', default: 0, min: -20, max: 20 },
    py: { type: 'number', default: 0, min: -20, max: 20 },
    pz: { type: 'number', default: 0, min: -20, max: 20 },
    rx: { type: 'number', default: 0, min: -360, max: 360 },
    ry: { type: 'number', default: 0, min: -360, max: 360 },
    rz: { type: 'number', default: 0, min: -360, max: 360 },
  },
  render: (ctx) => ({ m: { kind: 'motion', pos: [ctx.params.px, ctx.params.py, ctx.params.pz], rot: [ctx.params.rx, ctx.params.ry, ctx.params.rz] } satisfies MotionValue }),
});

const T = { timeout: 180_000 };
const proj = { width: 96, height: 96, fps: 10, loop: false, duration: 1 };
type N = [id: string, type: string, params?: Record<string, unknown>];
type E = [from: string, fromPort: string, to: string, toPort: string];
const mk = (nodes: N[], edges: E[]): GraphDoc => {
  const g = createGraph('t');
  return {
    ...g,
    project: { ...g.project, ...proj },
    nodes: nodes.map(([id, type, params], i) => ({ id, type, x: i * 100, y: 0, params: params ?? {} })),
    edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
  };
};
const MOVE = { px: 0.6, py: -0.4, pz: 0.2, rx: 25, ry: 40, rz: -15 };
const typed = { posX: 0.6, posY: -0.4, posZ: 0.2, rotX: 25, rotY: 40, rotZ: -15 };
const view = { rotX: 0, rotY: 0, rotZ: 0, cameraType: 'orthographic', scale: 0.5, ambient: 1, specular: 0, ao: 0 };

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

describe('the derived Motion socket', () => {
  const registry = new Registry();
  registerBuiltins(registry);

  it('exists on nodes with Move X/Y/Z and Rotate X/Y/Z, with its own socket type', () => {
    const obj = registry.get('object-3d')!;
    expect(paramMotion(obj)).toMatchObject({ port: MOTION_PORT, label: 'Motion', scale: 'objectScale' });
    expect(paramSocketType(obj, MOTION_PORT)).toBe('motion');
    expect(isInputPort(obj, MOTION_PORT)).toBe(true);
    expect(paramSocketPorts(obj).find((s) => s.port === MOTION_PORT)?.type).toBe('motion');
    for (const id of ['sdf-shape', 'sdf-transform', 'model-3d']) expect(paramMotion(registry.get(id)!), id).not.toBeNull();
    expect(paramMotion(registry.get('blur')!)).toBeNull();
    expect(canConnect('motion', 'motion')).toBe(true);
    expect(canConnect('motion', 'vector')).toBe(false);
    expect(canConnect('vector', 'motion')).toBe(false);
  });

  it('is derived from the params only: a node that declares an input of that name keeps its own', () => {
    const def = { id: 'x', title: 'X', category: 'math', description: 'x', inputs: { [MOTION_PORT]: { type: 'number' } }, outputs: { v: { type: 'number' } }, params: Object.fromEntries(['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'].map((k) => [k, { type: 'number', default: 0 }])), render: () => ({ v: 0 }) } as unknown as AnyNodeDef;
    expect(paramMotion(def)).toBeNull();
  });

  it('a motion output only connects to a Motion socket', () => {
    const g = mk([['m', 'motion-probe'], ['o', 'object-3d'], ['b', 'blur']], []);
    const reg = new Registry();
    registerBuiltins(reg);
    reg.register(source as AnyNodeDef);
    expect(connectError(g, reg, { node: 'm', port: 'm' }, { node: 'o', port: MOTION_PORT })).toBeNull();
    expect(connectError(g, reg, { node: 'm', port: 'm' }, { node: 'o', port: 'posX' })).not.toBeNull();
    expect(connectError(g, reg, { node: 'm', port: 'm' }, { node: 'o', port: 'pos@xyz' })).not.toBeNull();
  });
});

describe('a Motion wire on the GPU', () => {
  it('moves and rotates a 3D Object exactly like the six numbers', T, async () => {
    const t = await harness([source as AnyNodeDef]);
    const shot = async (g: GraphDoc, id: string) => (await t.pixels((await t.evalGraph(g, id, { seconds: 0 })) as ImageValue)).data.slice();
    const base = { shape: 'cube', rotX: 0, rotY: 0, rotZ: 0, cameraType: 'orthographic', scale: 0.4 };
    const plain = await shot(mk([['o', 'object-3d', base]], []), 'o');
    const num = await shot(mk([['o', 'object-3d', { ...base, ...typed }]], []), 'o');
    const wire = await shot(mk([['m', 'motion-probe', MOVE], ['o', 'object-3d', base]], [['m', 'm', 'o', MOTION_PORT]]), 'o');
    expect(diff(plain, num)).toBeGreaterThan(0.5);
    expect(diff(wire, num)).toBe(0);
    // a wire on one component wins over the Motion wire for that component, whatever the order the wires were made in
    const mixed = await shot(mk([['m', 'motion-probe', MOVE], ['v', 'value', { value: 80 }], ['o', 'object-3d', base]], [['v', 'value', 'o', 'rotY'], ['m', 'm', 'o', MOTION_PORT]]), 'o');
    const want = await shot(mk([['o', 'object-3d', { ...base, ...typed, rotY: 80 }]], []), 'o');
    expect(diff(mixed, want)).toBe(0);
    expect(diff(mixed, wire)).toBeGreaterThan(0.1);
    // a vector bundle wire wins over the Motion wire for its three components
    const bundled = await shot(mk([['m', 'motion-probe', MOVE], ['v', 'vector', { x: 0, y: 70, z: 0 }], ['o', 'object-3d', base]], [['m', 'm', 'o', MOTION_PORT], ['v', 'vector', 'o', 'rot@xyz']]), 'o');
    const wantB = await shot(mk([['o', 'object-3d', { ...base, ...typed, rotX: 0, rotY: 70, rotZ: 0 }]], []), 'o');
    expect(diff(bundled, wantB)).toBe(0);
  });

  it('moves and rotates an SDF Shape exactly like the six numbers (centroid and a rotation-sensitive check)', T, async () => {
    const t = await harness([source as AnyNodeDef]);
    const shape = { shape: 'box', sizeX: 1.2, sizeY: 0.5, sizeZ: 0.5 };
    const scene = (extra: Record<string, unknown>, wired: boolean): GraphDoc =>
      mk(
        [['m', 'motion-probe', MOVE], ['s', 'sdf-shape', { ...shape, ...extra }], ['r', 'sdf-render', view]],
        [['s', 'sdf', 'r', 'scene'], ...(wired ? ([['m', 'm', 's', MOTION_PORT]] as E[]) : [])],
      );
    const get = async (g: GraphDoc) => (await t.pixels((await t.evalGraph(g, 'r', { seconds: 0, port: 'image' })) as ImageValue)).data.slice();
    const num = await get(scene(typed, false));
    const wire = await get(scene({}, true));
    const still = await get(scene({}, false));
    expect(diff(wire, num)).toBe(0);
    expect(diff(still, num)).toBeGreaterThan(0.3);
  });
});
