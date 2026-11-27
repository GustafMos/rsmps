import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../engine';
import { createGraph } from '../../graph';
import { GROUP_IN, GROUP_OUT, groupData } from '../../group';
import { PNG_DIR, writePng, type Img } from '../../lib/gen-3d-testutil';
import { newSdfScene } from '../../sdf-scene-group';
import { harness } from '../../testing';
import type { Edge, GraphDoc, ImageValue, NodeInstance, SdfValue } from '../../types';

/**
 * SDF Scene on the real GPU: the nodes (Shape, Combine, Move, Modify) and the Scene Output renderer, flat and inside an SDF Scene group.
 * Orthographic front view at 128 x 128: 32 px per scene unit, scene origin at pixel (64, 64), y up.
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 180_000 };
const proj = { width: 128, height: 128 };
const view = { rotX: 0, rotY: 0, rotZ: 0, cameraType: 'orthographic', scale: 0.5, ambient: 1, specular: 0, ao: 0 };

type N = [id: string, type: string, params?: Record<string, unknown>];
type E = [from: string, fromPort: string, to: string, toPort: string];
const mk = (nodes: N[], edges: E[], project: Partial<GraphDoc['project']> = proj): GraphDoc => {
  const g = createGraph('t');
  return {
    ...g,
    project: { ...g.project, ...project },
    nodes: nodes.map(([id, type, params], i) => ({ id, type, x: i * 100, y: 0, params: params ?? {} })),
    edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
  };
};
const sph = (id: string, x: number, extra: Record<string, unknown> = {}): N => [id, 'sdf-shape', { shape: 'sphere', radius: 0.5, posX: x, ...extra }];
const alpha = (px: Img, x: number, y: number) => px.data[(y * px.width + x) * 4 + 3];
/** Scene of shapes under one combine, drawn by a Scene Output called `render`. */
const flat = (shapes: N[], comb: Record<string, unknown> = {}, render: Record<string, unknown> = {}, extra: { nodes?: N[]; edges?: E[] } = {}): GraphDoc =>
  mk(
    [...shapes, ['comb', 'sdf-combine', comb], ['render', 'sdf-render', { ...view, ...render }], ...(extra.nodes ?? [])],
    [...shapes.map((s): E => [s[0], 'sdf', 'comb', 'items']), ['comb', 'sdf', 'render', 'scene'], ...(extra.edges ?? [])],
  );
const draw = async (g: GraphDoc, node = 'render', port = 'image') => {
  const t = await H();
  const img = (await t.evalGraph(g, node, { port })) as ImageValue;
  return t.pixels(img);
};
const rowBlobs = (px: Img, y: number) => {
  let n = 0;
  let inside = false;
  for (let x = 0; x < px.width; x++) {
    const on = alpha(px, x, y) > 128;
    if (on && !inside) n++;
    inside = on;
  }
  return n;
};

