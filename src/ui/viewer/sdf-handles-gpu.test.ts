/**
 * The per-shape handles of an SDF Scene against really rendered pixels: where the handle says a shape is, the scene must draw it, and a drag
 * worked out by the handle's own maths must carry the drawn shape by that many pixels, also for a shape under a rotated and scaled SDF Move
 * inside a rotated scene, in a landscape and a portrait picture. Also CPU picking against the GPU's own depth.
 */
import { describe, expect, it } from 'vitest';
import { createGraph } from '../../engine/graph';
import { groupData } from '../../engine/group';
import { halfToFloat } from '../../engine/lib/depth-ai-math';
import { sdfRay } from '../../engine/lib/sdf-eval';
import { newSdfScene } from '../../engine/sdf-scene-group';
import { harness } from '../../engine/testing';
import type { GraphDoc, ImageValue, NodeInstance } from '../../engine/types';
import { SDF_RENDER_ID } from '../../engine/lib/sdf-scene-params';
import { dragMove, lensOf, projectPoint, rayAt, turnRoll, turnTrackball, matrixOf, mul3, axisAngle, type Euler, type V3 } from './gizmoMath';
import { chainOf, toLocal, toWorld } from './sdfHandles';
import { loadSdfView } from './sdfView';

let shared: ReturnType<typeof harness> | null = null;
const T = () => (shared ??= harness());
const TO = { timeout: 180_000 };

/** The scene is rotated, the shape sits under an SDF Move that is rotated and scaled too. */
const SCENE = { rotX: 20, rotY: -35, rotZ: 8, objectScale: 1.1, posX: 0.15, posY: -0.1, cameraType: 'perspective', fov: 40, scale: 0.6, ambient: 1, specular: 0, ao: 0 };
const MOVE = { posX: 0.5, posY: 0.2, posZ: -0.3, rotX: 15, rotY: 40, rotZ: -25, objectScale: 1.4 };
const SHAPE = { shape: 'sphere', radius: 0.14, posX: -0.3, posY: 0.25, posZ: 0.2 };

async function build(withOther: boolean, shape: Record<string, unknown>, size: { width: number; height: number }): Promise<{ graph: GraphDoc; scene: NodeInstance }> {
  const t = await T();
  const g = newSdfScene(t.registry, 'sc', { x: 0, y: 0 });
  const d = groupData(g);
  const nodes: NodeInstance[] = [
    { ...d.nodes[0], params: { ...d.nodes[0].params, ...SHAPE, ...shape } },
    { id: 'mv', type: 'sdf-transform', x: 0, y: 0, params: { ...MOVE } },
    { id: 'comb', type: 'sdf-combine', x: 0, y: 0, params: {} },
    d.nodes[1],
    ...(withOther ? [{ id: 'other', type: 'sdf-shape', x: 0, y: 0, params: { shape: 'sphere', radius: 0.2, posX: -0.6, posY: -0.4 } } as NodeInstance] : []),
  ];
  const w = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } });
  const edges = [
    ...d.edges.filter((e) => e.to.port !== 'scene'),
    w('x1', 'shape1', 'sdf', 'mv', 'scene'),
    w('x2', 'mv', 'sdf', 'comb', 'items'),
    ...(withOther ? [w('x3', 'other', 'sdf', 'comb', 'items')] : []),
    w('x4', 'comb', 'sdf', SDF_RENDER_ID, 'scene'),
  ];
  const scene: NodeInstance = { ...g, params: { ...g.params, nodes, edges, ...SCENE } };
  const base = createGraph('t');
  return { graph: { ...base, project: { ...base.project, ...size, fps: 10, duration: 2, loop: true }, nodes: [scene] }, scene };
}

async function centroid(graph: GraphDoc) {
  const t = await T();
  const px = await t.pixels((await t.evalGraph(graph, 'sc', { port: 'image', seconds: 0 })) as ImageValue);
  let sx = 0, sy = 0, sa = 0;
  for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) { const a = px.data[(y * px.width + x) * 4 + 3] / 255; sx += (x + 0.5) * a; sy += (y + 0.5) * a; sa += a; }
  return { x: sx / sa, y: sy / sa, area: sa };
}

