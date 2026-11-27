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
const { createGraph, connect } = await import('../../engine/graph');
const { createArEditHost } = await import('./arEdit');
const { normalizeBodies } = await import('../../engine/lib/physics/sim');
const { physicsOf } = await import('../../engine/lib/physics/objects');
import type { Io } from '../../io/api';
import type { Vec3 } from '../../engine/lib/motion-math';
import type { WorldMoment } from '../../engine/lib/world-take';
import { sceneToWorld } from '../../engine/lib/xr-math';
import { matrixOf, apply3 } from '../viewer/gizmoMath';

const registry = new Registry();
registerBuiltins(registry);

const FIT = { unit: 0.25, lift: 1 };
const MOMENT = { view: { p: [0, 1.4, 0], q: [0, 0, 0, 1] }, lens: [1.9, 1.07, 0, 0], object: { p: [0, 0, -1.5], q: [0, 0, 0, 1], scale: 1 } } as unknown as WorldMoment;
const ray = (origin: Vec3, target: Vec3) => {
  const d = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const n = Math.hypot(...d);
  return { origin, dir: d.map((v) => v / n) as Vec3 };
};

function setup(evaluate: (graph: unknown, node: string, o: { port?: string }) => Promise<unknown> = async () => null) {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) }, evaluate } as unknown as Io;
  const ed = new Editor(io);
  ed.loadGraph(createGraph('t'));
  const obj = (shape: string, params: Record<string, unknown> = {}) => {
    ed.select([]);
    const id = ed.addNodeAt('object-3d', { x: 400, y: 0 })!;
    ed.setParams(id, { shape, ...params });
    return id;
  };
  return { io, ed, obj };
}
type Ed = InstanceType<typeof Editor>;
const params = (ed: Ed, id: string) => ed.level.nodes.find((n) => n.id === id)!.params;
const hostOf = (ed: Ed, io: Io, cam: string) => createArEditHost({ io, ed } as never, cam);
const front = (target: Vec3): { origin: Vec3; dir: Vec3 } => ray([0, 0.4, 2], target); // a ray in scene units from in front of the scene

describe('which objects count, and when the switch is useful', () => {
  it('one object: not useful; two on the camera: useful; an object NOT wired to the camera is not counted', () => {
    const t = setup();
    const a = t.obj('cube');
    const cam = t.ed.showInAr(a)!;
    const host = hostOf(t.ed, t.io, cam);
    expect(host.available()).toBe(false);
    const b = t.obj('sphere');
    expect(host.available()).toBe(false); // b has no camera wire: it is not on this camera
    t.ed.showInAr(b, cam);
    expect(host.available()).toBe(true);
  });

  it('a Physics node that drives the one object makes it useful', () => {
    const t = setup();
    const a = t.obj('cube');
    const cam = t.ed.showInAr(a)!;
    const host = hostOf(t.ed, t.io, cam);
    expect(host.available()).toBe(false);
    t.ed.setObjectPhysics(a, 'falls');
    expect(host.available()).toBe(true);
  });
});

