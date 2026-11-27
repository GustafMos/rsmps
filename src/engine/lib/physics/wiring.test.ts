import { describe, expect, it } from 'vitest';
import { Registry } from '../../define';
import { addNode, createGraph, validateGraph } from '../../graph';
import { registerBuiltins } from '../../nodes';
import { DEFAULT_BODY } from './sim';
import { bodyPorts, driveWires, drivableNodes, scatterBodies, sizeFromNode } from './wiring';

const registry = new Registry();
registerBuiltins(registry);

const graph = () => {
  let g = createGraph('t');
  const add = (type: string, params?: Record<string, unknown>) => {
    const r = addNode(g, registry, type, { x: g.nodes.length * 300, y: 0 }, params);
    g = r.graph;
    return r.node.id;
  };
  const phys = add('physics');
  const shape = add('sdf-shape', { shape: 'box', sizeX: 2, sizeY: 3, sizeZ: 4, objectScale: 0.5 });
  const obj = add('object-3d');
  const blur = add('blur');
  return { g, phys, shape, obj, blur };
};

describe('physics wiring helpers', () => {
  it('lists the nodes that have Move XYZ and not the others', () => {
    const { g, phys, shape, obj, blur } = graph();
    const ids = drivableNodes(g, registry, phys).map((d) => d.node.id);
    expect(ids).toContain(shape);
    expect(ids).toContain(obj);
    expect(ids).not.toContain(blur);
    expect(ids).not.toContain(phys);
  });

  it('drives a node: Position to Move XYZ and Rotation to Rotate XYZ, and the graph stays valid', () => {
    const { g, phys, shape } = graph();
    const next = driveWires(g, registry, phys, 2, shape);
    const into = next.edges.filter((e) => e.to.node === shape).map((e) => `${e.from.node}.${e.from.port}>${e.to.port}`);
    expect(into.sort()).toEqual([`${phys}.pos3>pos@xyz`, `${phys}.rot3>rot@xyz`]);
    expect(validateGraph(next, registry)).toEqual([]);
  });

  it('bodies after the eighth go through the extra body outputs and set which body that is', () => {
    const { g, phys, shape } = graph();
    expect(bodyPorts(8)).toEqual({ pos: 'posExtra', rot: 'rotExtra', extra: true });
    const next = driveWires(g, registry, phys, 11, shape);
    expect(next.nodes.find((n) => n.id === phys)!.params.extraBody).toBe(12);
    expect(next.edges.some((e) => e.from.port === 'posExtra' && e.to.port === 'pos@xyz')).toBe(true);
  });

  it('copies the size of an SDF Shape to a collider (Scale included) and says nothing for shapes with no clear match', () => {
    const { g, shape } = graph();
    const n = g.nodes.find((x) => x.id === shape)!;
    expect(sizeFromNode(n)).toEqual({ shape: 'box', size: [1, 1.5, 2] });
    expect(sizeFromNode({ ...n, params: { shape: 'sphere', radius: 0.8 } })).toEqual({ shape: 'sphere', size: [0.8, 1, 1] });
    expect(sizeFromNode({ ...n, params: { shape: 'capsule', radius: 0.3, sizeY: 1.2 } })).toEqual({ shape: 'capsule', size: [0.3, 1.2, 1] });
    expect(sizeFromNode({ ...n, params: { shape: 'torus' } })).toBeNull();
    expect(sizeFromNode({ ...n, type: 'object-3d' })).toBeNull();
  });

  it('scatter is repeatable for a seed, differs between seeds and stops at 16 bodies', () => {
    const a = scatterBodies([DEFAULT_BODY], DEFAULT_BODY, { count: 5, seed: 3, spread: 2, low: 1, high: 5 });
    const b = scatterBodies([DEFAULT_BODY], DEFAULT_BODY, { count: 5, seed: 3, spread: 2, low: 1, high: 5 });
    const c = scatterBodies([DEFAULT_BODY], DEFAULT_BODY, { count: 5, seed: 4, spread: 2, low: 1, high: 5 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(6);
    for (const x of a.slice(1)) {
      expect(Math.abs(x.pos[0])).toBeLessThanOrEqual(2);
      expect(x.pos[1]).toBeGreaterThanOrEqual(1);
      expect(x.pos[1]).toBeLessThanOrEqual(5);
    }
    expect(scatterBodies(a, DEFAULT_BODY, { count: 50, seed: 1, spread: 2, low: 1, high: 5 }).length).toBe(16);
  });
});
