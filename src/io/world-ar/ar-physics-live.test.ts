/**
 * Live physics in the AR view, against the fake XR session (no GPU): the moment handed to the engine carries a clock that starts when
 * the object is placed, runs on in real time (no wrap at the project's loop), starts over when the object is raised or resized, on
 * "Restart physics" and on placing again, and a take keeps it so the saved video shows the same fall.
 */
import { describe, expect, it } from 'vitest';
import { qAxisAngle } from '../../engine/lib/motion-math';
import { buildWorldTake, sampleWorldTake, type WorldMoment, type WorldSample } from '../../engine/lib/world-take';
import type { XrPose } from '../../engine/lib/xr-math';
import { FakeXrSession, fakeTransform } from './fake-xr';
import { ArLoop, type ArPainter, type ArPicture, type ArPictureSource } from './loop';
import { featuresOf } from './xr-api';

const FLOOR: XrPose = { p: [0, 0, -1.5], q: [0, 0, 0, 1] };
const EYE: XrPose = { p: [0, 1.4, 0], q: qAxisAngle('x', -40) };

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

function setup(physics: boolean) {
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
    seconds: () => (clock / 1000) % 4, // the project clock: wraps at the 4 s project
    physics,
    predictPose: false, // these tests read back the exact pose and clock of each request; ar-swim.test.ts covers the prediction
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
  return { session, source, loop, step };
}
const last = (t: ReturnType<typeof setup>) => t.source.moments.at(-1)!;

describe('live physics clock', () => {
  it('starts at the tap, runs on past the project loop, and is absent without physics', () => {
    const t = setup(true);
    expect(t.source.moments.length).toBe(0); // nothing placed: nothing is drawn, nothing falls
    t.loop.placeHere();
    t.step();
    expect(last(t).physics).toBe(0);
    t.step(150); // 4.95 s: past the 4 s project length
    expect(last(t).physics).toBeCloseTo(4.95, 2);
    expect(t.loop.state().physics).toBe(true);
    const n = setup(false);
    n.loop.placeHere();
    n.step(5);
    expect(last(n).physics).toBeUndefined();
    expect(n.loop.state().physics).toBe(false);
  });

  it('starts over on Restart physics, when raised or resized, and when placed again', () => {
    const t = setup(true);
    t.loop.placeHere();
    t.step(30);
    expect(last(t).physics!).toBeGreaterThan(0.9);
    t.loop.restartPhysics();
    t.step();
    expect(last(t).physics).toBe(0);
    t.step(10);
    expect(last(t).physics!).toBeCloseTo(0.33, 2);
    t.loop.gesture({ type: 'lift', dy: 40 });
    t.step();
    expect(last(t).physics).toBe(0); // raised: the objects drop from there
    t.step(10);
    t.loop.gesture({ type: 'pinch', factor: 1.3 });
    t.step();
    expect(last(t).physics).toBe(0);
    t.step(10);
    t.loop.gesture({ type: 'twist', deg: 20 }); // turning does not start the fall again
    t.step();
    expect(last(t).physics!).toBeGreaterThan(0.3);
    t.loop.reset();
    t.step(5);
    t.loop.placeHere();
    t.step();
    expect(last(t).physics).toBe(0);
  });

  it('a take keeps the clock, restarts included', () => {
    const t = setup(true);
    t.loop.placeHere();
    const samples: WorldSample[] = [];
    for (let i = 0; i < 90; i++) {
      if (i === 60) t.loop.restartPhysics();
      t.step();
      samples.push({ t: i / 30, ...last(t) });
    }
    const take = buildWorldTake(samples, { fps: 30 })!;
    expect(take.tracks.pt).toBeTruthy();
    for (const i of [3, 20, 50, 59, 62, 80]) {
      const m = sampleWorldTake(take, i / 30);
      expect(Math.abs((m.physics ?? -1) - samples[i].physics!)).toBeLessThan(0.02);
    }
    // a take without physics has no such track
    const plain = buildWorldTake(samples.map(({ physics: _p, ...s }) => s), { fps: 30 })!;
    expect(plain.tracks.pt).toBeUndefined();
    expect(sampleWorldTake(plain, 1).physics).toBeUndefined();
  });
});
