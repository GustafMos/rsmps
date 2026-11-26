import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { createGraph } from '../../engine/graph';
import { qAxisAngle } from '../../engine/lib/motion-math';
import type { AssetInfo } from '../../engine/types';
import { ArCameraFeed, WANT_MS } from './camera-feed';
import { WorldArController, type WorldArEnv } from './controller';
import { FakeFeedGpu, FakeXrSession, FakeXrSystem, fakeCameraCanvas, fakeTransform } from './fake-xr';
import { ArLoop, type ArPainter } from './loop';
import { featuresOf } from './xr-api';

class CamPainter implements ArPainter {
  cameraCalls: (number | undefined)[] = [];
  n = 0;
  begin() {}
  picture() {}
  ring() {}
  camera(_view: unknown, maxSide?: number) {
    this.cameraCalls.push(maxSide);
    return fakeCameraCanvas(640, 480, ++this.n);
  }
}

function rig(features?: string[]) {
  const session = new FakeXrSession({ features });
  session.viewer = { p: [0, 1.4, 0], q: qAxisAngle('x', -40) };
  session.camera = { width: 1280, height: 960 };
  const gpu = new FakeFeedGpu();
  let clock = 0;
  const feed = new ArCameraFeed(gpu as never, () => clock);
  const g = featuresOf(session);
  const painter = new CamPainter();
  feed.begin(g.cameraAccess);
  const loop = new ArLoop({
    session,
    referenceSpace: {},
    hitTestSource: null,
    layer: session.layer,
    features: g,
    painter,
    cameraFeed: feed,
    source: { request: () => false, latest: () => null, error: () => null },
    show: { kind: 'layer' },
    maxSide: 960,
    seconds: () => 0,
    now: () => clock,
    screen: () => ({ width: 360, height: 640 }),
    onState: () => undefined,
  });
  loop.start();
  const step = () => {
    clock += 33;
    session.step(33);
  };
  return { session, gpu, feed, painter, loop, step, advance: (ms: number) => (clock += ms) };
}

describe('the AR camera feed (fake session)', () => {
  it('copies nothing until the Picture output is asked for, then one copy per frame at the capped size', () => {
    const r = rig();
    r.step();
    r.step();
    expect(r.painter.cameraCalls).toEqual([]);
    expect(r.gpu.copies).toEqual([]);
    expect(r.feed.ask().frame).toBeNull(); // asked: wanted from now on, but no frame yet
    r.step();
    expect(r.gpu.copies.length).toBe(1);
    expect(r.painter.cameraCalls).toEqual([960]); // the cap the loop asks the painter for
    const a = r.feed.ask();
    expect(a).toMatchObject({ session: true, access: true });
    expect(a.frame).toMatchObject({ width: 640, height: 480 });
    expect(r.gpu.copies[0].source).toMatchObject({ frame: 1 });
    r.step();
    expect(r.gpu.copies.length).toBe(2);
    expect(r.gpu.textures.length).toBe(1); // one texture, reused
    expect(r.feed.ask().frame!.texture).toBe(r.gpu.textures[0] as never);
  });

  it('stops copying a while after the node stops asking', () => {
    const r = rig();
    r.feed.ask();
    r.step();
    expect(r.gpu.copies.length).toBe(1);
    r.advance(WANT_MS + 100);
    r.step();
    r.step();
    expect(r.gpu.copies.length).toBe(1);
  });

  it('without camera access: a session with no frame, nothing is copied, nothing is drawn', () => {
    const r = rig(['hit-test']);
    expect(r.feed.ask()).toEqual({ session: true, access: false, frame: null });
    r.step();
    r.step();
    expect(r.gpu.copies.length).toBe(0);
    expect(r.painter.cameraCalls).toEqual([]);
  });

  it('after the session ends the texture is given back and the feed says there is no session', () => {
    const r = rig();
    r.feed.ask();
    r.step();
    expect(r.gpu.live).toBe(1);
    r.feed.end();
    expect(r.gpu.live).toBe(0);
    expect(r.feed.ask()).toEqual({ session: false, access: false, frame: null });
    expect(r.feed.push(fakeCameraCanvas(4, 4))).toBe(false);
    expect(r.gpu.live).toBe(0);
  });

  it('a new camera size gets a new texture and the old one goes back', () => {
    const r = rig();
    r.feed.push(fakeCameraCanvas(640, 480));
    r.feed.push(fakeCameraCanvas(480, 640));
    expect(r.gpu.textures.length).toBe(2);
    expect(r.gpu.live).toBe(1);
  });

  it('recording a clip draws the camera once per frame, at the clip size, and feeds the picture from the same draw', () => {
    const r = rig();
    r.feed.ask();
    r.loop.startRecording({ push: () => 0 });
    r.step();
    expect(r.painter.cameraCalls).toEqual([undefined]);
    expect(r.gpu.copies.length).toBe(1);
  });
});

describe('the controller keeps the feed in step with the session', () => {
  it('opens the feed with the granted camera access and gives the texture back when the view closes', async () => {
    const xr = new FakeXrSystem();
    let clock = 0;
    const painter = new CamPainter();
    const env: WorldArEnv = {
      xr,
      async makePainter(session) {
        return { painter: Object.assign(painter, { uploadPixels() {} }), layer: (session as FakeXrSession).layer, dispose: () => undefined };
      },
      makeTransform: fakeTransform,
      makeGpuCanvas: () => null,
      canvasCopyWorks: () => false,
      makeRecorder: () => null,
      now: () => clock,
    };
    const gpu = new FakeFeedGpu();
    const feed = new ArCameraFeed(gpu as never, () => clock);
    const c = new WorldArController(
      {
        gpu: { readRaw: async () => new Uint8ClampedArray(4) } as never,
        gate: { evaluateHeld: async () => ({ value: null, errors: new Map(), timings: new Map() }) as never, drop: () => undefined },
        registry: new Registry(),
        add: async () => [] as AssetInfo[],
        holdPlayer: () => () => undefined,
        cameraFeed: feed,
      },
      env,
    );
    const g = createGraph('p');
    const h = await c.open({ graph: () => g, node: 'n1', card: { mode: 'upright', width: 0.5 }, overlay: null, onState: () => undefined, onTake: () => undefined });
    xr.session!.camera = { width: 640, height: 480 };
    expect(feed.ask()).toMatchObject({ session: true, access: true });
    clock += 33;
    xr.session!.step(33);
    expect(gpu.live).toBe(1);
    await h.close();
    expect(gpu.live).toBe(0);
    expect(feed.ask().session).toBe(false);
  });

  it('a session without camera access says so', async () => {
    const xr = new FakeXrSystem({ features: ['hit-test'] });
    const feed = new ArCameraFeed(new FakeFeedGpu() as never);
    const env: WorldArEnv = {
      xr,
      async makePainter(session) {
        return { painter: Object.assign(new CamPainter(), { uploadPixels() {} }), layer: (session as FakeXrSession).layer, dispose: () => undefined };
      },
      makeGpuCanvas: () => null,
      canvasCopyWorks: () => false,
      makeRecorder: () => null,
      now: () => 0,
    };
    const c = new WorldArController({ gpu: {} as never, gate: { evaluateHeld: async () => ({}) as never, drop: () => undefined }, registry: new Registry(), add: async () => [], holdPlayer: () => () => undefined, cameraFeed: feed }, env);
    const h = await c.open({ graph: () => createGraph('p'), node: 'n1', card: { mode: 'upright', width: 0.5 }, overlay: null, onState: () => undefined, onTake: () => undefined });
    expect(feed.ask()).toEqual({ session: true, access: false, frame: null });
    await h.close();
  });
});