const setShape = (g: GraphDoc, patch: Record<string, unknown>): GraphDoc => {
  const scene = g.nodes[0];
  const d = groupData(scene);
  const nodes = d.nodes.map((n) => (n.id === 'shape1' ? { ...n, params: { ...n.params, ...patch } } : n));
  return { ...g, nodes: [{ ...scene, params: { ...scene.params, nodes } }] };
};

async function viewOf(graph: GraphDoc, size: { width: number; height: number }) {
  const t = await T();
  const io = { evaluate: (g: GraphDoc, node: string, o?: { port?: string; seconds?: number }) => t.evalGraph(g, node, { port: o?.port, seconds: o?.seconds ?? 0 }) };
  const v = await loadSdfView(io as never, graph, ['sc'], { seconds: 0, item: 0, ...size });
  expect(v).not.toBeNull();
  return v!;
}

for (const size of [{ width: 256, height: 160 }, { width: 160, height: 256 }]) {
  const name = `${size.width}x${size.height}`;

  it(`${name}: the handle sits on the centre of the drawn shape (under a rotated, scaled SDF Move in a rotated scene)`, TO, async () => {
    // the other shape is in the scene for the tree, but the centre of coverage is measured on the shape alone
    const full = await build(true, {}, size);
    const alone = await build(false, {}, size);
    const view = await viewOf(full.graph, size);
    const chain = chainOf(view.root, 'sc/shape1')!;
    expect(chain).not.toBeNull();
    expect(chain.mods).toEqual([]);
    const lens = lensOf(view.camera, size.width, size.height);
    const world = toWorld(chain.frame, [SHAPE.posX, SHAPE.posY, SHAPE.posZ]);
    const c = projectPoint(lens, world);
    const drawn = await centroid(alone.graph);
    expect(drawn.area).toBeGreaterThan(30);
    console.log(`handle vs drawn centroid ${name}: dx=${(c.x * size.width - drawn.x).toFixed(3)} px, dy=${(c.y * size.height - drawn.y).toFixed(3)} px`);
    expect(Math.abs(c.x * size.width - drawn.x)).toBeLessThan(1.5);
    expect(Math.abs(c.y * size.height - drawn.y)).toBeLessThan(1.5);
    // the other shape is in the tree too, and has its own (shorter) chain: the scene's own move only
    const other = chainOf(view.root, 'sc/other')!;
    expect(other.frame.s).toBeCloseTo(SCENE.objectScale, 6);
    expect(chain.frame.s).toBeCloseTo(SCENE.objectScale * MOVE.objectScale, 6);
  });

  it(`${name}: dragging the handle by (+55, -22) px carries the drawn shape by that much, writing the shape's OWN numbers`, TO, async () => {
    const full = await build(true, {}, size);
    const alone = await build(false, {}, size);
    const view = await viewOf(full.graph, size);
    const chain = chainOf(view.root, 'sc/shape1')!;
    const lens = lensOf(view.camera, size.width, size.height);
    const p0: V3 = [SHAPE.posX, SHAPE.posY, SHAPE.posZ];
    const w0 = toWorld(chain.frame, p0);
    const a = await centroid(alone.graph);
    const c0 = projectPoint(lens, w0);
    const grab = { x: c0.x + 5 / size.width, y: c0.y + 3 / size.height }; // a finger is rarely dead centre
    const w1 = dragMove(lens, w0, grab, { x: grab.x + 55 / size.width, y: grab.y - 22 / size.height })!;
    const p1 = toLocal(chain.frame, w1).map((v) => Number(v.toFixed(3)));
    const moved = setShape(alone.graph, { posX: p1[0], posY: p1[1], posZ: p1[2] });
    const b = await centroid(moved);
    console.log(`drag ${name}: drawn moved by (${(b.x - a.x).toFixed(2)}, ${(b.y - a.y).toFixed(2)}) px, asked (55, -22); local pos ${p1.join(', ')}`);
    expect(Math.abs(b.x - a.x - 55)).toBeLessThan(1.5);
    expect(Math.abs(b.y - a.y + 22)).toBeLessThan(1.5);
    // the move node and the scene are untouched by the drag: only the shape's own position changed
    expect(p1.some((v, i) => Math.abs(v - p0[i]) > 0.01)).toBe(true);
    // and the depth did not change: the world point stays in the plane of the screen through the shape
    const depth = (w: V3) => (w[0] - lens.pos[0]) * lens.fwd[0] + (w[1] - lens.pos[1]) * lens.fwd[1] + (w[2] - lens.pos[2]) * lens.fwd[2];
    expect(Math.abs(depth(w1) - depth(w0))).toBeLessThan(1e-6);
  });

  it(`${name}: CPU picking agrees with the GPU: the hit distance equals the depth picture, and the right shape is named`, TO, async () => {
    const t = await T();
    const full = await build(true, { radius: 0.3 }, size);
    const view = await viewOf(full.graph, size);
    const lens = lensOf(view.camera, size.width, size.height);
    const depth = (await t.evalGraph(full.graph, 'sc', { port: 'depth', seconds: 0 })) as ImageValue;
    const half = await t.gpu.readFloat(depth);
    const read = Array.from(half, halfToFloat);
    let checked = 0;
    const ids = new Set<string>();
    let maxErr = 0;
    for (let py = 8; py < size.height; py += 6) {
      for (let px = 8; px < size.width; px += 6) {
        const ray = rayAt(lens, (px + 0.5) / size.width, (py + 0.5) / size.height);
        const hit = ray ? sdfRay(view.root, ray.ro, ray.rd) : null;
        const i = (py * size.width + px) * 4;
        const gpuHit = read[i + 3] > 0.5;
        // pixels on a silhouette edge may disagree about hit or miss; where both hit, the distance must agree
        if (hit && gpuHit) {
          expect(Math.abs(hit.t - read[i]), `pixel ${px},${py}`).toBeLessThan(0.04);
          maxErr = Math.max(maxErr, Math.abs(hit.t - read[i]));
          ids.add(hit.id);
          checked++;
        }
      }
    }
    console.log(`depth ${name}: ${checked} sample pixels hit by both, largest CPU/GPU difference ${maxErr.toFixed(4)}`);
    expect(checked).toBeGreaterThan(30);
    // both shapes were found somewhere in the sample (the big one under the Move, and the other)
    const aim = (id: string): string | null => {
      const ch = chainOf(view.root, id)!;
      const own = id.endsWith('shape1') ? [SHAPE.posX, SHAPE.posY, SHAPE.posZ] : [-0.6, -0.4, 0];
      const c = projectPoint(lens, toWorld(ch.frame, own as V3));
      const ray = rayAt(lens, c.x, c.y)!;
      return sdfRay(view.root, ray.ro, ray.rd)?.id ?? null;
    };
    expect(aim('sc/shape1')).toBe('sc/shape1');
    expect(aim('sc/other')).toBe('sc/other');
  });
}

