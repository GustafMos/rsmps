/**
 * "Move: One object" in the AR view, against the fake XR session and a plain in-memory host (no GPU, no editor): tapping picks the
 * object that is drawn under the finger, a drag / the Height strip / a twist / a pinch change only that one, each gesture is one
 * begin and one end, a wire's lock refuses with a sentence, a falling object is held at its start while a finger has it and falls again
 * when the finger lets go, and recording switches the mode off. The editor side (real params, undo) is in ui/store/arEdit.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { raySphere } from '../../engine/lib/ar-pick';
import { qAxisAngle, type Vec3 } from '../../engine/lib/motion-math';
import type { WorldMoment } from '../../engine/lib/world-take';
import { depthOf, lensOf, project, projectionMatrix, sceneToWorld, type Corners, type Placement, type SceneFit, type XrPose } from '../../engine/lib/xr-math';
import type { ArChange, ArEditHost, ArSelected } from './edit-host';
import { FakeXrSession, fakeTransform } from './fake-xr';
import { ArLoop, type ArPainter, type ArPicture, type ArPictureSource } from './loop';
import { liftedPlacement } from './placement';
import { featuresOf } from './xr-api';

const FLOOR: XrPose = { p: [0, 0, -1.5], q: [0, 0, 0, 1] };
const EYE: XrPose = { p: [0, 1.4, 0], q: qAxisAngle('x', -40) };
const FIT: SceneFit = { unit: 0.25, lift: 1 };
const SCREEN = { width: 360, height: 640 };
const later = () => new Promise((r) => setTimeout(r, 0));

class Painter implements ArPainter {
  rings: Corners[] = [];
  begin() {
    this.rings = [];
  }
  picture() {}
  ring(c: Corners) {
    this.rings.push(c);
  }
  camera() {
    return { canvas: true };
  }
}
class Source implements ArPictureSource {
  moments: WorldMoment[] = [];
  private seq = 0;
  private last: ArPicture | null = null;
  request(req: { moment: WorldMoment; depth: number; size: { width: number; height: number } }): boolean {
    this.moments.push(req.moment);
    this.last = { moment: req.moment, depth: req.depth, width: req.size.width, height: req.size.height, seq: ++this.seq };
    return true;
  }
  latest() {
    return this.last;
  }
  error() {
    return null;
  }
}

interface Thing {
  name: string;
  centre: Vec3;
  radius: number;
  physics: boolean;
  locked: { move: boolean; turn: boolean; size: boolean };
}
/** Two or three things in scene units, and a log of what the view asked of them. */
class MemHost implements ArEditHost {
  things = new Map<string, Thing>();
  log: string[] = [];
  changes: ArChange[] = [];
  usable = true;
  placement: Placement | null = null;
  available() {
    return this.usable;
  }
  fit() {
    return FIT;
  }
  async pick(ray: { origin: Vec3; dir: Vec3 }): Promise<ArSelected | null> {
    let best: { t: number; id: string } | null = null;
    for (const [id, t] of this.things) {
      const d = raySphere(ray.origin, ray.dir, t.centre, t.radius);
      if (d !== null && (!best || d < best.t)) best = { t: d, id };
    }
    return best ? this.selected(best.id) : null;
  }
  selected(id: string): ArSelected | null {
    const t = this.things.get(id);
    return t ? { id, name: t.name, centre: [...t.centre] as Vec3, radius: t.radius, half: 0.9, physics: t.physics, locked: t.locked } : null;
  }
  begin(id: string) {
    this.log.push(`begin ${id}`);
  }
  apply(id: string, c: ArChange) {
    this.changes.push(c);
    if (c.move) this.things.get(id)!.centre = c.move;
  }
  end(id: string) {
    this.log.push(`end ${id}`);
  }
}

