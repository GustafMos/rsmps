import { describe, expect, it } from 'vitest';
import { Registry } from '../define';
import { registerBuiltins } from '../nodes';
import { createGraph } from '../graph';
import { GROUP_IN, groupData } from '../group';
import { applySdfConversion, convertSdf3dToScene } from './sdf-convert';
import type { Edge, GraphDoc, NodeInstance } from '../types';

const registry = new Registry();
registerBuiltins(registry);
const conv = (params: Record<string, unknown>, wired: string[] = []) => {
  const r = convertSdf3dToScene(registry, { params, wired: new Set(wired) });
  return { ...r, d: groupData({ params: r.params }) };
};
const node = (d: ReturnType<typeof conv>['d'], id: string) => d.nodes.find((n) => n.id === id)!;
const off = (from: number) => Object.fromEntries(Array.from({ length: 9 - from }, (_, i) => [`shape${from + i}`, 'off']));

describe('convert SDF 3D to SDF Scene: shapes', () => {
  it('every shape kind maps its size, position, rotation and colour', () => {
    const kinds = ['sphere', 'box', 'rbox', 'torus', 'capsule', 'cylinder', 'cone', 'octa'];
    const params: Record<string, unknown> = { ...off(9) };
    kinds.forEach((k, i) => Object.assign(params, { [`shape${i + 1}`]: k, [`x${i + 1}`]: i * 0.5, [`y${i + 1}`]: 0 - i, [`z${i + 1}`]: 0.25, [`rx${i + 1}`]: 10, [`ry${i + 1}`]: 20, [`rz${i + 1}`]: 30, [`size${i + 1}`]: 0.6, [`sizeB${i + 1}`]: 0.3, [`sizeC${i + 1}`]: 0.2, [`color${i + 1}`]: [i / 10, 0.5, 0.25, 1] }));
    const { d } = conv(params);
    const p = (n: number) => node(d, `shape${n}`).params;
    expect(p(1)).toMatchObject({ shape: 'sphere', radius: 0.6, posX: 0, posY: 0, posZ: 0.25, rotX: 0, rotY: 0, rotZ: 0 }); // a sphere has no rotation
    expect(p(2)).toMatchObject({ shape: 'box', sizeX: 1.2, sizeY: 0.6, sizeZ: 0.4, rotX: 10, rotY: 20, rotZ: 30, posX: 0.5, posY: -1 });
    expect(p(3)).toMatchObject({ shape: 'rbox', sizeX: 1.2, sizeY: 0.6, sizeZ: 0.4 });
    expect(p(4)).toMatchObject({ shape: 'torus', radius: 0.6, tube: 0.3 });
    expect(p(5)).toMatchObject({ shape: 'capsule', radius: 0.6, sizeY: 0.6 });
    expect(p(6)).toMatchObject({ shape: 'cylinder', radius: 0.6, sizeY: 0.6 });
    expect(p(7)).toMatchObject({ shape: 'cone', radius: 0.6, sizeY: 0.6 });
    expect(p(8)).toMatchObject({ shape: 'octa', radius: 0.6 });
    expect(p(8).color).toEqual([0.7, 0.5, 0.25, 1]);
  });

  it('a plane keeps its place; a 2D picture shape needs the picture and takes the group input', () => {
    const a = conv({ shape1: 'plane', y1: -0.8, ...off(2) });
    expect(node(a.d, 'shape1').params).toMatchObject({ shape: 'plane', posY: -0.8 });
    const withoutPic = conv({ shape1: 'sphere', shape2: 'image2d', ...off(3) });
    expect(withoutPic.d.nodes.some((n) => n.id === 'shape2')).toBe(false);
    expect(withoutPic.notes.join(' ')).toContain('Shape 2 is a 2D picture but no picture is wired');
    const withPic = conv({ shape1: 'image2d', size1: 0.5, sizeB1: 0.1, ...off(2) }, ['shape2d']);
    expect(node(withPic.d, 'shape1').params).toMatchObject({ shape: 'image2d', sizeX: 1, sizeZ: 0.2 });
    expect(withPic.portMap.shape2d).toBe('picture');
    expect(withPic.d.inputs.map((i) => i.id)).toContain('picture');
    expect(withPic.d.edges.some((e) => e.from.node === GROUP_IN && e.from.port === 'picture' && e.to.node === 'shape1' && e.to.port === 'picture')).toBe(true);
  });

  it('off slots are skipped and the first drawn shape needs no combine', () => {
    const { d } = conv({ shape1: 'off', shape2: 'box', shape3: 'off', ...off(4) });
    expect(d.nodes.map((n) => n.id)).toEqual(['shape2', 'render']);
  });
});

