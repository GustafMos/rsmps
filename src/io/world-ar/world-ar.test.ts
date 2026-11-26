import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { addNode, connect, createGraph } from '../../engine/graph';
import { qAxisAngle, rotate, type Vec3 } from '../../engine/lib/motion-math';
import { buildWorldArVideoGraph } from '../../engine/lib/ar-video-graph';
import { buildWorldTake, sampleWorldTake, type WorldMoment } from '../../engine/lib/world-take';
import { depthOf, placementQuat, project, rayPlane, viewRay, zoomLens, zoomProjection, type Corners, type XrPose } from '../../engine/lib/xr-math';
import { registerBuiltins } from '../../engine/nodes';
import type { AssetInfo, GraphDoc } from '../../engine/types';
import type { LiveRecorder } from '../live-record';
import { WorldArController, type WorldArEnv, type WorldArTake, type WorldArViewState } from './controller';
import { fedByWorldAr, stampWorldAr, worldArNodeIds, type PictureTarget } from './engine-source';
import { FakeXrSession, FakeXrSystem, fakeTransform } from './fake-xr';
import { ArLoop, MAX_FRAME_ERRORS, effectiveRecordRate, pictureSize, renderFailHint, type ArLoopState, type ArPainter, type ArPicture, type ArPictureSource } from './loop';
import { GestureReader, MAX_SCALE, MIN_SCALE, TAP_MS, hintFor, initialPlaceState, placeStep, type Gesture, type PlaceState } from './placement';
import { checkWorldAr, startErrorMessage, unsupportedMessage } from './support';
import { OPTIONAL_FEATURES, featuresOf } from './xr-api';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], digits);
};
const FLOOR: XrPose = { p: [0, 0, -1.5], q: [0, 0, 0, 1] };
const EYE: XrPose = { p: [0, 1.4, 0], q: qAxisAngle('x', -40) };

/* ------------------------------------------------------------------ support and messages */