function setup(o: { physics?: boolean } = {}) {
  const session = new FakeXrSession();
  session.viewer = EYE;
  const source = new Source();
  const painter = new Painter();
  const host = new MemHost();
  host.things.set('A', { name: '3D Object Cube', centre: [-0.9, 0, 0], radius: 0.6, physics: false, locked: { move: false, turn: false, size: false } });
  host.things.set('B', { name: '3D Object Sphere', centre: [0.8, 0.2, 0.5], radius: 0.6, physics: !!o.physics, locked: { move: false, turn: false, size: false } });
  let clock = 0;
  const loop = new ArLoop({
    session,
    referenceSpace: { space: 'local' },
    hitTestSource: { source: 'viewer' },
    layer: session.layer,
    features: featuresOf(session),
    painter,
    source,
    show: { kind: 'layer' },
    maxSide: 960,
    seconds: () => clock / 1000,
    physics: o.physics,
    predictPose: false,
    now: () => clock,
    makeTransform: fakeTransform,
    screen: () => SCREEN,
    edit: host,
    onState: () => undefined,
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock += 33;
      session.step(33);
    }
  };
  loop.start();
  session.hit = FLOOR;
  step();
  loop.placeHere();
  step();
  return { session, source, painter, host, loop, step };
}
/** The lens the fake session reports (the same numbers the loop reads back from the projection matrix). */
const lensOfSession = (s: FakeXrSession) => lensOf(projectionMatrix(s.lens));
const placementOf = (t: ReturnType<typeof setup>): Placement => liftedPlacement(t.loop.placement!);
/** The screen point (CSS pixels) where a scene point is drawn from the phone's pose. */
const pixelOf = (t: ReturnType<typeof setup>, scene: Vec3): { x: number; y: number } => {
  const p = project(EYE, lensOfSession(t.session), sceneToWorld(scene, placementOf(t), FIT))!;
  return { x: ((p[0] + 1) / 2) * SCREEN.width, y: ((1 - p[1]) / 2) * SCREEN.height };
};
const tap = async (t: ReturnType<typeof setup>, at: { x: number; y: number }) => {
  t.loop.gesture({ type: 'tap', ...at });
  t.step();
  await later();
  t.step();
};

describe('the Move switch state', () => {
  it('is absent without an edit host, shown when there is more than one thing, and default Everything', () => {
    const t = setup();
    expect(t.loop.state().edit).toEqual({ available: true, mode: 'all', selected: null, note: null, locked: false, editing: false });
    t.host.usable = false;
    expect(t.loop.state().edit!.available).toBe(false);
    // no host at all
    const session = new FakeXrSession();
    const bare = new ArLoop({ session, referenceSpace: {}, hitTestSource: null, layer: session.layer, features: featuresOf(session), painter: new Painter(), source: new Source(), show: { kind: 'layer' }, maxSide: 960, seconds: () => 0, now: () => 0, screen: () => SCREEN, onState: () => undefined });
    expect(bare.state().edit).toBeUndefined();
  });
});

describe('Everything mode is as before', () => {
  it('a drag moves the whole placement and never calls the host', async () => {
    const t = setup();
    const before = [...t.loop.placement!.p];
    t.loop.gesture({ type: 'drag-start', x: 180, y: 400 });
    t.loop.gesture({ type: 'drag', x: 230, y: 420 });
    t.step();
    t.loop.gesture({ type: 'drag-end' });
    t.step();
    expect(t.loop.placement!.p).not.toEqual(before);
    expect(t.host.log).toEqual([]);
    expect(t.host.changes).toEqual([]);
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre)); // a tap while placed does not pick anything either
    expect(t.loop.state().edit!.selected).toBeNull();
  });
});