describe('convert SDF 3D to SDF Scene: the combine chain', () => {
  const three = { shape1: 'sphere', shape2: 'box', shape3: 'sphere', shape4: 'sphere', ...off(5) };
  const combines = (d: ReturnType<typeof conv>['d']) => d.nodes.filter((n) => n.type === 'sdf-combine');
  const inputsOf = (d: ReturnType<typeof conv>['d'], id: string) => d.edges.filter((e) => e.to.node === id && e.to.port === 'items').map((e) => e.from.node);

  it('keeps the order, the operator and the smoothness times Gooeyness of every slot', () => {
    const { d } = conv({ ...three, op2: 'subtract', smooth2: 0.4, op3: 'intersect', smooth3: 0.2, op4: 'union', smooth4: 0.5, gooey: 2 });
    const c = combines(d);
    expect(c.map((n) => [n.params.operation, n.params.smoothness])).toEqual([['subtract', 0.8], ['intersect', 0.4], ['union', 1]]);
    expect(inputsOf(d, 'combine1')).toEqual(['shape1', 'shape2']);
    expect(inputsOf(d, 'combine2')).toEqual(['combine1', 'shape3']);
    expect(inputsOf(d, 'combine3')).toEqual(['combine2', 'shape4']);
    expect(d.edges.find((e) => e.to.node === 'render' && e.to.port === 'scene')!.from.node).toBe('combine3');
  });

  it('Gooeyness 0 makes every join hard, and neighbouring hard joins of one operator share a Combine', () => {
    const { d } = conv({ ...three, op2: 'union', smooth2: 0.5, op3: 'union', smooth3: 0.5, op4: 'subtract', smooth4: 0.5, gooey: 0 });
    const c = combines(d);
    expect(c.map((n) => [n.params.operation, n.params.smoothness])).toEqual([['union', 0], ['subtract', 0]]);
    expect(inputsOf(d, 'combine1')).toEqual(['shape1', 'shape2', 'shape3']);
    expect(inputsOf(d, 'combine2')).toEqual(['combine1', 'shape4']);
  });

  it('smooth joins stay a pairwise chain even with the same operator and amount', () => {
    const { d } = conv({ ...three, smooth2: 0.5, smooth3: 0.5, smooth4: 0.5 });
    expect(combines(d)).toHaveLength(3);
    expect(combines(d).every((n) => n.params.smoothness === 0.5)).toBe(true);
  });

  it('a blend wider than a Combine allows is limited and said so', () => {
    const { d, notes } = conv({ shape1: 'sphere', shape2: 'sphere', ...off(3), smooth2: 3, gooey: 4 });
    expect(combines(d)[0].params.smoothness).toBe(3);
    expect(notes.join(' ')).toContain('3 at most');
  });

  it('Morph keeps both shapes as separate parts and says so', () => {
    const { d, notes } = conv({ ...three, shape3: 'off', shape4: 'off', morph: true, op2: 'subtract', smooth2: 0.3 });
    expect(combines(d)[0].params).toMatchObject({ operation: 'union', smoothness: 0.3 });
    expect(notes[0]).toContain('Morph between shape 1 and 2 is not available in an SDF Scene yet; both shapes were kept as separate parts');
  });
});

