/**
 * Vector sockets: one wire that carries X, Y and Z, and the bundled param sockets derived from `<stem>X` / `<stem>Y` / `<stem>Z`
 * number params (docs/ENGINE.md, "Vector sockets"). The single-number sockets must keep working exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { BUNDLE_SUFFIX, Registry, defineNode, isInputPort, paramBundle, paramBundles, paramSocketPorts, paramSocketType } from '../define';
import { addNode, connect, connectError, createGraph, inputType, validateGraph } from '../graph';
import { registerBuiltins } from '../nodes';
import { harness, type Harness } from '../testing';
import type { AnyNodeDef, GraphDoc, ImageValue, VectorValue } from '../types';

/** A node that reports its resolved params, so tests can read what a wire did to them (clamping, rounding, px). */
const probe = defineNode({
  id: 'vector-probe',
  title: 'Vector probe',
  category: 'math',
  description: 'Test node: reports its params.',
  inputs: { image: { type: 'image' } },
  outputs: { a: { type: 'vector' }, len: { type: 'vector' }, spot: { type: 'vector' }, pad: { type: 'vector' } },
  params: {
    countX: { type: 'number', default: 1, min: 0, max: 10, integer: true, label: 'Count X' },
    countY: { type: 'number', default: 1, min: 0, max: 10, integer: true, label: 'Count Y' },
    countZ: { type: 'number', default: 1, min: 0, max: 10, integer: true, label: 'Count Z' },
    lenX: { type: 'number', default: 5, min: 0, max: 100, unit: 'px', label: 'Columns' },
    lenY: { type: 'number', default: 5, min: 0, max: 100, unit: 'px', label: 'Rows' },
    spot: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, label: 'Spot' },
    pad: { type: 'vec2', default: [4, 4], min: -8, max: 8, unit: 'px', label: 'Pad' },
  },
  render(ctx) {
    const p = ctx.params;
    return { a: [p.countX, p.countY, p.countZ], len: [p.lenX, p.lenY, 0], spot: [p.spot[0], p.spot[1], 0], pad: [p.pad[0], p.pad[1], 0] };
  },
});

const stubDef = (params: Record<string, unknown>, inputs: Record<string, unknown> = {}): AnyNodeDef =>
  ({ id: 'stub', title: 'Stub', category: 'math', description: 'x', inputs, outputs: { value: { type: 'number' } }, params, render: () => ({ value: 0 }) }) as never;
const num = (label?: string) => ({ type: 'number', default: 0, ...(label ? { label } : {}) });