describe('pick and move one object, one undo step per gesture', () => {
  it('picks the object whose ball the ray goes through, the nearest first; nothing = null', async () => {
    const t = setup();
    const a = t.obj('cube', { posX: -1 });
    const b = t.obj('sphere', { posX: 1, posZ: 1 });
    const cam = t.ed.showInAr([a, b])!;
    const host = hostOf(t.ed, t.io, cam);
    const got = await host.pick(front([1, 0, 1]), MOMENT, 0);
    expect(got?.id).toBe(b);
    expect(got?.name).toBe('3D Object Sphere');
    expect(got?.centre).toEqual([1, 0, 1]);
    expect((await host.pick(front([-1, 0, 0]), MOMENT, 0))?.id).toBe(a);
    expect(await host.pick(front([0, 6, -4]), MOMENT, 0)).toBeNull();
  });

  it('moves B only; one begin..end is ONE undo step; undo works after leaving AR (a fresh host)', async () => {
    const t = setup();
    const a = t.obj('cube', { posX: -1 });
    const b = t.obj('sphere', { posX: 1 });
    const cam = t.ed.showInAr([a, b])!;
    const host = hostOf(t.ed, t.io, cam);
    await host.pick(front([1, 0, 0]), MOMENT, 0);
    const rotY0 = params(t.ed, b).rotY;
    host.begin(b);
    for (const x of [1.1, 1.4, 1.9]) host.apply(b, { move: [x, 0.5, 0.25] });
    host.apply(b, { move: [2, 0.5, 0.25] });
    host.end(b);
    expect([params(t.ed, b).posX, params(t.ed, b).posY, params(t.ed, b).posZ]).toEqual([2, 0.5, 0.25]);
    expect(params(t.ed, a).posX).toBe(-1);
    expect(params(t.ed, b).rotY).toBe(rotY0);
    expect(host.selected(b)!.centre).toEqual([2, 0.5, 0.25]);
    t.ed.undo(); // the whole gesture
    expect([params(t.ed, b).posX, params(t.ed, b).posY ?? 0, params(t.ed, b).posZ ?? 0]).toEqual([1, 0, 0]);
    t.ed.redo();
    expect(params(t.ed, b).posX).toBe(2);
    // two gestures in a row are two steps
    host.begin(b);
    host.apply(b, { move: [3, 0.5, 0.25] });
    host.end(b);
    host.begin(b);
    host.apply(b, { move: [4, 0.5, 0.25] });
    host.end(b);
    t.ed.undo();
    expect(params(t.ed, b).posX).toBe(3);
    t.ed.undo();
    expect(params(t.ed, b).posX).toBe(2);
  });

  it('turns about the UP axis of the room even when the object is tilted: the same turn the Everything twist makes', async () => {
    const t = setup();
    const a = t.obj('cube', { posX: -3 });
    const b = t.obj('cube', { rotX: 30, rotY: 0, rotZ: 20 });
    const cam = t.ed.showInAr([a, b])!;
    const host = hostOf(t.ed, t.io, cam);
    await host.pick(front([0, 0, 0]), MOMENT, 0);
    const rot0: [number, number, number] = [30, 0, 20];
    host.begin(b);
    host.apply(b, { turn: 20 });
    host.apply(b, { turn: 40 });
    host.end(b);
    const rot1: [number, number, number] = [Number(params(t.ed, b).rotX), Number(params(t.ed, b).rotY), Number(params(t.ed, b).rotZ)];
    expect(rot1[1]).not.toBe(0);
    // a point of the object: turned by the node, and turned by a twist of the whole frame (object in the middle of the frame), must land on the same spot
    const pl = { p: [0, 0, -1.5] as Vec3, q: [0, 0, 0, 1] as [number, number, number, number], yaw: 0, scale: 1 };
    const d: Vec3 = [0.7, 0.4, -0.3];
    const before = apply3(matrixOf(rot0), d);
    const want = sceneToWorld(before, { ...pl, yaw: 40 }, FIT);
    const got = sceneToWorld(apply3(matrixOf(rot1), d), pl, FIT);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 2);
    // and it is not just Rotate Y: a tilted object's other angles changed too
    expect(rot1[0]).not.toBeCloseTo(rot0[0], 1);
  });

  it('resizes only the picked object (Object scale), clamped to the field', async () => {
    const t = setup();
    const a = t.obj('cube', { objectScale: 1, posX: -3 });
    const b = t.obj('cube', { objectScale: 2 });
    const cam = t.ed.showInAr([a, b])!;
    const host = hostOf(t.ed, t.io, cam);
    await host.pick(front([0, 0, 0]), MOMENT, 0);
    host.begin(b);
    host.apply(b, { scale: 1.5 });
    host.apply(b, { scale: 1.25 });
    host.end(b);
    expect(params(t.ed, b).objectScale).toBe(2.5);
    expect(params(t.ed, a).objectScale).toBe(1);
    host.begin(b);
    host.apply(b, { scale: 1e6 });
    host.end(b);
    expect(Number(params(t.ed, b).objectScale)).toBeLessThanOrEqual(1000);
  });

  it('what a wire decides is reported locked (only that part), and the others are not', async () => {
    const t = setup();
    const a = t.obj('cube', { posX: -3 });
    const b = t.obj('sphere');
    const cam = t.ed.showInAr([a, b])!;
    const num = t.ed.addNodeAt('value', { x: 0, y: 0 })!;
    t.ed.edit((g) => connect(g, registry, { node: num, port: 'value' }, { node: b, port: 'posX' }));
    const host = hostOf(t.ed, t.io, cam);
    expect((await host.pick(front([0, 0, 0]), MOMENT, 0))?.id).toBe(b);
    expect(host.selected(b)!.locked).toEqual({ move: true, turn: false, size: false });
    await host.pick(front([-3, 0, 0]), MOMENT, 0);
    expect(host.selected(a)!.locked).toEqual({ move: false, turn: false, size: false });
  });
});


