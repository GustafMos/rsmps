/**
 * How far the object slides on the screen when its picture is late. The loop and the fake XR session run for real; the picture
 * source is a fake whose delay (in camera frames) is a parameter, and the painter records where the flat layer is drawn. A world point
 * that is INSIDE the picture (content at the placed spot, above it, behind it, in front of it) is followed from where the picture
 * has it to where the layer puts it on a 1080x2340 screen, and compared with where the point really is at that moment.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qAxisAngle, qMul, type Vec3 } from '../../engine/lib/motion-math';
import { lensFromFov, project, type Corners, type XrPose } from '../../engine/lib/xr-math';
import type { WorldMoment } from '../../engine/lib/world-take';
import { FakeXrSession, fakeTransform } from './fake-xr';
import { ArLoop, type ArPainter, type ArPicture, type ArPictureSource } from './loop';
import { featuresOf } from './xr-api';

const W = 1080;
const H = 2340;
const FLOOR: XrPose = { p: [0, 0, -1.5], q: [0, 0, 0, 1] };
const LENS = lensFromFov(60, W / H);
const MS = 33;

/** A picture source whose pictures arrive `late` frames after they were asked for (one at a time, like the real one). */
class LateSource implements ArPictureSource {
  frame = 0;
  private pending: { moment: WorldMoment; due: number; depth: number; size: { width: number; height: number } } | null = null;
  private last: ArPicture | null = null;
  private seq = 0;
  constructor(public late: number) {}
  advance(): void {
    this.frame++;
    const p = this.pending;
    if (p && this.frame >= p.due) {
      this.last = { moment: p.moment, depth: p.depth, width: p.size.width, height: p.size.height, seq: ++this.seq };
      this.pending = null;
    }
  }
  request(req: { moment: WorldMoment; depth: number; size: { width: number; height: number } }): boolean {
    if (this.pending) return false;
    this.pending = { moment: req.moment, due: this.frame + this.late, depth: req.depth, size: req.size };
    return true;
  }
  latest() {
    return this.last;
  }
  error() {
    return null;
  }
}

class Recorder implements ArPainter {
  drawn: { corners: Corners; vp: Float32Array } | null = null;
  begin() {}
  picture(corners: Corners, vp: Float32Array) {
    this.drawn = { corners, vp };
  }
  ring() {}
}

type Content = 'at' | 'above' | 'behind' | 'front';
const OFFSET: Record<Content, Vec3> = { at: [0, 0, 0], above: [0, 0.5, 0], behind: [0, 0, -0.5], front: [0, 0, 0.5] };
/** Where the content really is at a physics time. Still: it stays. Moving: it drops, bounces and rolls away from the placed spot. */
const where = (c: Content, s: number, moving: boolean): Vec3 => {
  const o = OFFSET[c];
  const m: Vec3 = moving ? [0.4 * s, 0.6 * Math.abs(Math.cos(2.5 * s)) - 0.3, -0.3 * s] : [0, 0, 0];
  return [FLOOR.p[0] + o[0] + m[0], FLOOR.p[1] + o[1] + m[1], FLOOR.p[2] + o[2] + m[2]];
};

const apply = (m: Float32Array, p: Vec3): [number, number] => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w];
};

interface Row {
  /** Swim: where the layer puts a point of the picture against where that content was when the picture was made (does it stay in the room?). */
  err: Record<Content, { mean: number; max: number }>;
  /** Lag: the same against where the moving content is right now (is the animation up to date?). Only the content at the placed spot. */
  lag: { mean: number; max: number };
  behindMs: number;
}