describe('sdf scene: one shape', () => {
  it('a sphere renders a disc of the right size at the centre', T, async () => {
    const px = await draw(flat([sph('s', 0)]));
    expect(alpha(px, 64, 64)).toBe(255);
    expect(alpha(px, 64 + 14, 64)).toBe(255);
    expect(alpha(px, 64 - 14, 64)).toBe(255);
    expect(alpha(px, 64, 64 - 14)).toBe(255);
    expect(alpha(px, 64 + 19, 64)).toBe(0);
    expect(alpha(px, 64, 64 + 19)).toBe(0);
    // area of a disc of radius 16 px, within a few percent
    let area = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) area += alpha(px, x, y) / 255;
    expect(Math.abs(area - Math.PI * 16 * 16)).toBeLessThan(0.05 * Math.PI * 256);
  });

  it('matches SDF 3D pixel for pixel for the same single sphere, and its depth', T, async () => {
    const t = await H();
    const g = flat([sph('s', 0, { color: [0.9, 0.3, 0.2, 1] })]);
    const ours = (await t.evalGraph(g, 'render', { port: 'image' })) as ImageValue;
    const oursDepth = (await t.evalGraph(g, 'render', { port: 'depth' })) as ImageValue;
    const theirs = await t.run('sdf-3d', { ...view, shape1: 'sphere', shape2: 'off', x1: 0, size1: 0.5, color1: [0.9, 0.3, 0.2, 1] }, {}, { project: proj });
    expect(await t.diff(ours, theirs.image as ImageValue)).toBeLessThan(0.05);
    // depth: distance from the camera to the surface, 4.5 away at the default camera, 0.5 radius: identical convention
    const g3 = mk([['s', 'sdf-3d', { ...view, shape1: 'sphere', shape2: 'off', x1: 0, size1: 0.5 }]], []);
    const d3 = (await t.evalGraph(g3, 's', { port: 'depth' })) as ImageValue;
    expect(await t.diff(oursDepth, d3)).toBeLessThan(0.01);
    const read = await t.gpu.read(oursDepth, false);
    const c = (64 * 128 + 64) * 4;
    expect(read[c + 3]).toBeGreaterThan(0.5); // hit
    expect(read[c]).toBeGreaterThan(3); // a real distance, not a 0..1 value
  });

  it('a scene with nothing in it renders nothing; a shape without its picture is not there', T, async () => {
    const t = await H();
    const empty = mk([['render', 'sdf-render', view], ['comb', 'sdf-combine', {}]], [['comb', 'sdf', 'render', 'scene']]);
    const px = await draw(empty);
    expect(alpha(px, 64, 64)).toBe(0);
    const noPic = flat([['s', 'sdf-shape', { shape: 'image2d' }]]);
    expect(alpha(await draw(noPic), 64, 64)).toBe(0);
    const pic = t.fromFn(32, 32, (x, y) => (x > 3 && x < 28 && y > 3 && y < 28 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const src = t.source(pic);
    const withPic = mk(
      [['p', src], ['s', 'sdf-shape', { shape: 'image2d', sizeX: 1.2, sizeZ: 0.5 }], ['comb', 'sdf-combine'], ['render', 'sdf-render', view]],
      [['p', 'out', 's', 'picture'], ['s', 'sdf', 'comb', 'items'], ['comb', 'sdf', 'render', 'scene']],
    );
    const pp = await draw(withPic);
    expect(alpha(pp, 64, 64)).toBe(255);
    expect(alpha(pp, 64 + 17, 64)).toBe(0);
  });
});

describe('sdf scene: shapes are independent', () => {
  it('moving the SHAPE node moves only that shape (the other shape\'s pixels do not change)', T, async () => {
    const a = await draw(flat([sph('a', -0.9), sph('b', 0.9)]));
    const b = await draw(flat([sph('a', -0.9, { posY: 0.6 }), sph('b', 0.9)]));
    let rightDiff = 0;
    let leftDiff = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const d = Math.abs(a.data[(y * 128 + x) * 4 + 3] - b.data[(y * 128 + x) * 4 + 3]);
        if (x >= 64) rightDiff += d;
        else leftDiff += d;
      }
    // the right sphere's pixels are unchanged (a bounding sphere that moved can nudge the anti-aliasing of an edge pixel by a level or two)
    expect(rightDiff).toBeLessThanOrEqual(4);
    expect(leftDiff).toBeGreaterThan(255 * 20);
    expect(alpha(b, 64 - 29, 64 - 19)).toBe(255); // a moved up by 0.6 units = 19 px
  });

  it('Union, Subtract and Intersect cover what they should', T, async () => {
    const s = [sph('a', -0.3, { radius: 0.6 }), sph('b', 0.3, { radius: 0.6 })];
    const union = await draw(flat(s, { operation: 'union' }));
    const sub = await draw(flat(s, { operation: 'subtract' }));
    const inter = await draw(flat(s, { operation: 'intersect' }));
    const probe = (px: Img) => [38, 64, 67, 90].map((x) => alpha(px, x, 64) > 128);
    expect(probe(union)).toEqual([true, true, true, true]);
    expect(probe(sub)).toEqual([true, false, false, false]); // a minus b: only the left crescent stays (x = 0 is inside b)
    expect(probe(inter)).toEqual([false, true, true, false]); // only the lens
  });

  it('subtract removes every LATER input from the first one', T, async () => {
    const bar = (id: string, x: number): N => [id, 'sdf-shape', { shape: 'box', sizeX: 0.4, sizeY: 0.4, sizeZ: 3, posX: x }];
    const px = await draw(flat([sph('a', 0, { radius: 1 }), bar('b', -0.6), bar('c', 0.6)], { operation: 'subtract' }));
    expect(alpha(px, 64 - 19, 64)).toBe(0); // b is cut right through the sphere: a hole
    expect(alpha(px, 64 + 19, 64)).toBe(0); // and so is c, the LATER input
    expect(alpha(px, 64, 64)).toBe(255);
    expect(alpha(px, 64, 64 - 25)).toBe(255);
  });

  it('smooth union adds material between two near spheres', T, async () => {
    const s = [sph('a', -0.55, { radius: 0.4 }), sph('b', 0.55, { radius: 0.4 })];
    const hard = await draw(flat(s, { smoothness: 0 }));
    const soft = await draw(flat(s, { smoothness: 0.8 }));
    expect(alpha(hard, 64, 64)).toBe(0);
    expect(alpha(soft, 64, 64)).toBe(255);
    // colours blend across the neck
    const colA = [1, 0, 0, 1];
    const colB = [0, 0, 1, 1];
    const coloured = await draw(flat([sph('a', -0.55, { radius: 0.4, color: colA }), sph('b', 0.55, { radius: 0.4, color: colB })], { smoothness: 0.8 }));
    const mid = (64 * 128 + 64) * 4;
    expect(coloured.data[mid]).toBeGreaterThan(40);
    expect(coloured.data[mid + 2]).toBeGreaterThan(40);
  });

  it('SDF Move moves a whole sub-scene', T, async () => {
    const g = mk(
      [sph('a', 0), sph('b', 0, { posY: 0.9, radius: 0.3 }), ['comb', 'sdf-combine'], ['mv', 'sdf-transform', { posX: 1 }], ['render', 'sdf-render', view]],
      [['a', 'sdf', 'comb', 'items'], ['b', 'sdf', 'comb', 'items'], ['comb', 'sdf', 'mv', 'scene'], ['mv', 'sdf', 'render', 'scene']],
    );
    const px = await draw(g);
    expect(alpha(px, 64, 64)).toBe(0);
    expect(alpha(px, 96, 64)).toBe(255);
    expect(alpha(px, 96, 64 - 29)).toBe(255); // the small sphere came along
  });

  it('Mirror and Repeat make the expected number of blobs', T, async () => {
    const one = (x: number): N => sph('s', x, { radius: 0.3 });
    const wrap = (mod: Record<string, unknown>) => mk([one(0.9), ['mod', 'sdf-modify', mod], ['render', 'sdf-render', view]], [['s', 'sdf', 'mod', 'scene'], ['mod', 'sdf', 'render', 'scene']]);
    expect(rowBlobs(await draw(wrap({ modifier: 'mirror', mirrorX: false })), 64)).toBe(1);
    const mir = await draw(wrap({ modifier: 'mirror', mirrorX: true }));
    expect(rowBlobs(mir, 64)).toBe(2);
    expect(alpha(mir, 64 - 29, 64)).toBe(255);
    expect(alpha(mir, 64 + 29, 64)).toBe(255);
    const rep = mk([sph('s', 0, { radius: 0.3 }), ['mod', 'sdf-modify', { modifier: 'repeat', countX: 3, spacingX: 1.5 }], ['render', 'sdf-render', view]], [['s', 'sdf', 'mod', 'scene'], ['mod', 'sdf', 'render', 'scene']]);
    const rp = await draw(rep);
    expect(rowBlobs(rp, 64)).toBe(3);
    expect(alpha(rp, 16, 64)).toBe(255);
    expect(alpha(rp, 112, 64)).toBe(255);
    expect(alpha(rp, 40, 64)).toBe(0);
    // a grid: 3 x 3 blobs
    const grid = mk([sph('s', 0, { radius: 0.25 }), ['mod', 'sdf-modify', { modifier: 'repeat', countX: 3, countY: 3, spacingX: 1.2, spacingY: 1.2 }], ['render', 'sdf-render', view]], [['s', 'sdf', 'mod', 'scene'], ['mod', 'sdf', 'render', 'scene']]);
    const gp = await draw(grid);
    expect([64 - 38, 64, 64 + 38].map((y) => rowBlobs(gp, y))).toEqual([3, 3, 3]);
  });

  it('Round grows a shape, Shell keeps the outside, Twist / Bend / Displace render', T, async () => {
    const wrap = (mod: Record<string, unknown>, shape: Record<string, unknown> = {}) =>
      mk([['s', 'sdf-shape', { shape: 'box', sizeX: 0.8, sizeY: 1.6, sizeZ: 0.8, ...shape }], ['mod', 'sdf-modify', mod], ['render', 'sdf-render', view]], [['s', 'sdf', 'mod', 'scene'], ['mod', 'sdf', 'render', 'scene']]);
    const plain = await draw(wrap({ modifier: 'round', roundAmount: 0 }));
    const round = await draw(wrap({ modifier: 'round', roundAmount: 0.3 }));
    expect(alpha(plain, 64 + 12, 64 - 25)).toBe(255); // inside the box corner region
    expect(alpha(plain, 64 + 14, 64 - 26)).toBe(0); // beyond the half width 0.4 = 12.8 px
    expect(alpha(round, 64 + 14, 64)).toBe(255); // grown by 0.3 = 9.6 px
    // the box's corner becomes round: the plain box covers its corner pixel, the rounded one does not
    expect(alpha(plain, 64 + 12, 64 - 25)).toBe(255);
    expect(alpha(round, 64 + 22, 64 - 33)).toBe(0);
    const shell = await draw(wrap({ modifier: 'shell', thickness: 0.05 }));
    expect(alpha(shell, 64, 64)).toBe(255);
    for (const mod of [{ modifier: 'twist', twistAmount: 60, axis: 'y' }, { modifier: 'bend', bendAmount: 40, axis: 'x' }, { modifier: 'displace', displaceAmount: 0.1, noiseScale: 3 }]) {
      const px = await draw(wrap(mod, { sizeY: 1.2 }));
      expect(alpha(px, 64, 64), JSON.stringify(mod)).toBe(255);
      expect(alpha(px, 4, 4)).toBe(0);
    }
  });

  it('Displace loops: a whole number of cycles per loop repeats exactly, and it moves in between', T, async () => {
    const t = await H();
    const g = mk(
      [sph('s', 0, { radius: 0.7 }), ['mod', 'sdf-modify', { modifier: 'displace', displaceAmount: 0.25, noiseScale: 3, loops: 2 }], ['render', 'sdf-render', view]],
      [['s', 'sdf', 'mod', 'scene'], ['mod', 'sdf', 'render', 'scene']],
      { ...proj, fps: 10, duration: 2, loop: true },
    );
    const at = async (sec: number) => (await t.evalGraph(g, 'render', { seconds: sec, port: 'image' })) as ImageValue;
    const a = await at(0);
    const b = await at(1.0);
    const wrapped = await at(2.0); // frame 20 = frame 0 of the next loop
    expect(await t.diff(a, wrapped)).toBe(0);
    expect(await t.diff(a, b)).toBe(0); // 2 cycles in 2 s: half a loop is one whole cycle
    const quarter = await at(0.25);
    expect(await t.diff(a, quarter)).toBeGreaterThan(0.01);
  });
});