describe('One object: pick and move', () => {
  it('tapping where B is drawn picks B; empty space deselects; tapping A switches', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    t.step();
    expect(t.loop.state().hint).toBe('Tap an object to move it.');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    expect(t.loop.state().edit!.selected).toBe('3D Object Sphere');
    expect(t.loop.state().hint).toContain('Drag to move it');
    await tap(t, pixelOf(t, t.host.things.get('A')!.centre));
    expect(t.loop.state().edit!.selected).toBe('3D Object Cube');
    await tap(t, { x: 20, y: 40 }); // the sky
    expect(t.loop.state().edit!.selected).toBeNull();
  });

  it('draws a ring on the floor under the picked object and a small one at its middle, following it', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    t.step();
    expect(t.painter.rings).toHaveLength(0);
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    t.step();
    expect(t.painter.rings).toHaveLength(2);
    const mid = (c: Corners) => [0, 1, 2].map((i) => (c[0][i] + c[3][i]) / 2);
    const centre = sceneToWorld(t.host.things.get('B')!.centre, placementOf(t), FIT);
    expect(mid(t.painter.rings[0])[0]).toBeCloseTo(centre[0], 5);
    expect(mid(t.painter.rings[0])[1]).toBeCloseTo(0, 5); // on the floor
    expect(mid(t.painter.rings[1])[1]).toBeCloseTo(centre[1], 5);
  });

  it('a one-finger drag keeps B under the finger (a few pixels), and leaves A and the placement alone', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    const a0 = [...t.host.things.get('A')!.centre];
    const place0 = JSON.stringify(t.loop.placement);
    const from = pixelOf(t, t.host.things.get('B')!.centre);
    let worst = 0;
    t.loop.gesture({ type: 'drag-start', x: from.x, y: from.y });
    for (const [dx, dy] of [[10, 5], [30, 20], [60, 30], [-40, 50]]) {
      const f = { x: from.x + dx, y: from.y + dy };
      t.loop.gesture({ type: 'drag', ...f });
      t.step();
      const now = pixelOf(t, t.host.things.get('B')!.centre);
      worst = Math.max(worst, Math.hypot(now.x - f.x, now.y - f.y));
    }
    t.loop.gesture({ type: 'drag-end' });
    t.step();
    expect(worst).toBeLessThan(1); // exact on the plane through its middle: far inside the "few pixels" asked for
    expect(t.host.things.get('A')!.centre).toEqual(a0);
    expect(JSON.stringify(t.loop.placement)).toBe(place0);
    expect(t.host.things.get('B')!.centre[1]).toBeCloseTo(0.2, 9); // it stays at its height above the floor
    expect(t.host.log).toEqual(['begin B', 'end B']); // ONE gesture
  });

  it('the Height strip raises only B by the right amount (metres to scene units), one gesture', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    const y0 = t.host.things.get('B')!.centre[1];
    const world0 = sceneToWorld(t.host.things.get('B')!.centre, placementOf(t), FIT);
    t.loop.gesture({ type: 'lift', dy: 60 });
    t.loop.gesture({ type: 'lift', dy: 40 });
    t.step();
    t.loop.gesture({ type: 'edit-end' });
    t.step();
    const metres = (100 * 2 * Math.max(0.2, depthOf(EYE, world0))) / (lensOfSession(t.session)[1] * SCREEN.height);
    const world1 = sceneToWorld(t.host.things.get('B')!.centre, placementOf(t), FIT);
    expect(world1[1] - world0[1]).toBeCloseTo(metres, 6);
    expect(t.host.things.get('B')!.centre[1] - y0).toBeCloseTo(metres / FIT.unit, 6); // placement scale 1: 0.25 m per scene unit
    expect(t.host.things.get('A')!.centre[1]).toBe(0);
    expect(t.loop.state().height).toBe(0); // the placement's own height is untouched
    expect(t.host.log).toEqual(['begin B', 'end B']);
  });

  it('a double tap on the Height strip puts it back on the floor', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    t.loop.gesture({ type: 'lift-reset' });
    t.step();
    t.loop.gesture({ type: 'edit-end' });
    expect(t.host.things.get('B')!.centre[1]).toBeCloseTo(-FIT.lift + 0.9, 9);
  });

  it('twist and pinch change only the picked one (the totals since the gesture began)', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    const yaw0 = t.loop.placement!.yaw;
    t.loop.gesture({ type: 'twist', deg: 10 });
    t.loop.gesture({ type: 'twist', deg: 5 });
    t.loop.gesture({ type: 'pinch', factor: 1.2 });
    t.loop.gesture({ type: 'pinch', factor: 1.5 });
    t.step();
    t.loop.gesture({ type: 'edit-end' });
    t.step();
    expect(t.host.changes).toEqual([{ turn: 10 }, { turn: 15 }, { scale: 1.2 }, { scale: 1.2 * 1.5 }]);
    expect(t.host.log).toEqual(['begin B', 'end B']);
    expect(t.loop.placement!.scale).toBe(1); // the placed frame did not resize
    expect(t.loop.placement!.yaw).toBe(yaw0);
  });

  it('with nothing picked the gestures do nothing but say what to do', async () => {
    const t = setup();
    const p0 = JSON.stringify(t.loop.placement);
    t.loop.setMoveMode('one');
    t.loop.gesture({ type: 'drag-start', x: 100, y: 300 });
    t.loop.gesture({ type: 'drag', x: 150, y: 330 });
    t.loop.gesture({ type: 'lift', dy: 30 });
    t.step();
    expect(t.host.changes).toEqual([]);
    expect(JSON.stringify(t.loop.placement)).toBe(p0);
    expect(t.loop.state().edit!.note).toBe('Tap an object to move it.');
  });

  it('what a wire decides is refused with a sentence, and nothing is written', async () => {
    const t = setup();
    t.host.things.get('B')!.locked = { move: true, turn: false, size: false };
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    const from = pixelOf(t, t.host.things.get('B')!.centre);
    t.loop.gesture({ type: 'drag-start', x: from.x, y: from.y });
    t.loop.gesture({ type: 'drag', x: from.x + 40, y: from.y });
    t.step();
    expect(t.host.changes).toEqual([]);
    expect(t.host.log).toEqual([]);
    expect(t.loop.state().edit!.note).toBe('This one is moved by a wire.');
    t.loop.gesture({ type: 'twist', deg: 10 }); // turning is not wired: that one works
    t.step();
    expect(t.host.changes).toEqual([{ turn: 10 }]);
  });

  it('switching back to Everything forgets the pick and the gestures move the whole frame again', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    t.loop.setMoveMode('all');
    expect(t.loop.state().edit!.selected).toBeNull();
    const before = [...t.loop.placement!.p];
    t.loop.gesture({ type: 'drag-start', x: 180, y: 400 });
    t.loop.gesture({ type: 'drag', x: 230, y: 420 });
    t.step();
    expect(t.loop.placement!.p).not.toEqual(before);
  });
});