describe('paramBundles (the derivation)', () => {
  it('bundles <stem>X / <stem>Y / <stem>Z number params, with or without Z', () => {
    const def = stubDef({ posX: num('Move X'), posY: num('Move Y'), posZ: num('Move Z'), shiftX: num('Shift X per echo'), shiftY: num('Shift Y per echo'), amount: num() });
    expect(paramBundles(def)).toEqual([
      { port: 'pos@xyz', stem: 'pos', label: 'Move', members: ['posX', 'posY', 'posZ'] },
      { port: 'shift@xyz', stem: 'shift', label: 'Shift per echo', members: ['shiftX', 'shiftY'] },
    ]);
    expect(paramBundle(def, 'pos@xyz')?.members).toEqual(['posX', 'posY', 'posZ']);
    expect(paramBundle(def, 'amount')).toBeNull();
    expect(paramBundle(def, 'nope@xyz')).toBeNull();
  });

  it('plain x / y (/ z) params are a bundle too', () => {
    const def = stubDef({ x: num('Position X'), y: num('Position Y'), size: num() });
    expect(paramBundles(def)).toEqual([{ port: '@xyz', stem: '', label: 'Position', members: ['x', 'y'] }]);
    expect(paramBundles(stubDef({ x: num('X'), y: num('Y'), z: num('Z') }))[0]).toMatchObject({ port: '@xyz', label: 'Vector', members: ['x', 'y', 'z'] });
  });

  it('needs X and Y, both numbers; a lone X, an X without capital, or a non-number is no bundle', () => {
    expect(paramBundles(stubDef({ gainX: num(), gainZ: num() }))).toEqual([]);
    expect(paramBundles(stubDef({ inMax: num(), inMay: num() }))).toEqual([]);
    expect(paramBundles(stubDef({ flipX: { type: 'bool', default: false }, flipY: { type: 'bool', default: false } }))).toEqual([]);
    expect(paramBundles(stubDef({ boxX: num(), boxY: { type: 'bool', default: false } }))).toEqual([]);
    // Z alone does not join when it is not a number
    expect(paramBundles(stubDef({ boxX: num(), boxY: num(), boxZ: { type: 'bool', default: false } }))[0].members).toEqual(['boxX', 'boxY']);
  });

  it('labels: what the member labels share, else the stem in words', () => {
    const label = (params: Record<string, unknown>) => paramBundles(stubDef(params))[0].label;
    expect(label({ redX: num('Red shift X'), redY: num('Red shift Y') })).toBe('Red shift');
    expect(label({ gridX: num('Columns'), gridY: num('Rows'), gridZ: num('Layers') })).toBe('Grid');
    expect(label({ cropSizeX: num('Box half width'), cropSizeY: num('Box half height') })).toBe('Crop size');
    expect(label({ rotX: num(), rotY: num() })).toBe('Rot');
  });

  it('paramSocketType / paramSocketPorts / isInputPort know bundles and vec2 params', () => {
    const def = stubDef({ mode: { type: 'enum', default: 'a', options: [{ value: 'a', label: 'A' }] }, posX: num(), posY: num(), center: { type: 'vec2', default: [0, 0] }, tint: { type: 'color', default: [1, 1, 1, 1] } }, { image: { type: 'image' } });
    expect(paramSocketType(def, 'pos@xyz')).toBe('vector');
    expect(paramSocketType(def, 'center')).toBe('vector');
    expect(paramSocketType(def, 'posX')).toBe('number');
    expect(paramSocketType(def, 'mode')).toBeNull();
    expect(paramSocketType(def, 'other@xyz')).toBeNull();
    expect(paramSocketPorts(def).map((s) => `${s.port}:${s.type}`)).toEqual(['pos@xyz:vector', 'posX:number', 'posY:number', 'center:vector', 'tint:color']);
    expect(isInputPort(def, 'image') && isInputPort(def, 'posX') && isInputPort(def, 'pos@xyz')).toBe(true);
    expect(isInputPort(def, 'spin@xyz')).toBe(false);
  });

  it('no bundle port collides with a param, an input or another bundle on any registered node', () => {
    const registry = new Registry();
    registerBuiltins(registry);
    let bundles = 0;
    for (const def of registry.list()) {
      const names = [...Object.keys(def.params), ...Object.keys(def.inputs)];
      // the separator never appears in a real port name, so a bundle port cannot be mistaken for one
      expect(names.filter((n) => n.includes('@')), def.id).toEqual([]);
      const ports = paramBundles(def).map((b) => b.port);
      expect(new Set(ports).size, def.id).toBe(ports.length);
      for (const b of paramBundles(def)) {
        bundles++;
        expect(b.port.endsWith(BUNDLE_SUFFIX), def.id).toBe(true);
        expect(names, def.id).not.toContain(b.port);
        expect(b.label.length, `${def.id} ${b.port}`).toBeGreaterThan(0);
        expect(b.label.length, `${def.id} ${b.port} "${b.label}"`).toBeLessThanOrEqual(18);
        for (const k of b.members) expect(def.params[k].type, `${def.id} ${k}`).toBe('number');
      }
    }
    expect(bundles).toBeGreaterThan(20);
    // the 3D transform every 3D node shares
    const obj = registry.get('object-3d')!;
    expect(paramBundles(obj).map((b) => `${b.port}=${b.label}`)).toEqual(expect.arrayContaining(['pos@xyz=Move', 'rot@xyz=Rotate', 'spin@xyz=Spin', '@xyz=Frame']));
  });
});