describe('sdf scene: the SDF Scene group', () => {
  /** A scene group with the inside of `newSdfScene` edited: extra nodes and wires, an extra sdf input (an "SDF In"). */
  const scene = (t: Awaited<ReturnType<typeof H>>, id: string, edit: (nodes: NodeInstance[], edges: Edge[]) => void, p: Record<string, unknown> = {}, sdfIn = false): NodeInstance => {
    const g = newSdfScene(t.registry, id, { x: 0, y: 0 });
    const d = groupData(g);
    const nodes = [...d.nodes];
    const edges = [...d.edges];
    edit(nodes, edges);
    const inputs = sdfIn ? [...d.inputs, { id: 'sub', name: 'SDF In', type: 'sdf' as const }] : d.inputs;
    return { ...g, params: { ...g.params, nodes, edges, inputs, ...view, ...p } };
  };
  const doc = (nodes: NodeInstance[], edges: E[]): GraphDoc => ({ ...mk([], edges), nodes });

  it('a new SDF Scene is pre-filled with one sphere that renders at once', T, async () => {
    const t = await H();
    const s = scene(t, 'sc', () => {});
    const g = doc([s], []);
    const px = await draw(g, 'sc');
    expect(alpha(px, 64, 64)).toBe(255);
    expect(groupData(s).sdfScene).toBe(true);
    expect(groupData(s).nodes.map((n) => n.type).sort()).toEqual(['sdf-render', 'sdf-shape']);
  });

  it('moving a shape INSIDE the scene works, and so does a wired number on it', T, async () => {
    const t = await H();
    const s = scene(t, 'sc', (nodes) => {
      nodes[0] = { ...nodes[0], params: { ...nodes[0].params, posX: 1 } };
    });
    expect(alpha(await draw(doc([s], []), 'sc'), 96, 64)).toBe(255);
    const n = scene(t, 'sc', () => {});
    const g = doc([n, { id: 'num', type: 'value', x: 0, y: 0, params: { value: -1 } }], []);
    // a number wired to the scene's own Move X (exposed on the group) moves the whole scene
    const wired: GraphDoc = { ...g, edges: [{ id: 'w', from: { node: 'num', port: 'value' }, to: { node: 'sc', port: 'posX' } }] };
    expect(alpha(await draw(wired, 'sc'), 32, 64)).toBe(255);
    expect(alpha(await draw(wired, 'sc'), 96, 64)).toBe(0);
  });

  it('a scene wired into another scene (sdf output -> SDF In) renders both, and can be subtracted', T, async () => {
    const t = await H();
    const sub = scene(t, 'a', (nodes) => {
      nodes[0] = { ...nodes[0], params: { ...nodes[0].params, radius: 0.4 } };
    }, { posX: 0.8 }); // this scene's own Move X is carried by its sdf output
    const mkOuter = (operation: string) =>
      scene(
        t,
        'b',
        (nodes, edges) => {
          nodes.push({ id: 'comb', type: 'sdf-combine', x: 200, y: 0, params: { operation, smoothness: 0 } });
          const i = edges.findIndex((e) => e.to.port === 'scene');
          edges.splice(i, 1, { id: 'x1', from: { node: 'shape1', port: 'sdf' }, to: { node: 'comb', port: 'items' } }, { id: 'x2', from: { node: GROUP_IN, port: 'sub' }, to: { node: 'comb', port: 'items' } }, { id: 'x3', from: { node: 'comb', port: 'sdf' }, to: { node: 'render', port: 'scene' } });
          nodes[0] = { ...nodes[0], params: { ...nodes[0].params, radius: 0.6 } };
        },
        {},
        true,
      );
    const wire: E = ['a', 'sdf', 'b', 'sub'];
    const both = await draw(doc([sub, mkOuter('union')], [wire]), 'b');
    expect(alpha(both, 64, 64)).toBe(255); // the outer scene's own sphere (radius 0.6 = 19 px)
    expect(alpha(both, 100, 64)).toBe(255); // the inner scene's sphere, moved by that scene's own Move X (x = 0.8, radius 0.4)
    expect(alpha(both, 64 + 50, 64)).toBe(0);
    // subtract: the inner sphere (centre x = 0.8, radius 0.4) bites the outer one (radius 0.6) where they overlap
    const cut = await draw(doc([sub, mkOuter('subtract')], [wire]), 'b');
    expect(alpha(cut, 64, 64)).toBe(255);
    expect(alpha(cut, 100, 64)).toBe(0); // the inner sphere itself is gone from the picture
    expect(alpha(cut, 82, 64)).toBe(0); // the rim of the outer sphere inside the inner one's reach
    // the scene's sdf output wraps the whole scene in ONE move node whose id is the render node's path
    const eng = new Engine(t.gpu, t.registry, t.engine.host);
    const r = await eng.evaluate({ graph: doc([sub, mkOuter('union')], [wire]), node: 'b', port: 'sdf' });
    const v = r.value as SdfValue;
    expect(v.root?.t).toBe('move');
    expect(v.root?.id).toBe('b/render');
    eng.clear();
  });

  it('paths: every tree node is named by the flat path of the node that made it', T, async () => {
    const t = await H();
    const sub = scene(t, 'a', () => {});
    const eng = new Engine(t.gpu, t.registry, t.engine.host);
    const r = await eng.evaluate({ graph: doc([sub], []), node: 'a', port: 'sdf' });
    const v = r.value as SdfValue;
    expect(v.root?.id).toBe('a/render');
    expect(v.root?.t === 'move' && v.root.child.id).toBe('a/shape1');
    eng.clear();
  });
});