describe('One object and a falling object', () => {
  it('shows it at its start while a finger has it, and the fall begins again when the finger lets go', async () => {
    const t = setup({ physics: true });
    t.loop.setMoveMode('one');
    t.step(40); // it has been falling for a while
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    expect(t.loop.state().edit!.selected).toBe('3D Object Sphere');
    const clock = () => t.source.moments.at(-1)!.physics!;
    expect(clock()).toBeGreaterThan(1);
    const from = pixelOf(t, t.host.things.get('B')!.centre);
    t.loop.gesture({ type: 'drag-start', x: from.x, y: from.y });
    t.loop.gesture({ type: 'drag', x: from.x + 20, y: from.y });
    t.step(5);
    expect(clock()).toBe(0); // held: the start pose, not mid-fall
    expect(t.loop.state().edit!.editing).toBe(true);
    t.loop.gesture({ type: 'drag-end' });
    t.step(1);
    t.step(10);
    expect(clock()).toBeGreaterThan(0.2);
    expect(clock()).toBeLessThan(0.5); // a new fall from the moment of release, not the old 1.3 s
    expect(t.loop.state().edit!.editing).toBe(false);
  });

  it('a gesture on an ordinary object does not restart the fall of the others', async () => {
    const t = setup({ physics: true });
    t.loop.setMoveMode('one');
    t.step(40);
    await tap(t, pixelOf(t, t.host.things.get('A')!.centre));
    const from = pixelOf(t, t.host.things.get('A')!.centre);
    t.loop.gesture({ type: 'drag-start', x: from.x, y: from.y });
    t.loop.gesture({ type: 'drag', x: from.x + 20, y: from.y });
    t.step(3);
    t.loop.gesture({ type: 'drag-end' });
    t.step(3);
    expect(t.source.moments.at(-1)!.physics!).toBeGreaterThan(1.5);
  });
});

describe('One object and recording', () => {
  it('recording drops back to Everything and the switch stays off until it stops', async () => {
    const t = setup();
    t.loop.setMoveMode('one');
    await tap(t, pixelOf(t, t.host.things.get('B')!.centre));
    t.loop.startRecording(null, { fps: 30, asked: 30, clamped: false });
    expect(t.loop.state().edit).toMatchObject({ mode: 'all', selected: null, locked: true });
    t.loop.setMoveMode('one');
    expect(t.loop.state().edit!.mode).toBe('all');
    t.loop.stopRecording();
    expect(t.loop.state().edit!.locked).toBe(false);
    t.loop.setMoveMode('one');
    expect(t.loop.state().edit!.mode).toBe('one');
  });
});
