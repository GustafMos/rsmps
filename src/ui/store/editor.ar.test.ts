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
const { createGraph } = await import('../../engine/graph');
const { cameraRows, cameraSource, roomLightFor } = await import('../../engine/lib/ar-setup');
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);
function setup() {
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) } } as unknown as Io;
  const ed = new Editor(io);
  ed.loadGraph(createGraph('t'));
  return ed;
}
type Ed = InstanceType<typeof Editor>;
const ofType = (ed: Ed, t: string) => ed.level.nodes.filter((n) => n.type === t);
const camEdges = (ed: Ed) => ed.level.edges.filter((e) => e.to.port === 'camera').map((e) => `${e.from.node}>${e.to.node}`);
const obj = (ed: Ed, y = 0) => {
  ed.select([]);
  return ed.addNodeAt('object-3d', { x: 400, y })!;
};
const name = (n: { id: string }) => n.id;

describe('Show in AR makes real wires', () => {
  it('from an empty project: a camera, ONE wire, the shadow, the object viewed, one undo step', () => {
    const ed = setup();
    const o = obj(ed);
    const ar = ed.showInAr(o)!;
    expect(ofType(ed, 'world-ar').map((n) => n.id)).toEqual([ar]);
    expect(camEdges(ed)).toEqual([`${ar}>${o}`]);
    expect(ed.level.nodes.find((n) => n.id === o)!.params.groundShadow).toBe(true);
    expect(ed.state.viewedNodeId).toBe(o);
    expect(cameraSource(ed.level, registry, o).camera?.id).toBe(ar);
    expect(roomLightFor(ed.level, registry, o)).toBe('on');
    ed.undo();
    expect(ofType(ed, 'world-ar')).toHaveLength(0);
    expect(camEdges(ed)).toEqual([]);
    expect(ed.level.nodes.find((n) => n.id === o)!.params.groundShadow).toBe(false);
  });

  it('a second object is put in AR with ONE call: its wire is real; nothing else changes', () => {
    const ed = setup();
    const a = obj(ed);
    const ar = ed.showInAr(a)!;
    const b = obj(ed, 200);
    expect(camEdges(ed)).toEqual([`${ar}>${a}`]); // adding an object wires nothing by itself
    ed.showInAr(b, ar);
    expect(camEdges(ed).sort()).toEqual([`${ar}>${a}`, `${ar}>${b}`].sort());
    expect(ofType(ed, 'world-ar')).toHaveLength(1);
  });

  it('several selected objects get one camera in one undo step', () => {
    const ed = setup();
    const a = obj(ed);
    const b = obj(ed, 200);
    const ar = ed.showInAr([a, b])!;
    expect(camEdges(ed).sort()).toEqual([`${ar}>${a}`, `${ar}>${b}`].sort());
    ed.undo();
    expect(ofType(ed, 'world-ar')).toHaveLength(0);
    expect(camEdges(ed)).toEqual([]);
  });
});

describe('the list of a camera: ticks make and remove real wires', () => {
  it('ticking, switching between two cameras, All / None, each one undo step', () => {
    const ed = setup();
    const a = obj(ed);
    const b = obj(ed, 200);
    const ar = ed.showInAr(a)!;
    const cam2 = ed.addNodeAt('camera', { x: 0, y: 400 })!;
    const rows = (id: string) => Object.fromEntries(cameraRows(ed.level, registry, id, name).map((r) => [r.id, r.state]));
    expect(rows(ar)).toEqual({ [a]: 'yes', [b]: 'no' });
    ed.setCameraOf([b], ar); // tick
    expect(rows(ar)[b]).toBe('yes');
    expect(camEdges(ed)).toContain(`${ar}>${b}`);
    ed.setCameraOf([b], cam2); // the other camera's tick moves the wire: still ONE wire into b
    expect(camEdges(ed).filter((e) => e.endsWith(`>${b}`))).toEqual([`${cam2}>${b}`]);
    expect(rows(ar)[b]).toBe('other');
    expect(cameraRows(ed.level, registry, ar, (n) => `Camera ${n.id === cam2 ? 2 : 1}`).find((r) => r.id === b)!.other).toBe('Camera 2');
    ed.undo();
    expect(camEdges(ed)).toContain(`${ar}>${b}`);
    ed.setCameraOf([b], null); // untick
    expect(camEdges(ed).filter((e) => e.endsWith(`>${b}`))).toEqual([]);
    ed.setCameraAll(cam2, true); // All: only nodes without a camera wire
    expect(camEdges(ed).sort()).toEqual([`${ar}>${a}`, `${cam2}>${b}`].sort());
    ed.setCameraAll(cam2, false); // None
    expect(camEdges(ed)).toEqual([`${ar}>${a}`]);
  });

  it('through Physics: shown as such, and the real floor needs the Physics node wired to the camera only', () => {
    const ed = setup();
    const o = obj(ed);
    const ar = ed.showInAr(o)!;
    const phys = ed.setObjectPhysics(o, 'falls')!;
    ed.setCameraOf([phys], ar);
    // the object has its own wire too (made by Show in AR): it is direct; remove it to see the Physics path
    ed.setCameraOf([o], null);
    expect(cameraSource(ed.level, registry, o).kind).toBe('physics');
    expect(cameraRows(ed.level, registry, ar, name).find((r) => r.id === o)!.state).toBe('physics');
  });
});

describe('light per camera', () => {
  it('the ordinary Camera node lights its objects only when its switch is on', () => {
    const ed = setup();
    const o = obj(ed);
    const cam = ed.addNodeAt('camera', { x: 0, y: 0 })!;
    ed.setCameraOf([o], cam);
    expect(roomLightFor(ed.level, registry, o)).toBeNull();
    ed.setParam(cam, 'lightOn', true);
    expect(roomLightFor(ed.level, registry, o)).toBe('on');
    ed.setParam(o, 'lightFromCamera', false);
    expect(roomLightFor(ed.level, registry, o)).toBe('off');
  });
});