describe('sdf scene: shaders and limits', () => {
  it('changing only numbers never creates a new pipeline; a structural change does', T, async () => {
    const t = await H();
    const g = (x: number, smooth: number, col: number, rot: number) => flat([sph('a', x, { color: [col, 0.2, 0.4, 1] }), ['b', 'sdf-shape', { shape: 'box', posX: 1 - x, rotY: rot }]], { smoothness: smooth }, { rotY: rot, lightAzimuth: rot });
    await draw(g(-0.5, 0.2, 0.5, 0));
    const before = t.gpu.stats().objects.pipelinesCreated;
    for (const k of [1, 2, 3, 4]) await draw(g(-0.5 + k * 0.1, 0.1 * k, 0.1 * k, 15 * k));
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
    await draw(flat([sph('a', 0), ['b', 'sdf-shape', { shape: 'torus' }]]));
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBeGreaterThan(0);
  });

  it('32 shapes render (and more than the cap is refused with a plain message)', T, async () => {
    const t = await H();
    const ring = (n: number) => Array.from({ length: n }, (_, i): N => sph(`s${i}`, Math.cos((i / n) * Math.PI * 2) * 1.6, { posY: Math.sin((i / n) * Math.PI * 2) * 1.6, radius: 0.2 }));
    const px = await draw(flat(ring(32)));
    let lit = 0;
    for (let i = 0; i < 32; i++) {
      const x = Math.round(64 + Math.cos((i / 32) * Math.PI * 2) * 1.6 * 32);
      const y = Math.round(64 - Math.sin((i / 32) * Math.PI * 2) * 1.6 * 32);
      if (alpha(px, x, y) > 200) lit++;
    }
    expect(lit).toBe(32);
    const eng = new Engine(t.gpu, t.registry, t.engine.host);
    const r = await eng.evaluate({ graph: flat(ring(97)), node: 'render', port: 'image' });
    expect([...r.errors.values()].join(' ')).toMatch(/at most 96/);
    const big = await eng.evaluate({
      graph: mk([sph('s', 0), ['mod', 'sdf-modify', { modifier: 'repeat', countX: 32, countY: 32, countZ: 32 }], ['render', 'sdf-render', view]], [['s', 'sdf', 'mod', 'scene'], ['mod', 'sdf', 'render', 'scene']]),
      node: 'render',
      port: 'image',
    });
    expect([...big.errors.values()].join(' ')).toMatch(/copies/);
    eng.clear();
  });

  it('a stray SDF node outside a scene does not crash anything', T, async () => {
    const t = await H();
    const eng = new Engine(t.gpu, t.registry, t.engine.host);
    for (const g of [mk([sph('s', 0)], []), mk([sph('s', 0), ['c', 'sdf-combine'], ['m', 'sdf-modify'], ['v', 'sdf-transform']], [['s', 'sdf', 'c', 'items'], ['c', 'sdf', 'm', 'scene'], ['m', 'sdf', 'v', 'scene']]), mk([['x', 'sdf-scene']], []), mk([['r', 'sdf-render']], [])]) {
      for (const node of g.nodes) {
        const r = await eng.evaluate({ graph: g, node: node.id });
        expect([...r.errors.values()]).toEqual([]);
      }
    }
    eng.clear();
  });
});