/** wobble: the phone's speed varies by +-60 percent about once a second instead of staying steady. */
function run(o: { late: number; predict: boolean; moving: boolean; wobble?: boolean }): Row {
  const session = new FakeXrSession({ lens: LENS, width: W, height: H });
  const source = new LateSource(o.late);
  const painter = new Recorder();
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
    seconds: () => 0,
    physics: o.moving,
    predictPose: o.predict,
    now: () => clock,
    makeTransform: fakeTransform,
    screen: () => ({ width: 360, height: 640 }),
    onState: () => undefined,
  });
  // 0.5 m/s sideways, turning towards the object at 10 degrees per second
  const poseAt = (t: number): XrPose => {
    const x = o.wobble ? 0.5 * t + (0.3 * Math.sin(2 * Math.PI * t)) / (2 * Math.PI) : 0.5 * t;
    return { p: [x, 1.4, 0], q: qMul(qAxisAngle('y', 10 * t), qAxisAngle('x', -40)) };
  };
  const errs: Record<Content, number[]> = { at: [], above: [], behind: [], front: [] };
  const lags: number[] = [];
  loop.start();
  session.hit = FLOOR;
  const place = 2; // placeHere() is asked for after frame 1 and carried out in frame 2: the physics clock starts there
  let t0 = 0;
  for (let i = 0; i < 110; i++) {
    clock += MS;
    session.viewer = poseAt(clock / 1000);
    source.advance();
    painter.drawn = null;
    session.step(MS);
    if (i === 1) loop.placeHere();
    if (i === place) t0 = clock;
    const pic = source.latest();
    const d = painter.drawn as { corners: Corners; vp: Float32Array } | null;
    if (i < 50 || !pic || !d || !pic.moment.object) continue;
    const s0 = pic.moment.physics ?? 0;
    const sNow = o.moving ? (clock - t0) / 1000 : 0;
    for (const c of Object.keys(OFFSET) as Content[]) {
      // where the picture has this content (a point of the picture), where the layer puts that point on the screen, and where the content really is
      const n = project(pic.moment.view, pic.moment.lens, where(c, s0, o.moving))!;
      const u = (n[0] + 1) / 2;
      const v = (n[1] + 1) / 2;
      const [bl, br, tl] = d.corners;
      const q: Vec3 = [0, 1, 2].map((k) => bl[k] + u * (br[k] - bl[k]) + v * (tl[k] - bl[k])) as Vec3;
      const shown = apply(d.vp, q);
      const real = apply(d.vp, where(c, s0, o.moving));
      errs[c].push(Math.hypot(((shown[0] - real[0]) * W) / 2, ((shown[1] - real[1]) * H) / 2));
      if (c === 'at') {
        const now = apply(d.vp, where(c, sNow, o.moving));
        lags.push(Math.hypot(((shown[0] - now[0]) * W) / 2, ((shown[1] - now[1]) * H) / 2));
      }
    }
  }
  const sum = (a: number[]) => ({ mean: a.reduce((x, y) => x + y, 0) / Math.max(1, a.length), max: Math.max(0, ...a) });
  return { err: { at: sum(errs.at), above: sum(errs.above), behind: sum(errs.behind), front: sum(errs.front) }, lag: sum(lags), behindMs: loop.state().pictureBehindMs };
}

const fmt = (r: Row) => (['at', 'above', 'behind', 'front'] as Content[]).map((c) => `${r.err[c].mean.toFixed(1)}/${r.err[c].max.toFixed(1)}`).join('  ');

describe('a late object picture on a moving phone', () => {
  it('prints the error in pixels (mean/max) at the placed spot, 0.5 m above, behind and in front', () => {
    const lines: string[] = ['late  predict  content        at          above       behind      front       (picture age ms)'];
    for (const moving of [false, true]) for (const wobble of [false, true]) for (const late of [1, 3, 6]) for (const predict of [false, true]) {
      const r = run({ late, predict, moving, wobble });
      lines.push(`${late}     ${predict ? 'on ' : 'off'}      ${moving ? 'moving' : 'still '} ${wobble ? 'wobbly' : 'steady'}  ${fmt(r)}   lag ${r.lag.mean.toFixed(1)}/${r.lag.max.toFixed(1)}  (${r.behindMs})`);
    }
    if (process.env.SWIM_TABLE) writeFileSync(process.env.SWIM_TABLE, lines.join('\n') + '\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('with the prediction, 3 frames late stays within a few pixels for all positions, still and moving', () => {
    for (const moving of [false, true]) {
      const r = run({ late: 3, predict: true, moving });
      for (const c of ['at', 'above', 'behind', 'front'] as Content[]) expect(r.err[c].max, `${c} ${moving ? 'moving' : 'still'}`).toBeLessThan(6);
    }
  });

  it('the picture age is reported', () => {
    const r = run({ late: 3, predict: true, moving: false });
    expect(r.behindMs).toBeGreaterThan(60);
    expect(r.behindMs).toBeLessThan(400);
  });
});