describe('is World AR possible here, and what to say', () => {
  const env = (o: Partial<Parameters<typeof checkWorldAr>[0]> = {}) => ({ secure: true, xr: new FakeXrSystem(), userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S931B) Chrome/142 Mobile', hasLayer: true, ...o });
  it('an Android phone with AR: ok, and only the one harmless question was asked', async () => {
    const xr = new FakeXrSystem();
    const s = await checkWorldAr(env({ xr }));
    expect(s.state).toBe('ok');
    expect(xr.asked).toBe(1);
    expect(xr.lastInit).toBeNull(); // no session was requested: nothing was shown to the user
  });
  it('an insecure page, a browser without WebXR, a device without AR, a blocked question', async () => {
    expect((await checkWorldAr(env({ secure: false }))).state).toBe('insecure');
    const desktop = await checkWorldAr(env({ xr: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142' }));
    expect(desktop.state).toBe('no-webxr');
    expect(desktop.message).toMatch(/Computers have no AR camera/);
    const xr = new FakeXrSystem();
    xr.supported = false;
    const none = await checkWorldAr(env({ xr }));
    expect(none.state).toBe('unsupported');
    expect(none.message).toMatch(/Google Play Services for AR/);
    xr.throwOnAsk = true;
    expect((await checkWorldAr(env({ xr }))).state).toBe('unsupported');
    expect((await checkWorldAr(env({ hasLayer: false }))).state).toBe('no-gl');
  });
  it('iPhone and iPad get their own sentence (desktop-mode iPad included)', () => {
    expect(unsupportedMessage('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari')).toMatch(/iPhone and iPad/);
    expect(unsupportedMessage('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Mobile/15E148 Safari')).toMatch(/iPhone and iPad/);
    expect(unsupportedMessage('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142 Safari')).toMatch(/Computers/);
  });
  it('a failed start: the one error Chrome gives for a refused camera, missing AR services and an unable device names all three', () => {
    const m = startErrorMessage({ name: 'NotSupportedError', message: 'The specified session configuration is not supported.' });
    expect(m).toMatch(/camera permission/);
    expect(m).toMatch(/Google Play Services for AR/);
    expect(startErrorMessage({ name: 'SecurityError', message: 'The requested session requires user activation.' })).toMatch(/pressing the button/);
    expect(startErrorMessage({ name: 'InvalidStateError' })).toMatch(/already open/);
    expect(startErrorMessage(new Error('boom'))).toMatch(/boom/);
  });
  it('granted features: the browser\'s own list where it has one, else by what is there', () => {
    const all = new FakeXrSession();
    expect(featuresOf(all)).toEqual({ hitTest: true, anchors: true, domOverlay: true, cameraAccess: true });
    const bare = new FakeXrSession({ features: [] });
    expect(featuresOf(bare)).toEqual({ hitTest: false, anchors: false, domOverlay: false, cameraAccess: false });
    const old = new FakeXrSession({ features: ['hit-test'], reportFeatures: false });
    expect(featuresOf(old).hitTest).toBe(true);
    expect(featuresOf(old).domOverlay).toBe(false); // no overlay state: no overlay
    expect(featuresOf(all, ['hit-test']).cameraAccess).toBe(false); // never claimed when it was not asked for
  });
});

/* ------------------------------------------------------------------ placement */

describe('placing: searching -> aiming -> placed', () => {
  const run = (events: Parameters<typeof placeStep>[1][], from = initialPlaceState()): PlaceState => events.reduce(placeStep, from);
  it('finds a surface, places on it facing the viewer, and resets', () => {
    let s = initialPlaceState();
    expect(s.phase).toBe('searching');
    s = placeStep(s, { type: 'place', viewer: [0, 1, 0] });
    expect(s.phase).toBe('searching'); // nothing to place on
    s = placeStep(s, { type: 'frame', hit: FLOOR, tracking: true });
    expect(s.phase).toBe('aiming');
    s = placeStep(s, { type: 'place', viewer: [1, 1.4, -1.5] });
    expect(s.phase).toBe('placed');
    close(s.placement!.p, FLOOR.p);
    close(rotate(placementQuat(s.placement!), [0, 0, 1]), [1, 0, 0]); // its front faces the viewer, who stands on +x of it
    s = placeStep(s, { type: 'frame', hit: null, tracking: true });
    expect(s.phase).toBe('placed'); // no surface in view does not un-place it
    s = placeStep(s, { type: 'reset' });
    expect(s.phase).toBe('aiming'); // the last surface is still the ring
    expect(s.placement).toBeNull();
  });
  it('move, twist and pinch change the placement; pinch is limited; nothing happens before placing', () => {
    const placed = run([{ type: 'frame', hit: FLOOR, tracking: true }, { type: 'place', viewer: [0, 1.4, 0] }]);
    const s = run([{ type: 'move', to: [1, 0, -2] }, { type: 'twist', deg: 350 }, { type: 'twist', deg: 20 }, { type: 'pinch', factor: 3 }], placed);
    close(s.placement!.p, [1, 0, -2]);
    expect(s.placement!.yaw).toBeCloseTo(placed.placement!.yaw + 10, 6);
    expect(s.placement!.scale).toBe(3);
    expect(run([{ type: 'pinch', factor: 1e9 }], s).placement!.scale).toBe(MAX_SCALE);
    expect(run([{ type: 'pinch', factor: 1e-9 }], s).placement!.scale).toBe(MIN_SCALE);
    expect(run([{ type: 'pinch', factor: -1 }], s).placement!.scale).toBe(3);
    expect(run([{ type: 'move', to: [1, 1, 1] }, { type: 'twist', deg: 5 }]).placement).toBeNull();
  });
  it('the ring survives a frame without a hit but not lost tracking; placing again keeps the pinched size', () => {
    let s = run([{ type: 'frame', hit: FLOOR, tracking: true }, { type: 'frame', hit: null, tracking: true }]);
    expect(s.phase).toBe('aiming');
    s = placeStep(s, { type: 'frame', hit: null, tracking: false });
    expect(s.phase).toBe('searching');
    expect(s.reticle).toBeNull();
    const placed = run([{ type: 'frame', hit: FLOOR, tracking: true }, { type: 'place', viewer: [0, 1, 0] }, { type: 'pinch', factor: 2 }, { type: 'frame', hit: { p: [2, 0, 0], q: [0, 0, 0, 1] }, tracking: true }, { type: 'place', viewer: [0, 1, 0] }]);
    close(placed.placement!.p, [2, 0, 0]);
    expect(placed.placement!.scale).toBe(2);
  });
  it('hints follow the state', () => {
    const s0 = initialPlaceState();
    expect(hintFor(s0, { gestures: true, recording: false })).toMatch(/Move the phone slowly to find a surface/);
    const aiming = placeStep(s0, { type: 'frame', hit: FLOOR, tracking: true });
    expect(hintFor(aiming, { gestures: true, recording: false })).toMatch(/Place/);
    expect(hintFor(aiming, { gestures: false, recording: false })).not.toMatch(/press Place/);
    const placed = placeStep(aiming, { type: 'place', viewer: [0, 1, 0] });
    expect(hintFor(placed, { gestures: true, recording: false })).toMatch(/Drag to move/);
    expect(hintFor(placed, { gestures: true, recording: true })).toMatch(/Recording/);
    expect(hintFor({ ...placed, tracking: false }, { gestures: true, recording: false })).toMatch(/Lost track of the room/);
    expect(hintFor(placed, { gestures: true, recording: false, paused: true })).toMatch(/paused/);
  });
});

describe('fingers', () => {
  const types = (g: Gesture[]) => g.map((x) => x.type);
  it('a short still touch is a tap; a long or travelling one is not', () => {
    const r = new GestureReader();
    r.down(1, 100, 100, 0);
    r.move(1, 103, 101);
    expect(r.up(1, 200)).toEqual([{ type: 'tap', x: 103, y: 101 }]);
    r.down(1, 100, 100, 1000);
    expect(r.up(1, 1000 + TAP_MS + 1)).toEqual([]);
  });
  it('one finger travelling is a drag from where it went down', () => {
    const r = new GestureReader();
    r.down(1, 100, 100, 0);
    expect(r.move(1, 104, 100)).toEqual([]);
    expect(r.move(1, 130, 100)).toEqual([{ type: 'drag-start', x: 100, y: 100 }, { type: 'drag', x: 130, y: 100 }]);
    expect(r.move(1, 140, 110)).toEqual([{ type: 'drag', x: 140, y: 110 }]);
    expect(types(r.up(1, 50))).toEqual(['drag-end']);
  });
  it('two fingers: turning them clockwise turns the object clockwise from above; spreading them enlarges it', () => {
    const r = new GestureReader();
    r.down(1, 100, 200, 0);
    r.down(2, 200, 200, 0);
    // rotate the pair a quarter turn clockwise on a screen whose y runs down: the right finger goes down
    const g = r.move(2, 100, 300);
    const twist = g.find((x) => x.type === 'twist') as { deg: number };
    expect(twist.deg).toBeCloseTo(-90, 6); // clockwise from above = negative about the up axis
    const p = r.move(2, 100, 400).find((x) => x.type === 'pinch') as { factor: number };
    expect(p.factor).toBeCloseTo(2, 6);
    // lifting one finger does not tap, and the finger that stays does not start dragging the object away
    expect(r.up(2, 100)).toEqual([]);
    expect(r.move(1, 300, 300)).toEqual([]);
    expect(r.up(1, 120)).toEqual([]);
    // a fresh touch works again
    r.down(3, 10, 10, 500);
    expect(types(r.up(3, 520))).toEqual(['tap']);
  });
  it('a second finger ends a drag; a third is ignored; a cancelled touch places nothing', () => {
    const r = new GestureReader();
    r.down(1, 0, 0, 0);
    r.move(1, 50, 0);
    expect(types(r.down(2, 100, 0, 10))).toEqual(['drag-end']);
    expect(r.down(3, 5, 5, 11)).toEqual([]);
    expect(r.move(3, 50, 50)).toEqual([]);
    r.up(1, 20);
    r.up(2, 20);
    r.down(4, 0, 0, 100);
    expect(r.cancel(4)).toEqual([]);
    expect(r.up(4, 110)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the frame loop against the fake session */

class FakePainter implements ArPainter, PictureTarget {
  calls: { op: string; corners?: Corners; fb?: unknown }[] = [];
  cameraPicture: unknown | null = null;
  /** The zoom of every backdrop drawn, and whether the camera picture is there for it. */
  backdrops: number[] = [];
  backdropOk = true;
  uploads = 0;
  begin(fb: unknown) {
    this.calls = [{ op: 'begin', fb }];
  }
  picture(corners: Corners) {
    this.calls.push({ op: 'picture', corners });
  }
  ring(corners: Corners) {
    this.calls.push({ op: 'ring', corners });
  }
  camera() {
    return this.cameraPicture;
  }
  backdrop(_view: unknown, zoom: number) {
    if (this.backdropOk) this.backdrops.push(zoom);
    return this.backdropOk;
  }
  uploadPixels() {
    this.uploads++;
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
}

class FakeSource implements ArPictureSource {
  requests: { moment: WorldMoment; depth: number; size: { width: number; height: number }; seconds: number }[] = [];
  private pending: (typeof this.requests)[number] | null = null;
  private last: ArPicture | null = null;
  err: string | null = null;
  private seq = 0;
  request(req: (typeof this.requests)[number]): boolean {
    if (this.pending) return false;
    this.pending = req;
    this.requests.push(req);
    return true;
  }
  /** The engine finished the picture it was asked for. */
  finish(): void {
    if (!this.pending) return;
    this.last = { moment: this.pending.moment, depth: this.pending.depth, width: this.pending.size.width, height: this.pending.size.height, seq: ++this.seq };
    this.pending = null;
  }
  latest() {
    return this.last;
  }
  error() {
    return this.err;
  }
}

function setup(o: { features?: string[]; show?: 'layer' | 'card'; reportFeatures?: boolean } = {}) {
  const session = new FakeXrSession({ features: o.features, reportFeatures: o.reportFeatures });
  session.viewer = EYE;
  const painter = new FakePainter();
  const source = new FakeSource();
  const states: ArLoopState[] = [];
  let clock = 0;
  const features = featuresOf(session);
  const loop = new ArLoop({
    session,
    referenceSpace: { space: 'local' },
    hitTestSource: features.hitTest ? { source: 'viewer' } : null,
    layer: session.layer,
    features,
    painter,
    source,
    show: o.show === 'card' ? { kind: 'card', mode: 'upright', width: 0.5 } : { kind: 'layer' },
    maxSide: 960,
    seconds: () => clock / 1000,
    now: () => clock,
    makeTransform: fakeTransform,
    screen: () => ({ width: 360, height: 640 }),
    onState: (s) => states.push(s),
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock += 33;
      session.step(33);
    }
  };
  loop.start();
  return { session, painter, source, loop, states, step, flush: () => new Promise((r) => setTimeout(r, 0)), tick: (ms: number) => (clock += ms) };
}

describe('the AR frame loop (fake session)', () => {
  it('searching shows nothing, a surface shows the ring, a tap places, then the object\'s picture is drawn where it was rendered for', async () => {
    const t = setup();
    t.step();
    expect(t.painter.ops()).toEqual(['begin']);
    expect(t.painter.calls[0].fb).toBe(t.session.layer.framebuffer); // drawn into the session's framebuffer, cleared to transparent
    expect(t.loop.state().phase).toBe('searching');
    expect(t.source.requests.length).toBe(0); // nothing placed: nothing to render

    t.session.hit = FLOOR;
    t.step();
    expect(t.painter.ops()).toEqual(['begin', 'ring']);
    expect(t.loop.state().phase).toBe('aiming');

    t.loop.gesture({ type: 'tap', x: 180, y: 320 });
    t.step();
    expect(t.loop.state().phase).toBe('placed');
    expect(t.painter.ops()).toEqual(['begin']); // placed, the ring is gone, and no picture has arrived yet
    expect(t.source.requests.length).toBe(1);
    const req = t.source.requests[0];
    close(req.moment.view.p, EYE.p);
    close(req.moment.object!.p, FLOOR.p);
    expect(req.depth).toBeCloseTo(depthOf(EYE, FLOOR.p), 6);
    expect(req.size).toEqual(pictureSize(t.session.lens, 960));
    expect(req.size.height).toBe(960);

    // the phone moves on while the engine renders; the picture arrives and is hung in the room for the pose it was made for
    t.session.viewer = { p: [0.3, 1.45, 0.1], q: qAxisAngle('x', -35) };
    t.step();
    expect(t.source.requests.length).toBe(1); // still busy: no second request
    t.source.finish();
    t.step();
    expect(t.painter.ops()).toEqual(['begin', 'picture']);
    const corners = t.painter.calls[1].corners!;
    const want = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    corners.forEach((c, i) => close(project(EYE, t.session.lens, c)!, want[i], 4)); // it fills the OLD view exactly, not the new one
    expect(t.source.requests.length).toBe(2);
    close(t.source.requests[1].moment.view.p, [0.3, 1.45, 0.1]); // and the next picture is for the new pose
    await t.flush();
    expect(t.session.anchors.length).toBe(1);
    t.step();
    expect(t.loop.state().anchored).toBe(true);
  });

  it('the browser moving the anchor moves the object with it, also after the user dragged it', async () => {
    const t = setup();
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    await t.flush();
    t.step();
    const a = t.session.anchors[0];
    a.pose = { p: [0.1, 0.02, -1.5], q: [0, 0, 0, 1] }; // the device refined where that floor point is
    t.step();
    close(t.loop.placement!.p, [0.1, 0.02, -1.5]);

    // drag along the floor: the finger's ray on the object's own plane, moved by the same amount
    const lens = t.session.lens;
    const at = (x: number, y: number) => {
      const r = viewRay(EYE, lens, (x / 360) * 2 - 1, 1 - (y / 640) * 2);
      return rayPlane(r.origin, r.dir, [0.1, 0.02, -1.5], [0, 1, 0])!;
    };
    t.loop.gesture({ type: 'drag-start', x: 180, y: 320 });
    t.loop.gesture({ type: 'drag', x: 240, y: 300 });
    t.step();
    const h0 = at(180, 320);
    const h1 = at(240, 300);
    const moved: Vec3 = [0.1 + h1[0] - h0[0], 0.02 + h1[1] - h0[1], -1.5 + h1[2] - h0[2]];
    close(t.loop.placement!.p, moved);
    expect(moved[0]).toBeGreaterThan(0.15); // the finger went right: so did the object

    // the old anchor shifts again: the object keeps its offset from it
    a.pose = { p: [0.2, 0.02, -1.5], q: [0, 0, 0, 1] };
    t.step();
    close(t.loop.placement!.p, [moved[0] + 0.1, moved[1], moved[2]]);

    // letting go asks the browser for an anchor at the new place and drops the old one
    t.loop.gesture({ type: 'drag-end' });
    t.step();
    await t.flush();
    expect(t.session.anchors.length).toBe(2);
    expect(a.deleted).toBe(true);
    const before = t.loop.placement!.p;
    t.step();
    close(t.loop.placement!.p, before); // adopting the new anchor does not make the object jump
    t.session.anchors[1].tracked = false;
    t.session.anchors[1].pose = { p: [9, 9, 9], q: [0, 0, 0, 1] };
    t.step();
    close(t.loop.placement!.p, before); // an anchor the device is not tracking right now is not followed
  });

  it('twist and pinch reach the placement; Reset picks it up and deletes the anchor', async () => {
    const t = setup();
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    await t.flush();
    const yaw = t.loop.placement!.yaw;
    t.loop.gesture({ type: 'twist', deg: 30 });
    t.loop.gesture({ type: 'pinch', factor: 1.5 });
    t.step();
    expect(t.loop.placement!.yaw).toBeCloseTo(yaw + 30, 6);
    expect(t.loop.placement!.scale).toBeCloseTo(1.5, 6);
    expect(t.source.requests.at(-1)!.moment.object!.scale).toBeCloseTo(1, 6); // that request went out before the pinch
    t.source.finish();
    t.step();
    expect(t.source.requests.at(-1)!.moment.object!.scale).toBeCloseTo(1.5, 6);
    t.loop.reset();
    t.step();
    expect(t.loop.state().phase).toBe('aiming');
    expect(t.session.anchors[0].deleted).toBe(true);
    expect(t.painter.ops()).toEqual(['begin', 'ring']);
  });

  it('without anchors the object keeps a fixed pose; an anchor that cannot be made is the same, silently', async () => {
    const t = setup({ features: ['hit-test', 'dom-overlay'] });
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step(3);
    await t.flush();
    expect(t.session.anchors.length).toBe(0);
    expect(t.loop.state().anchored).toBe(false);
    close(t.loop.placement!.p, FLOOR.p);

    const f = setup();
    f.session.failAnchors = true;
    f.session.hit = FLOOR;
    f.step();
    f.loop.placeHere();
    f.step();
    await f.flush();
    f.step();
    expect(f.loop.state().anchored).toBe(false);
    expect(f.loop.state().phase).toBe('placed');
    expect(f.loop.state().error).toBeNull();
  });

  it('without the DOM overlay the session\'s own tap places, and a second tap moves it to the ring; with the overlay that tap is left to the page', () => {
    const t = setup({ features: ['hit-test', 'anchors'] });
    t.session.hit = FLOOR;
    t.step();
    t.session.emit('select');
    t.step();
    expect(t.loop.state().phase).toBe('placed');
    expect(t.loop.state().hint).toMatch(/Tap to put it somewhere else/);
    t.session.hit = { p: [1, 0, -1], q: [0, 0, 0, 1] };
    t.step();
    t.session.emit('select');
    t.step();
    close(t.loop.placement!.p, [1, 0, -1]);

    const o = setup();
    o.session.hit = FLOOR;
    o.step();
    o.session.emit('select');
    o.step();
    expect(o.loop.state().phase).toBe('aiming');
  });

  it('no surfaces at all (hit test not granted): the view runs, nothing can be placed', () => {
    const t = setup({ features: ['dom-overlay'] });
    t.session.hit = FLOOR; // even if the device knew, the page is not told
    t.step(3);
    t.loop.placeHere();
    t.step();
    expect(t.loop.state().phase).toBe('searching');
    expect(t.painter.ops()).toEqual(['begin']);
  });

  it('tracking lost: nothing is drawn, the placement is kept, the hint says so, and it comes back', () => {
    const t = setup();
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    t.source.finish();
    t.step();
    expect(t.painter.ops()).toContain('picture');
    t.painter.calls = [];
    t.session.viewer = null;
    t.loop.placeHere(); // a tap during the blackout must not place something later
    t.step();
    expect(t.painter.calls).toEqual([]); // not even a clear: the frame has no view to draw into
    expect(t.loop.state().tracking).toBe(false);
    expect(t.loop.state().hint).toMatch(/Lost track of the room/);
    expect(t.loop.state().phase).toBe('placed');
    t.session.viewer = EYE;
    t.step();
    expect(t.loop.state().tracking).toBe(true);
    expect(t.painter.ops()).toContain('picture');
    close(t.loop.placement!.p, FLOOR.p);
    // a position that is only guessed counts as lost too, but the picture stays
    t.session.emulatedPosition = true;
    t.step();
    expect(t.loop.state().tracking).toBe(false);
    expect(t.painter.ops()).toContain('picture');
  });

  it('a frame that throws is survived; a view that only throws closes itself with the reason', () => {
    const t = setup();
    t.session.hit = FLOOR;
    t.session.throwInFrame = new Error('pose taken back');
    t.step(3);
    t.session.throwInFrame = null;
    t.step();
    expect(t.loop.state().ended).toBe(false);
    expect(t.loop.state().phase).toBe('aiming');
    t.session.throwInFrame = new Error('broken for good');
    t.step(MAX_FRAME_ERRORS + 2);
    const s = t.loop.state();
    expect(s.ended).toBe(true);
    expect(s.error).toMatch(/broken for good/);
    expect(t.session.listenerCount('end')).toBe(0);
    expect(t.session.step()).toBe(0); // no frame callback left behind
  });

  it('the session ending (Back button) stops the loop and removes its listeners; hidden pauses rendering and recording', () => {
    const t = setup();
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    t.source.finish();
    t.session.visibilityState = 'hidden';
    t.session.emit('visibilitychange');
    const before = t.source.requests.length;
    t.loop.startRecording(null);
    t.step(3);
    expect(t.source.requests.length).toBe(before);
    expect(t.loop.state().hint).toMatch(/paused/);
    expect(t.loop.stopRecording()!.samples.length).toBe(0);
    t.session.visibilityState = 'visible';
    t.session.emit('visibilitychange');
    t.step();
    expect(t.source.requests.length).toBe(before + 1);
    t.session.systemEnd();
    expect(t.loop.state().ended).toBe(true);
    expect(t.session.listenerCount('select') + t.session.listenerCount('visibilitychange') + t.session.listenerCount('end')).toBe(0);
    expect(t.states.at(-1)!.ended).toBe(true);
    t.loop.stop(); // twice is fine
  });

  it('a flat picture is a card on the surface, rendered whatever the pose, and a graph error is shown as the hint', () => {
    const t = setup({ show: 'card' });
    t.step();
    expect(t.source.requests.length).toBe(1); // a card does not wait for a placement to be rendered
    t.source.finish();
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    expect(t.painter.ops()).toEqual(['begin', 'picture']);
    const [bl, br, tl] = t.painter.calls[1].corners!;
    expect(bl[1]).toBeCloseTo(0, 6); // stands on the floor
    expect(Math.hypot(br[0] - bl[0], br[2] - bl[2])).toBeCloseTo(0.5, 6); // as wide as asked
    expect(tl[1] - bl[1]).toBeCloseTo(0.5 / (540 / 960), 3); // as tall as the picture's shape says
    t.source.err = 'Media In: no media';
    expect(t.loop.state().hint).toMatch(/could not be rendered: Media In: no media/);
  });

  it('recording motion only: one sample per frame, timed from the first, and the take plays it back', () => {
    const t = setup({ features: ['hit-test', 'dom-overlay'] });
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    t.loop.startRecording(null);
    expect(t.loop.isRecording).toBe(true);
    for (let i = 0; i < 30; i++) {
      t.session.viewer = { p: [i * 0.01, 1.4, 0], q: EYE.q };
      t.step();
    }
    expect(t.loop.state().recording).toBe(true);
    expect(t.loop.state().recSeconds).toBeCloseTo((29 * 33) / 1000, 3);
    const rec = t.loop.stopRecording()!;
    expect(rec.withClip).toBe(false);
    expect(rec.samples.length).toBe(30);
    expect(rec.samples[0].t).toBe(0);
    const take = buildWorldTake(rec.samples, { fps: 30 })!;
    expect(take.clip).toBe(false);
    const half = sampleWorldTake(take, 0.5);
    expect(half.view.p[0]).toBeCloseTo((0.5 / 0.033) * 0.01, 2);
    close(half.object!.p, FLOOR.p, 3);
    expect(t.loop.stopRecording()).toBeNull();
  });

  it('recording with the camera picture: only frames the clip took are kept, each with its clip frame', () => {
    const t = setup();
    t.session.camera = { width: 1080, height: 1920 };
    t.painter.cameraPicture = { canvas: true };
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    // the clip recorder: not ready for two pictures, then takes every other one
    let calls = 0;
    let n = 0;
    const pushed: unknown[] = [];
    t.loop.startRecording({
      push: (p) => {
        pushed.push(p);
        calls++;
        return calls <= 2 || calls % 2 ? -1 : n++;
      },
    });
    for (let i = 0; i < 10; i++) {
      t.session.viewer = { p: [i, 1.4, 0], q: EYE.q };
      t.step();
    }
    const rec = t.loop.stopRecording()!;
    expect(rec.withClip).toBe(true);
    expect(pushed[0]).toBe(t.painter.cameraPicture);
    expect(rec.samples.map((s) => s.frame)).toEqual([0, 1, 2, 3]);
    expect(rec.samples.map((s) => s.view.p[0])).toEqual([3, 5, 7, 9]); // the pose of exactly the pictures that were taken
    const take = buildWorldTake(rec.samples, { fps: 30 })!;
    expect(take.clip).toBe(true);
    expect(sampleWorldTake(take, 2 / 30).view.p[0]).toBeCloseTo(7, 3);
  });

  it('camera access granted but no picture arrives: the take is motion only', () => {
    const t = setup();
    t.painter.cameraPicture = null;
    t.session.hit = FLOOR;
    t.step();
    t.loop.startRecording({ push: () => 0 });
    t.step(5);
    const rec = t.loop.stopRecording()!;
    expect(rec.withClip).toBe(false);
    expect(rec.samples.length).toBe(5);
    expect(rec.samples[0].object).toBeNull(); // recording before placing is allowed: the object is simply absent
  });

  it('pictureSize keeps the lens\'s shape with even sides', () => {
    expect(pictureSize([1.9, 1.07, 0, 0], 960)).toEqual({ width: 540, height: 960 });
    expect(pictureSize([1.07, 1.9, 0, 0], 960)).toEqual({ width: 960, height: 540 });
    expect(pictureSize([1, 1.333, 0, 0], 501)).toEqual({ width: 502, height: 376 });
  });
});

/* ------------------------------------------------------------------ graph stamping */

describe('the pose reaches the graph', () => {
  const registry = new Registry();
  registerBuiltins(registry);
  const build = (): { graph: GraphDoc; cam: string; obj: string; other: string } => {
    let g = createGraph('t');
    const cam = addNode(g, registry, 'world-ar', { x: 0, y: 0 });
    const obj = addNode(cam.graph, registry, 'object-3d', { x: 0, y: 0 });
    const other = addNode(obj.graph, registry, 'object-3d', { x: 0, y: 0 });
    g = connect(other.graph, registry, { node: cam.node.id, port: 'camera' }, { node: obj.node.id, port: 'camera' });
    return { graph: g, cam: cam.node.id, obj: obj.node.id, other: other.node.id };
  };
  it('finds the World AR Camera nodes and tells an object seen through one from a flat picture', () => {
    const b = build();
    expect(worldArNodeIds(b.graph)).toEqual([b.cam]);
    expect(fedByWorldAr(b.graph, b.obj)).toBe(true);
    expect(fedByWorldAr(b.graph, b.other)).toBe(false);
    expect(fedByWorldAr(createGraph('empty'), 'x')).toBe(false);
  });
  it('stamps the moment into a copy; the project\'s own graph and every other node are untouched', () => {
    const b = build();
    const m: WorldMoment = { view: EYE, lens: [1.9, 1.07, 0, 0], object: null };
    const g = stampWorldAr(b.graph, worldArNodeIds(b.graph), m);
    expect(g.nodes.find((n) => n.id === b.cam)!.params.live).toBe(m);
    expect(b.graph.nodes.find((n) => n.id === b.cam)!.params.live ?? null).toBeNull();
    expect(g.nodes.find((n) => n.id === b.obj)).toBe(b.graph.nodes.find((n) => n.id === b.obj));
    expect(stampWorldAr(b.graph, [], m)).toBe(b.graph);
  });
});

/* ------------------------------------------------------------------ the controller against the fake browser */

function fakeEnv(xr: FakeXrSystem, o: { recorder?: boolean } = {}) {
  const painters: FakePainter[] = [];
  let clock = 0;
  const pushes: unknown[] = [];
  const recorder = {
    state: 'idle',
    onAutoStop: null as null | (() => void),
    startOpts: null as null | { fps: number },
    start(_a?: unknown, opts?: { fps: number }) {
      this.state = 'recording';
      this.startOpts = opts ?? null;
    },
    push(p: unknown) {
      pushes.push(p);
      return pushes.length - 1;
    },
    delay: 0,
    async stop() {
      if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
      this.state = 'idle';
      return { blob: new Blob(['x'], { type: 'video/mp4' }), name: 'AR take.mp4', frames: pushes.length, seconds: 1, width: 2, height: 2, hasAudio: false };
    },
    async cancel() {
      this.state = 'idle';
    },
  };
  const env: WorldArEnv = {
    xr,
    async makePainter(session) {
      const p = new FakePainter();
      painters.push(p);
      return { painter: p, layer: (session as FakeXrSession).layer, dispose: () => undefined };
    },
    makeTransform: fakeTransform,
    makeGpuCanvas: () => null,
    canvasCopyWorks: () => false,
    makeRecorder: () => (o.recorder === false ? null : (recorder as unknown as LiveRecorder)),
    now: () => clock,
  };
  return { env, painters, pushes, recorder, advance: (ms: number) => (clock += ms) };
}

function controller(xr: FakeXrSystem, o: { recorder?: boolean } = {}) {
  const f = fakeEnv(xr, o);
  const evals: unknown[] = [];
  let holds = 0;
  const camCalls: boolean[] = [];
  const added: File[] = [];
  const c = new WorldArController(
    {
      gpu: { readRaw: async () => new Uint8ClampedArray(4) } as never,
      gate: {
        evaluateHeld: async (req) => {
          evals.push(req);
          return { value: { kind: 'image', texture: {}, width: 2, height: 2, unit: 1 } as never, errors: new Map(), timings: new Map() };
        },
        drop: () => undefined,
      },
      registry: new Registry(),
      add: async (files) => {
        added.push(...files);
        return files.map((file, i) => ({ id: `asset${i}`, name: file.name }) as unknown as AssetInfo);
      },
      holdPlayer: () => {
        holds++;
        return () => holds--;
      },
      suspendCameras: (on) => void camCalls.push(on),
    },
    f.env,
  );
  const states: WorldArViewState[] = [];
  const takes: WorldArTake[] = [];
  const graph = createGraph('p');
  const openWith = (extra: { recordRate?: number | null; fps?: number } = {}) =>
    c.open({
      graph: () => (extra.fps ? { ...graph, project: { ...graph.project, fps: extra.fps } } : graph),
      node: 'n1',
      card: { mode: 'upright', width: 0.5 },
      recordRate: extra.recordRate,
      overlay: { clientWidth: 360, clientHeight: 640 } as HTMLElement,
      onState: (s) => states.push(s),
      onTake: (t) => takes.push(t),
    });
  const open = () => openWith();
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      f.advance(33);
      xr.session!.step(33);
    }
  };
  return { c, f, evals, added, states, takes, open, openWith, frames, camCalls, holds: () => holds, flush: () => new Promise((r) => setTimeout(r, 0)) };
}

describe('opening the AR view (fake browser)', () => {
  it('asks for every extra as optional, never as required, and passes the overlay', async () => {
    const xr = new FakeXrSystem();
    const t = controller(xr);
    const h = await t.open();
    expect(xr.lastInit!.requiredFeatures).toBeUndefined();
    expect(xr.lastInit!.optionalFeatures).toEqual([...OPTIONAL_FEATURES]);
    expect(xr.lastInit!.domOverlay).toBeTruthy();
    expect(xr.session!.baseLayer === null).toBe(true); // the fake painter does not set one; the real one does
    expect(t.holds()).toBe(1); // the normal viewer stands still meanwhile
    expect(t.c.active).toBe(h);
    await expect(t.open()).rejects.toThrow(/already open/);
    expect(h.state().features.domOverlay).toBe(true);
    expect(h.state().showing).toBe('card'); // nothing in this graph looks through a World AR Camera
    expect(h.state().route).toBe('pixels'); // no WebGPU canvas here: read back and upload
    await h.close();
    expect(xr.session!.ended).toBe(true);
    expect(t.holds()).toBe(0);
    expect(t.c.active).toBeNull();
    expect((await h.closed).error).toBeNull();
  });

  it('a device with none of the extras still opens', async () => {
    const xr = new FakeXrSystem({ features: [] });
    const t = controller(xr);
    const h = await t.open();
    expect(h.state().features).toEqual({ hitTest: false, anchors: false, domOverlay: false, cameraAccess: false });
    t.frames(2);
    expect(t.states.at(-1)!.hint).toMatch(/does not tell the page where surfaces are/);
    await h.close();
  });

  it('a refused start gives the sentence, holds nothing and leaves nothing open', async () => {
    const xr = new FakeXrSystem();
    xr.failWith = { name: 'NotSupportedError', message: 'The specified session configuration is not supported.' };
    const t = controller(xr);
    await expect(t.open()).rejects.toThrow(/camera permission was refused/);
    expect(t.holds()).toBe(0);
    expect(t.c.active).toBeNull();
    const none = new WorldArController({} as never, { ...fakeEnv(xr).env, xr: null });
    await expect(none.open({} as never)).rejects.toThrow(/did not start/);
  });

  it('the camera is let go before the session is asked for and comes back on every way out', async () => {
    // normal Exit
    let xr = new FakeXrSystem();
    let t = controller(xr);
    let h = await t.open();
    expect(t.camCalls).toEqual([true]);
    await h.close();
    expect(t.camCalls).toEqual([true, false]);
    // the system ends the session
    xr = new FakeXrSystem();
    t = controller(xr);
    h = await t.open();
    xr.session!.systemEnd();
    await h.closed;
    expect(t.camCalls).toEqual([true, false]);
    // a refused start
    xr = new FakeXrSystem();
    xr.failWith = { name: 'NotSupportedError' };
    t = controller(xr);
    await expect(t.open()).rejects.toThrow();
    expect(t.camCalls).toEqual([true, false]);
  });

  it('a failing hint says what to do', () => {
    expect(renderFailHint('Waiting for the camera…')).toMatch(/Waiting for the camera\. .*View the 3D Object itself, or remove the node that needs the camera/);
    expect(renderFailHint('Media In: no media')).toMatch(/remove the node that fails/);
  });

  it('the picture is rendered through the engine and uploaded; the system ending the session closes the view and saves the recording', async () => {
    const xr = new FakeXrSystem();
    const t = controller(xr);
    const h = await t.open();
    xr.session!.hit = FLOOR;
    xr.session!.camera = { width: 1080, height: 1920 };
    t.f.painters[0].cameraPicture = { canvas: true };
    t.frames(2);
    await t.flush();
    expect(t.evals.length).toBeGreaterThan(0);
    expect(t.f.painters[0].uploads).toBeGreaterThan(0);
    h.place();
    t.frames(1);
    h.toggleRecord();
    t.frames(6);
    expect(t.states.at(-1)!.recording).toBe(true);
    xr.session!.systemEnd(); // the Back button
    const end = await h.closed;
    expect(end.error).toBeNull();
    expect(t.takes.length).toBe(1);
    expect(t.takes[0].take!.clip).toBe(true);
    expect(t.takes[0].take!.frames).toBe(6);
    expect(t.takes[0].clip).toBeTruthy();
    expect(t.added[0].name).toBe('AR take.mp4'); // (the fake recorder's name)
    expect(t.holds()).toBe(0);
    expect(t.c.active).toBeNull();
  });

  it('Stop and then straight away Back: the view only reports closed once the take and its clip are stored', async () => {
    const xr = new FakeXrSystem();
    const t = controller(xr);
    const h = await t.open();
    xr.session!.hit = FLOOR;
    xr.session!.camera = { width: 1080, height: 1920 };
    t.f.painters[0].cameraPicture = { canvas: true };
    t.frames(2);
    h.place();
    t.frames(1);
    h.toggleRecord();
    t.frames(6);
    t.f.recorder.delay = 20; // encoding the clip takes a while
    h.toggleRecord(); // Stop: the clip is being saved
    xr.session!.systemEnd(); // and the Back button right away
    let takesWhenClosed = -1;
    await h.closed.then(() => (takesWhenClosed = t.takes.length));
    expect(takesWhenClosed).toBe(1);
    expect(t.takes[0].clip).toBeTruthy();
    expect(t.added.length).toBe(1);
  });

  it('Record then Stop without camera access: a motion-only take, no clip, the view stays open', async () => {
    const xr = new FakeXrSystem({ features: ['hit-test', 'anchors', 'dom-overlay'] });
    const t = controller(xr);
    const h = await t.open();
    xr.session!.hit = FLOOR;
    t.frames(1);
    h.place();
    t.frames(1);
    h.toggleRecord();
    t.frames(10);
    h.toggleRecord();
    await t.flush();
    expect(t.takes.length).toBe(1);
    expect(t.takes[0].take!.clip).toBe(false);
    expect(t.takes[0].clip).toBeNull();
    expect(t.takes[0].error).toBeNull();
    expect(t.f.pushes.length).toBe(0);
    expect(t.c.active).toBe(h);
    h.toggleRecord();
    h.toggleRecord(); // nothing recorded in between
    await t.flush();
    expect(t.takes[1].take).toBeNull();
    expect(t.takes[1].error).toMatch(/too short/);
    await h.close();
  });
});

/* ------------------------------------------------------------------ the AR video keeps the object on its spot */

/** Phones differ: a 30 per second AR camera with an uneven pace, and a 60 per second one; the clip is recorded at 30 or at 60. */
const SYNC_CASES = [
  { name: '30 per second clip, 30 per second phone', fps: 30, ms: (i: number) => 25 + (i % 4) * 6, frames: 60 },
  { name: '60 per second clip, 60 per second phone', fps: 60, ms: (i: number) => 12 + (i % 4) * 3, frames: 120 },
  { name: '30 per second clip, 60 per second phone', fps: 30, ms: (i: number) => 12 + (i % 4) * 3, frames: 120 },
];
for (const rate of SYNC_CASES) describe(`the AR video: clip time to take time, ${rate.name}`, () => {
  const FPS = rate.fps;
  /**
   * Record through the real loop with a phone that walks along x at 1 m/s, frames arriving at an uneven pace, the clip recorder
   * ready late, dropping some pictures and taking its first picture as clip frame `lead` (as when the encoder started early).
   */
  function record(lead: number) {
    const t = setup();
    t.session.camera = { width: 1080, height: 1920 };
    t.painter.cameraPicture = { canvas: true };
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    let ct = 0; // the phone's own clock in ms
    let calls = 0;
    let t0 = -1;
    let last = -1;
    const captured = new Map<number, number>(); // clip frame -> the x of the phone when that picture was taken
    t.loop.startRecording({
      push: () => {
        calls++;
        if (calls <= 2 || calls % 7 === 0) return -1; // encoder not ready yet / a picture dropped
        if (t0 < 0) t0 = ct - (lead * 1000) / FPS;
        const n = Math.floor(((ct - t0) * FPS) / 1000);
        if (n <= last) return -1; // this clip frame has its picture already
        last = n;
        captured.set(n, ct / 1000);
        return n;
      },
    });
    for (let i = 0; i < rate.frames; i++) {
      ct += rate.ms(i); // a variable frame rate
      t.session.viewer = { p: [ct / 1000, 1.4, 0], q: EYE.q };
      t.step();
    }
    const rec = t.loop.stopRecording()!;
    return { rec, captured, last, t0: () => t0 };
  }

  const arProject = (): GraphDoc =>
    ({
      schema: 'rsmps/graph',
      version: 2,
      name: 'ar',
      project: { width: 1080, height: 1920, fps: 24, duration: 4, loop: false, lengthMode: 'relative', referenceSide: 1080 },
      nodes: [
        { id: 'ar', type: 'world-ar', x: 0, y: 0, params: {} },
        { id: 'obj', type: 'object-3d', x: 0, y: 0, params: {} },
      ],
      edges: [{ id: 'c', from: { node: 'ar', port: 'camera' }, to: { node: 'obj', port: 'camera' } }],
    }) as unknown as GraphDoc;

  for (const lead of [0, 2]) {
    it(`frame N of the video uses the pose of clip frame N (the clip's first picture is frame ${lead}): within a frame, dropped pictures hold the pose before`, () => {
      const { rec, captured, last, t0 } = record(lead);
      const take = buildWorldTake(rec.samples, { fps: FPS })!;
      expect(take.clip).toBe(true);
      expect(take.clipFirst ?? 0).toBe(lead);
      const built = buildWorldArVideoGraph(arProject(), { arId: 'ar', viewedId: 'obj', viewedPort: 'image', take, clipAsset: 'clip', width: 540, height: 960, output: {} })!;
      const ar = built.graph.nodes.find((n) => n.id === 'ar')!.params as { take: typeof take; startAt: number };
      const clip = built.graph.nodes.find((n) => n.id === 'ar-clip')!.params as { offset: number };
      expect(built.graph.project.fps).toBe(FPS); // the video runs at the clip's rate, not the project's 24
      const firstFrame = [...captured.keys()].sort((a, b) => a - b)[0];
      let checked = 0;
      for (let n = 0; n <= last; n++) {
        const seconds = n / FPS; // the project time the exporter renders frame n at
        expect(Math.floor((seconds + clip.offset) * FPS + 1e-6)).toBe(n); // the clip frame the Media In shows then
        const x = sampleWorldTake(ar.take, seconds - ar.startAt).view.p[0];
        // what the phone saw in that picture: the pose of the newest clip frame taken at or before n (a dropped picture is held)
        let from = n;
        while (!captured.has(from) && from > firstFrame) from--;
        expect(x).toBeCloseTo(captured.get(Math.max(from, firstFrame))!, 3);
        // and that is where the phone was when the frame was taken, to within a frame of walking (1 m/s, 1/30 s)
        if (captured.has(n)) {
          expect(Math.abs(x - (t0() + (n * 1000) / FPS) / 1000)).toBeLessThan(1 / FPS);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(10);
      // no clip frame is used twice, and the frames the take keeps run forward
      const frames = rec.samples.map((x) => x.frame!);
      expect(new Set(frames).size).toBe(frames.length);
      expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    });
  }
});


/* ------------------------------------------------------------------ digital zoom */

describe('zoom in the AR view (fake session)', () => {
  const zoomOf = (t: ReturnType<typeof setup>) => {
    t.step();
    return t.loop.state().zoom;
  };
  /** A placed object, with the camera picture available. */
  const placed = (features?: string[]) => {
    const t = setup({ features });
    t.session.camera = { width: 1080, height: 1920 };
    t.painter.cameraPicture = { canvas: true };
    t.session.hit = FLOOR;
    t.step();
    t.loop.placeHere();
    t.step();
    return t;
  };

  it('the zoom strip changes the zoom, it stays between 1x and 4x, a double tap (zoom-reset) goes back to 1x', () => {
    const t = setup();
    t.session.camera = { width: 1080, height: 1920 };
    t.step();
    expect(t.loop.state().zoomAvailable).toBe(true);
    expect(t.loop.state().zoom).toBe(1);
    t.loop.gesture({ type: 'zoom', dy: 60 });
    expect(zoomOf(t)).toBeCloseTo(Math.exp(60 * 0.006), 5);
    t.loop.gesture({ type: 'zoom', dy: 5000 });
    expect(zoomOf(t)).toBe(4);
    t.loop.gesture({ type: 'zoom', dy: -5000 });
    expect(zoomOf(t)).toBe(1); // never below 1x
    t.loop.gesture({ type: 'zoom', dy: 100 });
    t.step();
    t.loop.gesture({ type: 'zoom-reset' });
    expect(zoomOf(t)).toBe(1);
  });

  it('zoomed: the camera picture is drawn into the layer by the page; at 1x it is not (the system passthrough shows)', () => {
    const t = setup();
    t.session.camera = { width: 1080, height: 1920 };
    t.step(2);
    expect(t.painter.backdrops).toEqual([]);
    t.loop.gesture({ type: 'zoom', dy: 100 });
    t.step(2);
    expect(t.painter.backdrops.length).toBe(2);
    expect(t.painter.backdrops[0]).toBeCloseTo(Math.exp(0.6), 5);
  });

  it('without camera access zoom is not available: the control stays at 1x and nothing is drawn zoomed', () => {
    const t = setup({ features: ['hit-test', 'anchors', 'dom-overlay'] });
    t.loop.gesture({ type: 'zoom', dy: 200 });
    t.step(2);
    const s = t.loop.state();
    expect(s.zoomAvailable).toBe(false);
    expect(s.zoom).toBe(1);
    expect(t.painter.backdrops).toEqual([]);
  });

  it('a frame without a camera picture is not zoomed (the object and the picture must agree)', () => {
    const t = placed();
    t.loop.gesture({ type: 'zoom', dy: 100 });
    t.source.finish();
    t.painter.backdropOk = false;
    t.step();
    expect(t.source.requests[t.source.requests.length - 1].moment.zoom).toBeUndefined();
    t.source.finish();
    t.painter.backdropOk = true;
    t.step();
    expect(t.source.requests[t.source.requests.length - 1].moment.zoom).toBeCloseTo(Math.exp(0.6), 5);
  });

  it('the object is rendered through the zoomed lens, so it stays locked to the room', () => {
    const t = placed();
    t.loop.gesture({ type: 'zoom', dy: 115 });
    t.source.finish();
    t.step(2);
    const z = t.loop.state().zoom;
    const m = t.source.requests[t.source.requests.length - 1].moment;
    close(m.lens, zoomLens(t.session.lens, z));
    const spot = project(EYE, m.lens, FLOOR.p)!;
    const plain = project(EYE, t.session.lens, FLOOR.p)!;
    expect(spot[0]).toBeCloseTo(plain[0] * z, 5);
    expect(spot[1]).toBeCloseTo(plain[1] * z, 5);
    const pm = zoomProjection(Float32Array.from([1.9, 0, 0, 0, 0, 1.07, 0, 0, 0.1, 0.2, -1, -1, 0, 0, -0.1, 0]), 2);
    expect(pm[0]).toBeCloseTo(3.8, 5);
    expect(pm[5]).toBeCloseTo(2.14, 5);
    expect(pm[8]).toBeCloseTo(0.2, 5);
    expect(pm[9]).toBeCloseTo(0.4, 5);
    expect(pm[2]).toBe(0);
    expect(pm[11]).toBe(-1);
  });

  it('gestures land under the finger on the zoomed picture: a drag puts the object where the finger is', () => {
    const t = placed();
    t.loop.gesture({ type: 'zoom', dy: 115 });
    t.step(2);
    const z = t.loop.state().zoom;
    const zl = zoomLens(t.session.lens, z);
    const px = (ndc: [number, number]): [number, number] => [((ndc[0] + 1) / 2) * 360, ((1 - ndc[1]) / 2) * 640];
    const unpx = (x: number, y: number): [number, number] => [(x / 360) * 2 - 1, 1 - (y / 640) * 2];
    // the finger goes down where the zoomed picture shows the object and slides to another point of the zoomed picture
    const [sx, sy] = px(project(EYE, zl, t.loop.placement!.p)!);
    t.loop.gesture({ type: 'drag-start', x: sx, y: sy });
    const [tx, ty] = [sx + 25, sy - 30];
    t.loop.gesture({ type: 'drag', x: tx, y: ty });
    t.step();
    const [wx, wy] = unpx(tx, ty);
    const got = project(EYE, zl, t.loop.placement!.p)!;
    expect(got[0]).toBeCloseTo(wx, 2);
    expect(got[1]).toBeCloseTo(wy, 2);
  });

  it('the same finger travel moves the object 1/zoom as far in the room (it follows the finger on the zoomed picture)', () => {
    const drag = (zoomDy: number) => {
      const t = placed();
      if (zoomDy) t.loop.gesture({ type: 'zoom', dy: zoomDy });
      t.step(2);
      const x0 = t.loop.placement!.p[0];
      t.loop.gesture({ type: 'drag-start', x: 180, y: 320 });
      t.loop.gesture({ type: 'drag', x: 220, y: 320 });
      t.step();
      return { dx: t.loop.placement!.p[0] - x0, z: t.loop.state().zoom };
    };
    const a = drag(0);
    const b = drag(115);
    expect(a.dx).toBeGreaterThan(0.01);
    expect(b.dx * b.z).toBeCloseTo(a.dx, 2);
  });

  it('Height strip travel lifts the object 1/zoom as far in the room', () => {
    const lift = (zoomDy: number) => {
      const t = placed();
      if (zoomDy) t.loop.gesture({ type: 'zoom', dy: zoomDy });
      t.step(2);
      t.loop.gesture({ type: 'lift', dy: 50 });
      t.step();
      return { h: t.loop.placement!.h ?? 0, z: t.loop.state().zoom };
    };
    const a = lift(0);
    const b = lift(115);
    expect(a.h).toBeGreaterThan(0);
    expect(b.h * b.z).toBeCloseTo(a.h, 4);
  });

  it('a take records the zoom per frame; a take that never zoomed has no zoom track; the camera clip gets the un-zoomed picture', () => {
    const t = placed();
    let n = 0;
    const pushed: unknown[] = [];
    t.loop.startRecording({ push: (p) => (pushed.push(p), n++) });
    for (let i = 0; i < 30; i++) {
      if (i === 10) t.loop.gesture({ type: 'zoom', dy: 100 });
      if (i === 22) t.loop.gesture({ type: 'zoom-reset' });
      t.step();
    }
    const rec = t.loop.stopRecording()!;
    expect(pushed.every((p) => p === t.painter.cameraPicture)).toBe(true);
    const take = buildWorldTake(rec.samples, { fps: 30 })!;
    expect(take.tracks.zm).toBeTruthy();
    // the un-zoomed lens is what is stored, the zoom beside it
    expect(sampleWorldTake(take, 2 / 30).zoom).toBeUndefined();
    expect(sampleWorldTake(take, 2 / 30).lens[0]).toBeCloseTo(t.session.lens[0], 4);
    const mid = sampleWorldTake(take, 16 / 30);
    expect(mid.zoom).toBeCloseTo(Math.exp(0.6), 2);
    expect(mid.lens[0]).toBeCloseTo(t.session.lens[0] * Math.exp(0.6), 2);
    expect(sampleWorldTake(take, 29 / 30).zoom).toBeUndefined();

    const t2 = placed();
    t2.loop.startRecording({ push: () => n++ });
    t2.step(10);
    const plain = buildWorldTake(t2.loop.stopRecording()!.samples, { fps: 30 })!;
    expect(plain.tracks.zm).toBeUndefined();
    expect(sampleWorldTake(plain, 0.1).zoom).toBeUndefined();
  });

  it('the saved video graph zooms the camera clip by the take, and adds nothing for a take that never zoomed', () => {
    const reg = new Registry();
    registerBuiltins(reg);
    const g0 = createGraph('z');
    const ar = addNode(g0, reg, 'world-ar', { x: 0, y: 0 });
    const obj = addNode(ar.graph, reg, 'object-3d', { x: 200, y: 0 });
    const g = connect(obj.graph, reg, { node: ar.node.id, port: 'camera' }, { node: obj.node.id, port: 'camera' });
    const mk = (zoom: boolean) => {
      const t = placed();
      let n = 0;
      t.loop.startRecording({ push: () => n++ });
      for (let i = 0; i < 20; i++) {
        if (zoom && i === 8) t.loop.gesture({ type: 'zoom', dy: 100 });
        t.step();
      }
      return buildWorldTake(t.loop.stopRecording()!.samples, { fps: 30 })!;
    };
    const opts = { arId: ar.node.id, viewedId: obj.node.id, viewedPort: 'image', clipAsset: 'clip', width: 540, height: 960, output: {} };
    const zoomed = buildWorldArVideoGraph(g, { ...opts, take: mk(true) })!;
    const zNode = zoomed.graph.nodes.find((n) => n.label === 'Camera zoom')!;
    expect(zNode.type).toBe('transform');
    expect(zoomed.graph.edges.some((e) => e.from.node === ar.node.id && e.from.port === 'zoom' && e.to.node === zNode.id && e.to.port === 'scale')).toBe(true);
    const merge = zoomed.graph.nodes.find((n) => n.label === 'Object over camera')!;
    expect(zoomed.graph.edges.find((e) => e.to.node === merge.id && e.to.port === 'background')!.from.node).toBe(zNode.id);
    const plain = buildWorldArVideoGraph(g, { ...opts, take: mk(false) })!;
    expect(plain.graph.nodes.some((n) => n.label === 'Camera zoom')).toBe(false);
  });
});

/* ------------------------------------------------------------------ recording rate */

describe('the recording rate', () => {
  it('Match project follows the project; an asked rate is lowered to what the AR camera delivers', () => {
    expect(effectiveRecordRate(null, 25, 30)).toEqual({ fps: 25, asked: 25, clamped: false });
    expect(effectiveRecordRate(30, 25, 30)).toEqual({ fps: 30, asked: 30, clamped: false });
    expect(effectiveRecordRate(30, 25, 29)).toEqual({ fps: 30, asked: 30, clamped: false }); // a 30 Hz session measures 29 to 31
    expect(effectiveRecordRate(60, 25, 30)).toEqual({ fps: 30, asked: 60, clamped: true });
    expect(effectiveRecordRate(60, 25, 60)).toEqual({ fps: 60, asked: 60, clamped: false });
    expect(effectiveRecordRate(30, 24, 60)).toEqual({ fps: 30, asked: 30, clamped: false });
    expect(effectiveRecordRate(60, 24, 0)).toEqual({ fps: 60, asked: 60, clamped: false }); // not measured yet: nothing is lowered
    expect(effectiveRecordRate(30, 24, 20)).toEqual({ fps: 20, asked: 30, clamped: true });
  });

  it('the loop measures the session and clamps a 60 request on a 30 per second session, not on a 60 one', () => {
    const run = (ms: number, asked: number) => {
      const t = setup();
      t.loop.setRecordRate(asked);
      for (let i = 0; i < 40; i++) {
        t.tick(ms);
        t.session.step(ms);
      }
      return t.loop.recordRateFor(25);
    };
    expect(run(33, 60)).toMatchObject({ fps: 30, asked: 60, clamped: true });
    expect(run(16, 60)).toMatchObject({ fps: 60, clamped: false });
    expect(run(33, 30)).toMatchObject({ fps: 30, clamped: false });
  });
});

describe('the recording rate through the controller', () => {
  async function recordAt(recordRate: number | null | undefined, ms: number, projectFps = 24) {
    const xr = new FakeXrSystem();
    xr.onSession = (s) => {
      s.camera = { width: 1080, height: 1920 };
      s.hit = FLOOR;
    };
    const t = controller(xr);
    const h = await t.openWith({ recordRate, fps: projectFps });
    const step = (n: number) => {
      for (let i = 0; i < n; i++) {
        t.f.advance(ms);
        xr.session!.step(ms);
      }
    };
    step(15);
    h.place();
    step(2);
    h.toggleRecord();
    step(30);
    h.toggleRecord();
    await t.flush();
    await t.flush();
    return { t, take: t.takes[0] };
  }

  it('Match project (the default) records at the project rate, as before', async () => {
    const { t, take } = await recordAt(undefined, 33, 24);
    expect(take.take!.fps).toBe(24);
    expect(take.rate).toEqual({ fps: 24, asked: 24, clamped: false });
    expect(t.f.recorder.startOpts!.fps).toBe(24);
  });

  it('30 gives a 30 per second take and a 30 per second video graph, also when the project is 24', async () => {
    const { t, take } = await recordAt(30, 33, 24);
    expect(take.take!.fps).toBe(30);
    expect(take.rate!.clamped).toBe(false);
    expect(t.f.recorder.startOpts!.fps).toBe(30);
    const reg = new Registry();
    registerBuiltins(reg);
    const g0 = createGraph('r');
    const ar = addNode(g0, reg, 'world-ar', { x: 0, y: 0 });
    const obj = addNode(ar.graph, reg, 'object-3d', { x: 200, y: 0 });
    const built = buildWorldArVideoGraph(connect(obj.graph, reg, { node: ar.node.id, port: 'camera' }, { node: obj.node.id, port: 'camera' }), {
      arId: ar.node.id, viewedId: obj.node.id, viewedPort: 'image', take: take.take!, clipAsset: 'clip', width: 540, height: 960, output: {},
    })!;
    expect(built.graph.project.fps).toBe(30);
  });

  it('60 asked on a 30 per second session records at 30 and says so', async () => {
    const { t, take } = await recordAt(60, 33, 24);
    expect(take.take!.fps).toBe(30);
    expect(take.rate).toEqual({ fps: 30, asked: 60, clamped: true });
    expect(t.f.recorder.startOpts!.fps).toBe(30);
    const state = t.states[t.states.length - 1];
    expect(state.askedFps).toBe(60);
    expect(state.recordFps).toBe(30);
  });

  it('60 asked on a 60 per second session records at 60', async () => {
    const { take } = await recordAt(60, 16, 24);
    expect(take.take!.fps).toBe(60);
    expect(take.rate!.clamped).toBe(false);
  });
});