describe('turning and sizing under a turned parent', () => {
  it('Turn moves the shape in WORLD space and writes its own angles back (the parent turn is taken off)', () => {
    const lens = { right: [1, 0, 0] as V3, up: [0, 1, 0] as V3, fwd: [0, 0, 1] as V3 };
    const parent = mul3(matrixOf([10, 50, -20]), matrixOf([0, 0, 30]));
    const rot0: Euler = [20, -30, 70];
    const out = turnTrackball(lens, rot0, 80, 0, 100, rot0, parent);
    // the world rotation after the drag = a turn of 0.8 rad about the screen axis (up x) of the world rotation before it
    const before = mul3(parent, matrixOf(rot0));
    const want = mul3(axisAngle([0, -80, 0], 0.8), before);
    const got = mul3(parent, matrixOf(out));
    for (let i = 0; i < 9; i++) expect(got[i]).toBeCloseTo(want[i], 5);
    // the roll ring: a quarter turn about the line of sight
    const r = turnRoll(lens, rot0, Math.PI / 2, rot0, parent);
    const wantRoll = mul3(axisAngle(lens.fwd, Math.PI / 2), before);
    const gotRoll = mul3(parent, matrixOf(r));
    for (let i = 0; i < 9; i++) expect(gotRoll[i]).toBeCloseTo(wantRoll[i], 5);
    // no parent: the same answer the 3D nodes always got
    expect(turnRoll(lens, rot0, 0.3)).toEqual(turnRoll(lens, rot0, 0.3, rot0, [1, 0, 0, 0, 1, 0, 0, 0, 1]));
  });
});