describe('convert SDF 3D to SDF Scene: space options, settings and notes', () => {
  const mods = (d: ReturnType<typeof conv>['d']) => d.nodes.filter((n) => n.type === 'sdf-modify').map((n) => [n.id, n.params] as const);
  it('Mirror, Shell, Twist, Bend and Inflate become Modify nodes in the order SDF 3D applies them', () => {
    const { d, notes } = conv({ shape1: 'sphere', ...off(2), mirrorX: true, mirrorZ: true, shell: 0.05, dTwist: 90, dBend: Math.PI / 2, dInflate: 0.1 });
    expect(mods(d).map(([id]) => id)).toEqual(['round', 'shell', 'bend', 'twist', 'mirror']);
    const by = Object.fromEntries(mods(d));
    expect(by.mirror).toMatchObject({ modifier: 'mirror', mirrorX: true, mirrorY: false, mirrorZ: true });
    expect(by.shell).toMatchObject({ modifier: 'shell', thickness: 0.05 });
    expect(by.twist).toMatchObject({ modifier: 'twist', axis: 'y', twistAmount: -90 });
    expect(by.bend).toMatchObject({ modifier: 'bend', axis: 'x', bendAmount: 90 });
    expect(by.round).toMatchObject({ modifier: 'round', roundAmount: 0.1 });
    // a chain from the shape to the Scene Output
    expect(d.edges.filter((e) => e.to.port === 'scene').map((e) => `${e.from.node}>${e.to.node}`)).toEqual(['shape1>round', 'round>shell', 'shell>bend', 'bend>twist', 'twist>mirror', 'mirror>render']);
    expect(notes).toEqual([]);
  });

  it('endless Repeat becomes a limited number of copies and says so', () => {
    const { d, notes } = conv({ shape1: 'sphere', ...off(2), repeatX: true, repeatZ: true, repeatSpacing: 2 });
    expect(Object.fromEntries(mods(d)).repeat).toMatchObject({ modifier: 'repeat', countX: 9, countY: 1, countZ: 9, spacingX: 2, spacingZ: 2 });
    expect(notes.join(' ')).toContain('9 copies');
  });

  it('Noise displace is approximated and says so', () => {
    const { d, notes } = conv({ shape1: 'sphere', ...off(2), dNoise: 0.2, dNoiseScale: 3 });
    expect(Object.fromEntries(mods(d)).displace).toMatchObject({ modifier: 'displace', displaceAmount: 0.2, noiseScale: 3 });
    expect(notes.join(' ')).toContain('approximated');
  });

  it('camera, spin, light, quality and the scene move go to the group settings; an old node spins the old way', () => {
    const { params } = conv({ shape1: 'sphere', ...off(2), fov: 44, rotY: 77, posX: 0.4, objectScale: 1.2, spinY: 2, quality: 'high', ao: 0.7, shadows: false });
    expect(params).toMatchObject({ fov: 44, rotY: 77, posX: 0.4, objectScale: 1.2, spinY: 2, quality: 'high', ao: 0.7, shadows: false, spinAround: 'scene' });
    expect(conv({ shape1: 'sphere', ...off(2), spinAround: 'own' }).params.spinAround).toBe('own');
  });

  it('features with no equivalent are listed in plain words', () => {
    const { notes } = conv({ shape1: 'sphere', ...off(2), fold: 6, dTaper: 0.3, dMelt: 0.2, dExplode: 0.2, dLowFi: 8, dMorph: 0.5, dInflate: -0.1 }, ['texture', 'displaceMap']);
    const text = notes.join('\n');
    for (const w of ['Kaleidoscope', 'Texture', 'Displace map', 'Taper', 'Melt', 'Explode', 'Low-fi snap', 'Morph to sphere', 'negative amount']) expect(text, w).toContain(w);
    expect(notes.every((n) => n.length > 20 && !n.includes('`'))).toBe(true);
  });

  it('the layout is deterministic: shapes in a column, combines left to right, modifiers after, Scene Output last', () => {
    const params = { shape1: 'sphere', shape2: 'box', shape3: 'torus', ...off(4), shell: 0.05, mirrorX: true };
    const a = conv(params);
    expect(JSON.stringify(conv(params).params)).toBe(JSON.stringify(a.params));
    const at = (id: string) => node(a.d, id);
    expect([at('shape1').x, at('shape2').x, at('shape3').x]).toEqual([40, 40, 40]);
    expect(at('shape1').y).toBeLessThan(at('shape2').y);
    expect(at('shape2').y).toBeLessThan(at('shape3').y);
    const xs = ['combine1', 'combine2', 'shell', 'mirror', 'render'].map((id) => at(id).x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    expect(new Set(xs).size).toBe(xs.length);
    expect(xs[0]).toBeGreaterThan(at('shape1').x);
  });
});

describe('convert SDF 3D to SDF Scene: wires', () => {
  const params = { shape1: 'sphere', shape2: 'torus', shape3: 'box', ...off(4) };
  it('camera, material, size and scene settings keep their name; slot numbers get a group input on that shape', () => {
    const r = conv(params, ['camera', 'material', 'size', 'posX', 'x1', 'y2', 'size1', 'sizeB2', 'color3']);
    expect(r.portMap).toMatchObject({ camera: 'camera', material: 'material', size: 'size', posX: 'posX', x1: 's1_posX', y2: 's2_posY', size1: 's1_radius', sizeB2: 's2_tube', color3: 's3_color' });
    const ins = r.d.inputs.find((i) => i.id === 's1_posX')!;
    expect(ins).toMatchObject({ name: 'Shape 1 Position X', type: 'number' });
    expect(r.d.inputs.find((i) => i.id === 's3_color')!.type).toBe('color');
    expect(r.d.edges).toContainEqual(expect.objectContaining({ from: { node: GROUP_IN, port: 's2_tube' }, to: { node: 'shape2', port: 'tube' } }));
    expect(r.notes).toEqual([]);
  });

  it('wires that have no place are listed, and the current value is used', () => {
    const r = conv(params, ['gooey', 'smooth2', 'size3', 'mirrorX']);
    expect(r.portMap).toMatchObject({ gooey: null, smooth2: null, size3: null, mirrorX: null });
    const text = r.notes.join('\n');
    expect(text).toContain('Gooeyness was wired to another node');
    expect(text).toContain('Shape 2 Smoothness was wired');
    expect(text).toContain('Shape 3 Size was wired');
    expect(text).toContain('the wire was not carried over');
  });
});

describe('convert SDF 3D to SDF Scene: the graph edit', () => {
  const mk = (): GraphDoc => {
    const g = createGraph('t');
    const nodes: NodeInstance[] = [
      { id: 'cam', type: 'camera', x: 0, y: 0, params: {} },
      { id: 'val', type: 'value', x: 0, y: 100, params: { value: 0.3 } },
      { id: 'o', type: 'sdf-3d', x: 300, y: 80, params: { shape1: 'sphere', shape2: 'box', label: undefined }, label: 'My blob' },
      { id: 'out', type: 'output', x: 700, y: 80, params: {} },
    ];
    const edges: Edge[] = [
      { id: 'e1', from: { node: 'cam', port: 'camera' }, to: { node: 'o', port: 'camera' } },
      { id: 'e2', from: { node: 'val', port: 'value' }, to: { node: 'o', port: 'x2' } },
      { id: 'e3', from: { node: 'val', port: 'value' }, to: { node: 'o', port: 'gooey' } },
      { id: 'e4', from: { node: 'o', port: 'image' }, to: { node: 'out', port: 'image' } },
    ];
    return { ...g, nodes, edges };
  };

  it('replaces the node in place and moves the wires', () => {
    const g = mk();
    const res = applySdfConversion(g, registry, 'o');
    if ('error' in res) throw new Error(res.error);
    expect(res.id).toBe('o');
    const n = res.graph.nodes.find((x) => x.id === 'o')!;
    expect(n).toMatchObject({ type: 'group', x: 300, y: 80, label: 'My blob' });
    expect(res.graph.nodes.map((x) => x.id)).toEqual(['cam', 'val', 'o', 'out']);
    expect(res.graph.edges.map((e) => [e.id, e.from.node, e.from.port, e.to.node, e.to.port])).toEqual([
      ['e1', 'cam', 'camera', 'o', 'camera'],
      ['e2', 'val', 'value', 'o', 's2_posX'],
      ['e4', 'o', 'image', 'out', 'image'],
    ]);
    expect(res.notes.join(' ')).toContain('Gooeyness was wired');
    expect(g.nodes[2].type).toBe('sdf-3d'); // the input graph is untouched
  });

  it('a copy keeps the original and its wires, and wires the new scene to the same sources', () => {
    const g = mk();
    const res = applySdfConversion(g, registry, 'o', true);
    if ('error' in res) throw new Error(res.error);
    expect(res.id).not.toBe('o');
    expect(res.graph.nodes).toHaveLength(5);
    expect(res.graph.nodes.find((x) => x.id === 'o')).toEqual(g.nodes[2]);
    expect(res.graph.edges.slice(0, 4)).toEqual(g.edges);
    const added = res.graph.edges.slice(4).map((e) => [e.from.node, e.from.port, e.to.node === res.id, e.to.port]);
    expect(added).toEqual([['cam', 'camera', true, 'camera'], ['val', 'value', true, 's2_posX']]);
  });

  it('refuses a node that is not an SDF 3D node', () => {
    expect('error' in applySdfConversion(mk(), registry, 'cam')).toBe(true);
  });
});