/** A graph with one node of `type` and, per entry of `wires`, a source node wired into that port. */
function build(t: Harness, type: string, params: Record<string, unknown>, wires: Record<string, VectorValue | number>, project: Record<string, unknown> = {}): { graph: GraphDoc; id: string } {
  let g = createGraph('t');
  g.project = { ...g.project, width: 96, height: 96, fps: 10, duration: 1, ...project };
  const main = addNode(g, t.registry, type, { x: 0, y: 0 }, params);
  g = main.graph;
  for (const [port, v] of Object.entries(wires)) {
    const src = typeof v === 'number' ? addNode(g, t.registry, 'value', { x: 0, y: 0 }, { value: v }) : addNode(g, t.registry, 'vector', { x: 0, y: 0 }, { x: v[0], y: v[1], z: v[2] });
    g = connect(src.graph, t.registry, { node: src.node.id, port: Object.keys(t.registry.get(src.node.type)!.outputs)[0] }, { node: main.node.id, port });
  }
  return { graph: g, id: main.node.id };
}

/** The picture of a node as plain bytes, read at once: a texture handed out by an evaluation is only good until the next one. */
async function shot(t: Harness, graph: GraphDoc, id: string, seconds = 0): Promise<Uint8ClampedArray> {
  const px = await t.pixels((await t.evalGraph(graph, id, { seconds })) as ImageValue);
  return px.data.slice();
}
/** Mean absolute difference per channel (0..255). */
function differ(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  expect(a.length).toBe(b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

describe('a vector wire on a bundle socket', () => {
  it('gives the same picture as three number wires, and as the same numbers typed in', async () => {
    const t = await harness();
    const render = async (params: Record<string, unknown>, wires: Record<string, VectorValue | number>) => {
      const b = build(t, 'object-3d', params, wires);
      expect(validateGraph(b.graph, t.registry)).toEqual([]);
      return shot(t, b.graph, b.id);
    };
    const plain = await render({}, {});
    const typed = await render({ rotX: 25, rotY: 40, rotZ: -15 }, {});
    const three = await render({}, { rotX: 25, rotY: 40, rotZ: -15 });
    const one = await render({}, { 'rot@xyz': [25, 40, -15] });
    expect(differ(plain, typed)).toBeGreaterThan(0.5); // the rotation shows
    expect(differ(three, typed)).toBe(0); // number wires as before
    expect(differ(one, three)).toBe(0); // one wire = three wires
    // position too, and both bundles at once
    const moved = await render({ posX: 0.3, posY: -0.2, posZ: 0.1, rotX: 25, rotY: 40, rotZ: -15 }, {});
    const both = await render({}, { 'pos@xyz': [0.3, -0.2, 0.1], 'rot@xyz': [25, 40, -15] });
    expect(differ(moved, typed)).toBeGreaterThan(0.1);
    expect(differ(both, moved)).toBe(0);
  });

  it('a wire on one component wins over the bundle for that component', async () => {
    const t = await harness();
    const render = async (params: Record<string, unknown>, wires: Record<string, VectorValue | number>) => {
      const b = build(t, 'object-3d', params, wires);
      return shot(t, b.graph, b.id);
    };
    const mixed = await render({}, { 'rot@xyz': [25, 40, -15], rotY: 80 });
    const want = await render({ rotX: 25, rotY: 80, rotZ: -15 }, {});
    const bundleOnly = await render({ rotX: 25, rotY: 40, rotZ: -15 }, {});
    expect(differ(mixed, want)).toBe(0);
    expect(differ(mixed, bundleOnly)).toBeGreaterThan(0.1);
    // the order the wires were made in does not matter
    const other = await render({}, { rotY: 80, 'rot@xyz': [25, 40, -15] });
    expect(differ(other, want)).toBe(0);
  });

  it('clamps, rounds and converts px exactly like a single number wire; stored values of the members are ignored', async () => {
    const t = await harness([probe as never]);
    const read = async (wires: Record<string, VectorValue | number>, params: Record<string, unknown> = {}, port = 'a') => {
      const b = build(t, 'vector-probe', params, wires);
      const img = addNode(b.graph, t.registry, t.source(t.solid(8, 8, [0, 0, 0, 255], 2)));
      const g = connect(img.graph, t.registry, { node: img.node.id, port: 'out' }, { node: b.id, port: 'image' });
      return (await t.evalGraph(g, b.id, { port })) as VectorValue;
    };
    // integer + min / max
    expect(await read({ 'count@xyz': [2.6, 99, -4] }, { countX: 7, countY: 7, countZ: 7 })).toEqual([3, 10, 0]);
    expect(await read({ countX: 2.6, countY: 99, countZ: -4 })).toEqual([3, 10, 0]);
    // px: the reference image has unit 2, so lengths double; a two-member bundle ignores z
    expect(await read({ 'len@xyz': [3, 250, 77] }, {}, 'len')).toEqual([6, 200, 0]);
    expect(await read({ lenX: 3, lenY: 250 }, {}, 'len')).toEqual([6, 200, 0]);
    // override of one member
    expect(await read({ 'count@xyz': [2, 4, 6], countZ: 9 })).toEqual([2, 4, 9]);
    // nothing wired: the stored values
    expect(await read({}, { countX: 7, countY: 8, countZ: 9 })).toEqual([7, 8, 9]);
  });

  it('a vec2 param takes a vector wire (x, y), held to its min / max and converted from px', async () => {
    const t = await harness([probe as never]);
    const read = async (wires: Record<string, VectorValue | number>, port: string) => {
      const b = build(t, 'vector-probe', {}, wires);
      const img = addNode(b.graph, t.registry, t.source(t.solid(8, 8, [0, 0, 0, 255], 2)));
      const g = connect(img.graph, t.registry, { node: img.node.id, port: 'out' }, { node: b.id, port: 'image' });
      return (await t.evalGraph(g, b.id, { port })) as VectorValue;
    };
    expect(await read({ spot: [0.25, 3, 9] }, 'spot')).toEqual([0.25, 1, 0]);
    expect(await read({ pad: [3, -20, 0] }, 'pad')).toEqual([6, -16, 0]);
    expect(await read({}, 'pad')).toEqual([8, 8, 0]);
  });

  it('a real vec2 param: Gradient center driven by a vector equals the typed value', async () => {
    const t = await harness();
    const def = t.registry.get('gradient')!;
    expect(paramSocketType(def, 'center')).toBe('vector');
    const render = async (params: Record<string, unknown>, wires: Record<string, VectorValue | number>) => {
      const b = build(t, 'gradient', { kind: 'radial', ...params }, wires);
      return shot(t, b.graph, b.id);
    };
    const centred = await render({}, {});
    const typed = await render({ center: [0.2, 0.7] }, {});
    const wired = await render({}, { center: [0.2, 0.7, 5] });
    expect(differ(typed, centred)).toBeGreaterThan(0.5);
    expect(differ(wired, typed)).toBe(0);
  });

  it('a moving vector moves the node, and the wire types are checked', async () => {
    const t = await harness();
    let g = createGraph('t');
    g.project = { ...g.project, width: 96, height: 96, fps: 10, duration: 2 };
    const anim = addNode(g, t.registry, 'animate', { x: 0, y: 0 }, { from: 0, to: 140 });
    const comb = addNode(anim.graph, t.registry, 'combine-xyz', { x: 0, y: 0 }, { x: 20 });
    const cube = addNode(comb.graph, t.registry, 'object-3d');
    g = connect(cube.graph, t.registry, { node: anim.node.id, port: 'value' }, { node: comb.node.id, port: 'y' });
    // number -> bundle and vector -> number are refused; vector -> bundle is fine
    expect(connectError(g, t.registry, { node: anim.node.id, port: 'value' }, { node: cube.node.id, port: 'rot@xyz' })).toMatch(/Cannot connect number to vector/);
    expect(connectError(g, t.registry, { node: comb.node.id, port: 'vector' }, { node: cube.node.id, port: 'rotY' })).toMatch(/Cannot connect vector to number/);
    expect(connectError(g, t.registry, { node: comb.node.id, port: 'vector' }, { node: cube.node.id, port: 'nope@xyz' })).toBe('No such input');
    g = connect(g, t.registry, { node: comb.node.id, port: 'vector' }, { node: cube.node.id, port: 'rot@xyz' });
    expect(inputType(g, t.registry, cube.node.id, 'rot@xyz')).toEqual({ type: 'vector', multi: false });
    expect(validateGraph(g, t.registry)).toEqual([]);
    expect(differ(await shot(t, g, cube.node.id, 0), await shot(t, g, cube.node.id, 0.5))).toBeGreaterThan(0.5);
    // a second wire into the same bundle replaces the first (single-wire socket)
    const v2 = addNode(g, t.registry, 'vector');
    const g2 = connect(v2.graph, t.registry, { node: v2.node.id, port: 'vector' }, { node: cube.node.id, port: 'rot@xyz' });
    expect(g2.edges.filter((e) => e.to.port === 'rot@xyz')).toHaveLength(1);
  });
});

describe('documents made before vector sockets', () => {
  it('load, validate and render as they did: number wires into rotX / rotY / rotZ, stored params, no bundle anywhere', async () => {
    const t = await harness();
    // written by hand in the saved-document shape (ids, ports and params as an old project has them)
    const doc: GraphDoc = {
      schema: 'rsmps/graph',
      version: 2,
      name: 'old',
      project: { ...createGraph().project, width: 96, height: 96, fps: 10, duration: 1 },
      nodes: [
        { id: 'a', type: 'value', x: 0, y: 0, params: { value: 30 } },
        { id: 'b', type: 'value', x: 0, y: 0, params: { value: 55 } },
        { id: 'cube', type: 'object-3d', x: 0, y: 0, params: { rotX: 5, rotY: 5, rotZ: 12, posX: 0.2 } },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'value' }, to: { node: 'cube', port: 'rotX' } },
        { id: 'e2', from: { node: 'b', port: 'value' }, to: { node: 'cube', port: 'rotY' } },
      ],
      frames: [],
    };
    const copy = JSON.parse(JSON.stringify(doc)) as GraphDoc;
    expect(validateGraph(copy, t.registry)).toEqual([]);
    const old = await shot(t, copy, 'cube');
    const typed = build(t, 'object-3d', { rotX: 30, rotY: 55, rotZ: 12, posX: 0.2 }, {});
    expect(differ(old, await shot(t, typed.graph, typed.id))).toBe(0);
    const unwired = build(t, 'object-3d', { rotX: 5, rotY: 5, rotZ: 12, posX: 0.2 }, {});
    expect(differ(old, await shot(t, unwired.graph, unwired.id))).toBeGreaterThan(0.1); // the wires do drive it
    // the same look through the new socket
    const bundled = build(t, 'object-3d', { posX: 0.2 }, { 'rot@xyz': [30, 55, 12] });
    expect(differ(old, await shot(t, bundled.graph, bundled.id))).toBe(0);
  });
});

