/** Raising and lowering the placed object (the Height gesture and strip), against the fake XR session. No GPU. */
import { describe, expect, it } from 'vitest';
import { qAxisAngle, type Vec3 } from '../../engine/lib/motion-math';
import { buildWorldTake, sampleWorldTake, type WorldMoment, type WorldSample } from '../../engine/lib/world-take';
import { depthOf, viewRay, rayPlane, type XrPose } from '../../engine/lib/xr-math';
import { FakeXrSession, fakeTransform } from './fake-xr';
import { ArLoop, type ArPainter, type ArPicture, type ArPictureSource } from './loop';
import { GestureReader, MAX_HEIGHT, MIN_HEIGHT, initialPlaceState, liftedPlacement, placeStep, type Gesture } from './placement';
import { featuresOf } from './xr-api';

const FLOOR: XrPose = { p: [0, 0, -1.5], q: [0, 0, 0, 1] };
const EYE: XrPose = { p: [0, 1.4, 0], q: qAxisAngle('x', -40) };
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], digits);
};

class Painter implements ArPainter {
  begin() {}
  picture() {}
  ring() {}
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

function setup() {
  const session = new FakeXrSession();
  session.viewer = EYE;
  const source = new Source();
  let clock = 0;
  const loop = new ArLoop({
    session,
    referenceSpace: { space: 'local' },
    hitTestSource: { source: 'viewer' },
    layer: session.layer,
    features: featuresOf(session),
    painter: new Painter(),
    source,
    show: { kind: 'layer' },
    maxSide: 960,
    seconds: () => clock / 1000,
    now: () => clock,
    makeTransform: fakeTransform,
    screen: () => ({ width: 360, height: 640 }),
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
  return { session, source, loop, step };
}
const object = (t: ReturnType<typeof setup>) => t.source.moments.at(-1)!.object!;
const later = () => new Promise((r) => setTimeout(r, 0));

describe('placement height', () => {
  it('lift and height events add, clamp and reset; placing again keeps it, Reset clears it', () => {
    const placed = placeStep(placeStep(initialPlaceState(), { type: 'frame', hit: FLOOR, tracking: true }), { type: 'place', viewer: [0, 1, 0] });
    expect(placed.placement!.h ?? 0).toBe(0);
    const up = placeStep(placeStep(placed, { type: 'lift', dh: 0.3 }), { type: 'lift', dh: 0.2 });
    expect(up.placement!.h).toBeCloseTo(0.5, 9);
    expect(placeStep(up, { type: 'lift', dh: 100 }).placement!.h).toBe(MAX_HEIGHT);
    expect(placeStep(up, { type: 'lift', dh: -100 }).placement!.h).toBe(MIN_HEIGHT);
    expect(placeStep(up, { type: 'height', to: 0 }).placement!.h).toBe(0);
    expect(placeStep(initialPlaceState(), { type: 'lift', dh: 1 }).placement).toBeNull();
    expect(placeStep(placeStep(up, { type: 'frame', hit: FLOOR, tracking: true }), { type: 'place', viewer: [0, 1, 0] }).placement!.h).toBeCloseTo(0.5, 9);
    expect(placeStep(up, { type: 'reset' }).placement).toBeNull();
    close(liftedPlacement(up.placement!).p, [0, 0.5, -1.5]);
  });
});

describe('two-finger classification', () => {
  const types = (g: Gesture[]) => g.map((x) => x.type);
  const two = () => {
    const r = new GestureReader();
    r.down(1, 120, 300, 0);
    r.down(2, 240, 300, 0);
    return r;
  };
  it('both fingers going up the screen lift, and nothing turns or resizes', () => {
    const r = two();
    const out: Gesture[] = [];
    for (let i = 1; i <= 10; i++) {
      out.push(...r.move(1, 120 + (i % 2), 300 - i * 6));
      out.push(...r.move(2, 240 - (i % 2), 300 - i * 6));
    }
    expect(types(out).every((t) => t === 'lift')).toBe(true);
    const dy = out.reduce((s, g) => s + (g.type === 'lift' ? g.dy : 0), 0);
    expect(dy).toBeGreaterThan(50);
  });
  it('a pinch or a twist does not lift', () => {
    const p = two();
    const gp = [...p.move(1, 100, 300), ...p.move(2, 260, 300), ...p.move(1, 80, 300), ...p.move(2, 280, 300)];
    expect(types(gp)).toContain('pinch');
    expect(types(gp)).not.toContain('lift');
    const w = two();
    const gw: Gesture[] = [];
    for (let i = 1; i <= 8; i++) gw.push(...w.move(2, 180 + 60 * Math.cos((i * 12 * Math.PI) / 180), 300 + 60 * Math.sin((i * 12 * Math.PI) / 180)));
    expect(types(gw)).toContain('twist');
    expect(types(gw)).not.toContain('lift');
  });
  it('small jitter stays inside the dead zone', () => {
    const r = two();
    expect([...r.move(1, 121, 301), ...r.move(2, 239, 299), ...r.move(1, 120, 300)]).toEqual([]);
  });
});

describe('lifting in the AR loop', () => {
  it('a vertical two-finger drag raises the object by the on-screen amount; scale and turn stay', () => {
    const t = setup();
    const yaw = t.loop.placement!.yaw;
    const r = new GestureReader();
    r.down(1, 120, 400, 0);
    r.down(2, 240, 400, 0);
    let sent = 0;
    for (let i = 1; i <= 12; i++) {
      for (const g of [...r.move(1, 120, 400 - i * 10), ...r.move(2, 240, 400 - i * 10)]) {
        t.loop.gesture(g);
        if (g.type === 'lift') sent += g.dy;
      }
    }
    t.step();
    expect(sent).toBeGreaterThan(80);
    const h = t.loop.placement!.h!;
    // roughly one on-screen pixel per pixel of finger travel: metres per pixel at the object's distance
    const mpp = (2 * depthOf(EYE, [0, h / 2, -1.5])) / (t.session.lens[1] * 640);
    expect(h).toBeGreaterThan(0.2);
    expect(Math.abs(h - sent * mpp)).toBeLessThan(0.15 * h);
    expect(t.loop.placement!.scale).toBe(1);
    expect(t.loop.placement!.yaw).toBeCloseTo(yaw, 9);
    t.step();
    close(object(t).p, [0, h, -1.5]); // what the engine camera sees is the raised object
    expect(t.loop.state().height).toBeCloseTo(h, 9);
  });

  it('pinch and twist do not change the height; the strip raises and lowers; double tap and Reset put it back', () => {
    const t = setup();
    t.loop.gesture({ type: 'pinch', factor: 1.5 });
    t.loop.gesture({ type: 'twist', deg: 20 });
    t.step();
    expect(t.loop.placement!.h ?? 0).toBe(0);
    t.loop.gesture({ type: 'lift', dy: 100 });
    t.step();
    const up = t.loop.placement!.h!;
    expect(up).toBeGreaterThan(0.2);
    t.loop.gesture({ type: 'lift', dy: -50 });
    t.step();
    expect(t.loop.placement!.h!).toBeLessThan(up);
    expect(t.loop.placement!.h!).toBeGreaterThan(0);
    t.loop.gesture({ type: 'lift-reset' });
    t.step();
    expect(t.loop.placement!.h).toBe(0);
    t.loop.gesture({ type: 'lift', dy: 100 });
    t.loop.reset();
    t.step();
    expect(t.loop.placement).toBeNull();
  });

  it('dragging along the floor afterwards keeps the height, also when the anchor moves', async () => {
    const t = setup();
    await later();
    t.step();
    t.loop.gesture({ type: 'lift', dy: 80 });
    t.step();
    const h = t.loop.placement!.h!;
    const o0 = object(t).p;
    t.loop.gesture({ type: 'drag-start', x: 180, y: 320 });
    t.loop.gesture({ type: 'drag', x: 260, y: 300 });
    t.step();
    const o1 = t.loop.placement!.p;
    expect(o1[0]).toBeGreaterThan(0.05);
    close([o1[1]], [0]); // the surface point stays on the floor
    expect(t.loop.placement!.h).toBeCloseTo(h, 9);
    t.step();
    close([object(t).p[1]], [h]);
    // the finger moves the object on its own (raised) plane
    const at = (x: number, y: number) => {
      const ray = viewRay(EYE, t.session.lens, (x / 360) * 2 - 1, 1 - (y / 640) * 2);
      return rayPlane(ray.origin, ray.dir, [0, h, -1.5], [0, 1, 0])!;
    };
    close([object(t).p[0] - o0[0], object(t).p[2] - o0[2]], [at(260, 300)[0] - at(180, 320)[0], at(260, 300)[2] - at(180, 320)[2]], 4);
    // the browser refines the anchor: the object keeps its offset and its height
    t.loop.gesture({ type: 'drag-end' });
    t.step();
    await later();
    t.step();
    const a = t.session.anchors.at(-1);
    expect(a).toBeTruthy();
    a!.pose = { p: [a!.pose.p[0] + 0.1, a!.pose.p[1], a!.pose.p[2]], q: a!.pose.q };
    t.step();
    close([t.loop.placement!.h!], [h]);
    close([t.loop.placement!.p[0] - o1[0]], [0.1], 4);
    t.step();
    close([object(t).p[1]], [h]);
  });

  it('the take records the raised object; playback matches live; a take without height is unchanged', () => {
    const t = setup();
    let n = 0;
    t.loop.startRecording({ push: () => n++ });
    for (let i = 0; i < 20; i++) {
      if (i === 8) t.loop.gesture({ type: 'lift', dy: 120 });
      t.step();
    }
    const samples = t.loop.stopRecording()!.samples as WorldSample[];
    const take = buildWorldTake(samples, { fps: 30 })!;
    expect(Math.max(...samples.map((s) => s.object!.p[1]))).toBeGreaterThan(0.3);
    expect(take.tracks.oy.length).toBeGreaterThan(2); // the existing oy track carries it: same format, no new track
    for (const i of [0, 5, 10, 15, samples.length - 1]) {
      const s = samples[i];
      close(sampleWorldTake(take, (s.frame ?? 0) / 30).object!.p as Vec3, s.object!.p as Vec3, 3);
    }
    const flat = buildWorldTake(samples.map((s) => ({ ...s, object: { ...s.object!, p: [0, 0, -1.5] as Vec3 } })), { fps: 30 })!;
    close(sampleWorldTake(flat, 0.2).object!.p, [0, 0, -1.5], 3);
  });
});