/** Samples and timings: only with SDF_SAMPLES=1 (they write pictures and take a while on the software GPU). */
describe.skipIf(!process.env.SDF_SAMPLES)('sdf scene: samples and cost', () => {
  const out = process.env.SDF_SAMPLE_DIR ?? PNG_DIR;
  const save = (name: string, px: Img) => {
    mkdirSync(out, { recursive: true });
    process.env.RSMPS_PREVIEW_DIR = out;
    return writePng(name, px, false);
  };
  const lit = { rotX: 25, rotY: 35, ambient: 0.35, specular: 0.35, ao: 0.5, cameraType: 'perspective', scale: 0.6, quality: 'high' };

  it('writes sample pictures', T, async () => {
    const sc = (nodes: N[], edges: E[]) => mk(nodes, edges, { width: 320, height: 320 });
    const s1 = sc([sph('a', -0.5, { radius: 0.6, color: [0.3, 0.55, 1, 1] }), sph('b', 0.55, { radius: 0.5, color: [1, 0.45, 0.6, 1] }), ['comb', 'sdf-combine', { smoothness: 0.6 }], ['render', 'sdf-render', lit]], [['a', 'sdf', 'comb', 'items'], ['b', 'sdf', 'comb', 'items'], ['comb', 'sdf', 'render', 'scene']]);
    save('sdfscene-1-smooth-union', await draw(s1));
    const s2 = sc(
      [['a', 'sdf-shape', { shape: 'box', sizeX: 1.4, sizeY: 1.4, sizeZ: 1.4, color: [0.9, 0.8, 0.5, 1] }], sph('b', 0, { radius: 0.95, color: [0.4, 0.8, 0.6, 1] }), ['c', 'sdf-shape', { shape: 'cylinder', radius: 0.4, sizeY: 3, color: [0.8, 0.3, 0.3, 1] }], ['i', 'sdf-combine', { operation: 'intersect' }], ['comb', 'sdf-combine', { operation: 'subtract', smoothness: 0.05 }], ['render', 'sdf-render', lit]],
      [['a', 'sdf', 'i', 'items'], ['b', 'sdf', 'i', 'items'], ['i', 'sdf', 'comb', 'items'], ['c', 'sdf', 'comb', 'items'], ['comb', 'sdf', 'render', 'scene']],
    );
    save('sdfscene-2-subtract', await draw(s2));
    const s3 = sc(
      [['a', 'sdf-shape', { shape: 'torus', radius: 0.35, tube: 0.1, posX: 0.7, color: [0.95, 0.6, 0.2, 1] }], sph('b', 0.7, { radius: 0.18, posY: 0.35, color: [0.4, 0.6, 1, 1] }), ['comb', 'sdf-combine', { smoothness: 0.1 }], ['mir', 'sdf-modify', { modifier: 'mirror', mirrorX: true }], ['rep', 'sdf-modify', { modifier: 'repeat', countX: 1, countY: 3, countZ: 2, spacingY: 1.1, spacingZ: 1.1 }], ['render', 'sdf-render', { ...lit, scale: 0.4 }]],
      [['a', 'sdf', 'comb', 'items'], ['b', 'sdf', 'comb', 'items'], ['comb', 'sdf', 'mir', 'scene'], ['mir', 'sdf', 'rep', 'scene'], ['rep', 'sdf', 'render', 'scene']],
    );
    const p3 = await draw(s3);
    save('sdfscene-3-mirror-repeat', p3);
    expect(alpha(p3, 160, 160)).toBeGreaterThanOrEqual(0);
  });

  it('reports render time for 4, 16 and 32 shapes, hard and smooth, at 640x360', T, async () => {
    const t = await H();
    const lines: string[] = [];
    for (const n of [4, 16, 32]) {
      for (const smooth of [0, 0.3]) {
        const times: number[] = [];
        for (let k = 0; k < 4; k++) {
          const shapes = Array.from({ length: n }, (_, i): N => sph(`s${i}`, Math.cos((i / n) * 6.283 + k * 0.01) * 1.4, { posY: Math.sin((i / n) * 6.283) * 1.4, radius: 0.35 }));
          const g = mk([...shapes, ['comb', 'sdf-combine', { smoothness: smooth }], ['render', 'sdf-render', { ...view, scale: 0.4 }]], [...shapes.map((s): E => [s[0], 'sdf', 'comb', 'items']), ['comb', 'sdf', 'render', 'scene']], { width: 640, height: 360 });
          const t0 = performance.now();
          const img = (await t.evalGraph(g, 'render', { port: 'image' })) as ImageValue;
          await t.gpu.read(img, false);
          if (k > 0) times.push(performance.now() - t0); // the first run of a new structure includes the shader build
        }
        lines.push(`${n} shapes, smoothness ${smooth}: ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms`);
      }
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/cost.txt`, `SDF SCENE COST (software GPU, relative only)\n${lines.join('\n')}\n`);
    expect(lines.length).toBe(6);
  });
});