describe('vector nodes', () => {
  it('Combine XYZ -> Separate XYZ gives the numbers back; Vector scales its three numbers', async () => {
    const t = await harness();
    let g = createGraph('t');
    const comb = addNode(g, t.registry, 'combine-xyz', { x: 0, y: 0 }, { x: 1.5, y: -2, z: 7 });
    const sep = addNode(comb.graph, t.registry, 'separate-xyz');
    g = connect(sep.graph, t.registry, { node: comb.node.id, port: 'vector' }, { node: sep.node.id, port: 'vector' });
    expect(await t.evalGraph(g, comb.node.id, { port: 'vector' })).toEqual([1.5, -2, 7]);
    expect(await t.evalGraph(g, sep.node.id, { port: 'x' })).toBe(1.5);
    expect(await t.evalGraph(g, sep.node.id, { port: 'y' })).toBe(-2);
    expect(await t.evalGraph(g, sep.node.id, { port: 'z' })).toBe(7);
    expect((await t.run('vector', { x: 1, y: 2, z: 3, amount: 2 })).vector).toEqual([2, 4, 6]);
    // their own x / y / z are a bundle as well: a vector in, one number replaced
    const b = build(t, 'combine-xyz', {}, { '@xyz': [1, 2, 3], y: 9 });
    expect(await t.evalGraph(b.graph, b.id, { port: 'vector' })).toEqual([1, 9, 3]);
  });

  it('Motion Path and Region Info also give their position bundled', async () => {
    const t = await harness();
    const path = await t.run('keyframes-xy', {}, {}, { seconds: 0.3 });
    expect(path.position).toEqual([path.x, path.y, 0]);
    expect(Object.keys(t.registry.get('phone-motion')!.outputs)).toEqual(expect.arrayContaining(['objX', 'posZ', 'rotation', 'rate', 'acceleration', 'position']));
    expect(Object.keys(t.registry.get('region-info')!.outputs)).toEqual(expect.arrayContaining(['x', 'y', 'center', 'size']));
  });

  it('Delay Number and Smooth take a vector as well as a number', async () => {
    const t = await harness();
    const graph = (type: string, params: Record<string, unknown>) => {
      let g = createGraph('t');
      g.project = { ...g.project, fps: 10, duration: 4, loop: false };
      const anim = addNode(g, t.registry, 'animate', { x: 0, y: 0 }, { from: 0, to: 100, wave: 'saw' });
      const comb = addNode(anim.graph, t.registry, 'combine-xyz', { x: 0, y: 0 }, { y: 5 });
      const fx = addNode(comb.graph, t.registry, type, { x: 0, y: 0 }, params);
      g = connect(fx.graph, t.registry, { node: anim.node.id, port: 'value' }, { node: comb.node.id, port: 'x' });
      g = connect(g, t.registry, { node: comb.node.id, port: 'vector' }, { node: fx.node.id, port: 'vector' });
      g = connect(g, t.registry, { node: anim.node.id, port: 'value' }, { node: fx.node.id, port: 'value' });
      return { g, fx: fx.node.id, comb: comb.node.id };
    };
    const d = graph('delay-value', { amount: 5, units: 'frames', loopAware: false });
    const then = (await t.evalGraph(d.g, d.comb, { seconds: 1.5, port: 'vector' })) as VectorValue;
    const now = (await t.evalGraph(d.g, d.comb, { seconds: 2, port: 'vector' })) as VectorValue;
    expect(now[0]).not.toBe(then[0]);
    expect(await t.evalGraph(d.g, d.fx, { seconds: 2, port: 'vector' })).toEqual(then);
    expect(await t.evalGraph(d.g, d.fx, { seconds: 2, port: 'value' })).toBe(then[0]);

    const s = graph('smooth', { mode: 'linear', time: 1, loopAware: false });
    const sv = (await t.evalGraph(s.g, s.fx, { seconds: 2, port: 'vector' })) as VectorValue;
    const sn = (await t.evalGraph(s.g, s.fx, { seconds: 2, port: 'value' })) as number;
    expect(sv[0]).toBeCloseTo(sn, 9); // each number of the vector is smoothed like a number
    expect(sv[0]).toBeLessThan(now[0]); // it lags a rising value
    expect(sv[1]).toBe(5);
    expect(sv[2]).toBe(0);
  });
});