describe('a falling object', () => {
  it('is picked where the live run has it, and the gestures edit the start pose of its body, in one undo step', async () => {
    const calls: string[] = [];
    const t = setup(async (_g, node, o) => {
      calls.push(`${node}:${o.port}`);
      return { kind: 'motion', pos: [0, -0.6, 0], rot: [0, 0, 0] }; // it has fallen to y = -0.6
    });
    const a = t.obj('cube', { posX: -2 });
    const b = t.obj('sphere', { posY: 2 });
    const cam = t.ed.showInAr([a, b])!;
    const phys = t.ed.setObjectPhysics(b, 'falls')!;
    expect(physicsOf(t.ed.level, b)).toBeTruthy();
    const host = hostOf(t.ed, t.io, cam);
    // the ray goes through where it is NOW (y -0.6), not through where it starts (y 2)
    const picked = await host.pick(front([0, -0.6, 0]), MOMENT, 3);
    expect(picked?.id).toBe(b);
    expect(picked?.physics).toBe(true);
    expect(calls).toEqual([`${phys}:motion1`]);
    expect(picked?.centre[1]).toBeCloseTo(2, 6); // what is edited is the start pose
    expect(picked?.locked).toEqual({ move: false, turn: false, size: false }); // its Move is wired to Physics by design
    expect(await host.pick(front([0, 2, 0]), MOMENT, 3)).toBeNull(); // nothing is left at the start
    await host.pick(front([0, -0.6, 0]), MOMENT, 3);
    host.begin(b);
    host.apply(b, { move: [1, 3, -1] });
    host.apply(b, { move: [1.5, 3.5, -1] });
    host.apply(b, { turn: 15 });
    host.end(b);
    const body = normalizeBodies(t.ed.level.nodes.find((n) => n.id === phys)!.params.bodies)[0];
    expect(body.pos).toEqual([1.5, 3.5, -1]);
    expect(body.rot[1]).not.toBe(0);
    expect(params(t.ed, b).posX).toBe(1.5);
    expect(params(t.ed, a).posX).toBe(-2);
    t.ed.undo();
    const back = normalizeBodies(t.ed.level.nodes.find((n) => n.id === phys)!.params.bodies)[0];
    expect(back.pos).toEqual([0, 2, 0]);
    expect(params(t.ed, b).posY).toBe(2);
  });
});

describe('a shape of an SDF Scene on the camera', () => {
  it('is picked with the existing ray test and moved through the scene it sits in (a parent that is moved, turned and scaled)', async () => {
    // the scene's tree as the engine would evaluate it: everything inside a Move of 1 along x and a size of 2
    const evalRoot = (shapeId: string, pos: Vec3) => ({
      kind: 'sdf',
      root: { t: 'move', id: 'sc/m', pos: [1, 0, 0], rot: [0, 0, 0], scale: 2, child: { t: 'shape', id: shapeId, shape: 'sphere', pos, rot: [0, 0, 0], size: [0.5, 0.5, 0.5], scale: 1, color: [1, 1, 1] } },
    });
    const t = setup();
    const scene = t.ed.addNodeAt('sdf-scene', { x: 0, y: 0 })!;
    const other = t.obj('cube', { posX: -3 });
    const cam = t.ed.showInAr(other)!;
    t.ed.setCameraOf([scene], cam);
    t.ed.enterGroup(scene);
    const shape = t.ed.level.nodes.find((n) => n.type === 'sdf-shape')!;
    t.ed.setParams(shape.id, { posX: 0.5, posY: 0, posZ: 0 });
    const second = t.ed.addNodeAt('sdf-shape', { x: 0, y: 200 })!;
    t.ed.exitGroup(0);
    // rebuild the host's io around the shape's real id
    const ev = async () => evalRoot(`${scene}/${shape.id}`, [0.5, 0, 0]);
    const io2 = { ...t.io, evaluate: ev } as unknown as Io;
    const host = hostOf(t.ed, io2, cam);
    expect(host.available()).toBe(true); // two things on the camera, and a scene with two shapes
    // the shape stands at 1 + 2 * 0.5 = 2 in the scene's space
    const got = await host.pick(ray([2, 0, 4], [2, 0, 0]), MOMENT, 0);
    expect(got?.id).toBe(`${scene}/${shape.id}`);
    expect(got?.centre[0]).toBeCloseTo(2, 6);
    expect(second).toBeTruthy();
    host.begin(got!.id);
    host.apply(got!.id, { move: [3, 0, 0] }); // 1 further in the scene = 0.5 further in the shape's own numbers
    host.end(got!.id);
    t.ed.enterGroup(scene);
    expect(params(t.ed, shape.id).posX).toBeCloseTo(1, 3);
    t.ed.exitGroup(0);
    t.ed.undo(); // the write was made from outside the group: it is its own undo step
    t.ed.enterGroup(scene);
    expect(params(t.ed, shape.id).posX).toBeCloseTo(0.5, 3);
  });
});
