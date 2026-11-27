/**
 * How steady a static object stays on a HAND-HELD phone. The loop and the fake XR session run for real; the phone is moved like a hand
 * moves it (slow intended motion, a 5-10 Hz tremor, sub-millimetre tracking jitter and small jumps), frames come at uneven times, and
 * each object picture is late by a different amount. Content at the placed spot, 0.3 m above it and 0.5 m to the side is followed from
 * where the picture has it to where the layer draws it, on a 1080x2340 screen, and compared with where it really is at that moment.
 *
 * Two numbers per row: `err` is the distance in pixels, `wobble` the frame-to-frame change of that error (the jitter you see, rather
 * than a steady offset). Set STEADY_TABLE=path to write the table to a file.
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

const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Band-limited noise: a few sinusoids between 5 and 10 Hz with random phases. `amp` is about the peak value. */
function tremor(rand: () => number, amp: number): (t: number) => number {
  const parts = [0, 1, 2].map(() => ({ f: 5 + 5 * rand(), ph: 2 * Math.PI * rand() }));
  return (t) => (amp / 1.6) * parts.reduce((s, p) => s + Math.sin(2 * Math.PI * p.f * t + p.ph), 0);
}

/** A picture source whose pictures arrive `delay()` ms after they were asked for (one at a time, like the real one). */
class TimedSource implements ArPictureSource {
  private pending: { moment: WorldMoment; due: number; depth: number; size: { width: number; height: number } } | null = null;
  private last: ArPicture | null = null;
  private seq = 0;
  nowMs = 0;
  constructor(private delay: () => number) {}
  advance(now: number): void {
    const p = this.pending;
    if (p && now >= p.due) {
      this.last = { moment: p.moment, depth: p.depth, width: p.size.width, height: p.size.height, seq: ++this.seq };
      this.pending = null;
    }
  }
  request(req: { moment: WorldMoment; depth: number; size: { width: number; height: number } }): boolean {
    if (this.pending) return false;
    this.pending = { moment: req.moment, due: this.nowMs + this.delay(), depth: req.depth, size: req.size };
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

export type Content = 'at' | 'above' | 'side';
const CONTENT: Record<Content, Vec3> = { at: [0, 0, 0], above: [0, 0.3, 0], side: [0.5, 0, 0] };
const apply = (m: Float32Array, p: Vec3): [number, number] => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w];
};

export type Case = 'still' | 'slow' | 'walking';
export type Delay = 'steady' | 'jittery';
/** 'off' is the draw path of the earlier releases. */
export type Mode = 'off' | 'predict' | 'auto';

/** Radians per second around the object, and a bob (2 Hz, metres) for walking. */
const MOTION: Record<Case, { omega: number; bob: number }> = { still: { omega: 0, bob: 0 }, slow: { omega: 0.1, bob: 0 }, walking: { omega: 0.5, bob: 0.02 } };

export interface Stat {
  err: number;
  wobble: number;
}
export interface Result {
  stats: Record<Content, Stat>;
  behindMs: number;
}

export function runSteady(o: { mode: Mode; kase: Case; delay: Delay; seed?: number; seconds?: number; shake?: number; loopClass?: typeof ArLoop; extra?: Record<string, unknown> }): Result {
  const rand = rng(o.seed ?? 7);
  const session = new FakeXrSession({ lens: LENS, width: W, height: H });
  const delayRand = rng(99);
  const delayMs = () => (o.delay === 'steady' ? 100 : delayRand() < 0.04 ? 300 : 60 + 140 * delayRand());
  const source = new TimedSource(delayMs);
  const painter = new Recorder();
  let clock = 0;
  const loop = new (o.loopClass ?? ArLoop)({
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
    steadying: o.mode,
    ...(o.extra ?? {}),
    now: () => clock,
    makeTransform: fakeTransform,
    screen: () => ({ width: 360, height: 640 }),
    onState: () => undefined,
  } as never);
  const mo = MOTION[o.kase];
  const tx = [tremor(rand, 0.002 * (o.shake ?? 1)), tremor(rand, 0.002 * (o.shake ?? 1)), tremor(rand, 0.002 * (o.shake ?? 1))];
  const tr = [tremor(rand, 0.35 * (o.shake ?? 1)), tremor(rand, 0.35 * (o.shake ?? 1)), tremor(rand, 0.2 * (o.shake ?? 1))];
  const jump: Vec3 = [0, 0, 0];
  let nextJump = 2;
  const R = 1.5;
  const trueAt = (t: number): XrPose => {
    const a = 0.3 + mo.omega * t; // angle around the object
    const bob = mo.bob * Math.sin(2 * Math.PI * 2 * t);
    const p: Vec3 = [FLOOR.p[0] + R * Math.sin(a) + tx[0](t), 1.3 + bob + tx[1](t), FLOOR.p[2] + R * Math.cos(a) + tx[2](t)];
    const pitch = (-Math.atan2(1.3, R) * 180) / Math.PI;
    let q = qMul(qAxisAngle('y', (a * 180) / Math.PI), qAxisAngle('x', pitch));
    q = qMul(q, qMul(qAxisAngle('y', tr[0](t)), qMul(qAxisAngle('x', tr[1](t)), qAxisAngle('z', tr[2](t)))));
    return { p, q };
  };
  const errs: Record<Content, [number, number][]> = { at: [], above: [], side: [] };
  loop.start();
  session.hit = FLOOR;
  const secs = o.seconds ?? 20;
  let t = 0;
  for (let i = 0; t < secs; i++) {
    const dt = 25 + 20 * rand();
    t += dt / 1000;
    clock += dt;
    const truth = trueAt(t);
    if (t > nextJump) {
      nextJump += 2 + 2 * rand();
      for (let k = 0; k < 3; k++) jump[k] += (rand() - 0.5) * 0.006;
    }
    // what the tracking reports: the true pose plus sub-millimetre jitter and the occasional correction of a few millimetres
    session.viewer = {
      p: [truth.p[0] + jump[0] + (rand() - 0.5) * 0.001, truth.p[1] + jump[1] + (rand() - 0.5) * 0.001, truth.p[2] + jump[2] + (rand() - 0.5) * 0.001],
      q: qMul(truth.q, qAxisAngle('y', (rand() - 0.5) * 0.06)),
    };
    source.nowMs = clock;
    source.advance(clock);
    painter.drawn = null;
    session.step(dt);
    if (i === 1) loop.placeHere();
    const pic = source.latest();
    const d = painter.drawn as { corners: Corners; vp: Float32Array } | null;
    if (t < 4 || !pic || !d || !pic.moment.object) continue;
    for (const c of Object.keys(CONTENT) as Content[]) {
      const w: Vec3 = [FLOOR.p[0] + CONTENT[c][0], FLOOR.p[1] + CONTENT[c][1], FLOOR.p[2] + CONTENT[c][2]];
      const n = project(pic.moment.view, pic.moment.lens, w)!;
      const u = (n[0] + 1) / 2;
      const v = (n[1] + 1) / 2;
      const [bl, br, tl] = d.corners;
      const q: Vec3 = [0, 1, 2].map((k) => bl[k] + u * (br[k] - bl[k]) + v * (tl[k] - bl[k])) as Vec3;
      const shown = apply(d.vp, q);
      const real = apply(d.vp, w);
      errs[c].push([((shown[0] - real[0]) * W) / 2, ((shown[1] - real[1]) * H) / 2]);
    }
  }
  const stat = (a: [number, number][]): Stat => {
    let e = 0;
    let wb = 0;
    for (let i = 0; i < a.length; i++) {
      e += Math.hypot(a[i][0], a[i][1]);
      if (i) wb += (a[i][0] - a[i - 1][0]) ** 2 + (a[i][1] - a[i - 1][1]) ** 2;
    }
    return { err: e / Math.max(1, a.length), wobble: Math.sqrt(wb / Math.max(1, a.length - 1)) };
  };
  return { stats: { at: stat(errs.at), above: stat(errs.above), side: stat(errs.side) }, behindMs: loop.state().pictureBehindMs };
}

const MODES: Mode[] = (process.env.STEADY_MODES ?? 'off,predict').split(',') as Mode[];

describe('a static object on a hand-held phone', () => {
  it('prints error and wobble (px, mean over a 20 s run) per mode, motion, delay and content position', () => {
    const lines = ['delay    motion   mode     |  at err/wob   above err/wob   side err/wob   | age ms'];
    for (const delay of ['steady', 'jittery'] as Delay[])
      for (const kase of ['still', 'slow', 'walking'] as Case[])
        for (const mode of MODES) {
          const r = runSteady({ mode, kase, delay });
          const f = (c: Content) => `${r.stats[c].err.toFixed(2)}/${r.stats[c].wobble.toFixed(2)}`.padEnd(14);
          lines.push(`${delay.padEnd(8)} ${kase.padEnd(8)} ${mode.padEnd(8)} |  ${f('at')} ${f('above')}  ${f('side')} | ${r.behindMs}`);
        }
    if (process.env.STEADY_TABLE) writeFileSync(process.env.STEADY_TABLE, lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(1);
  });

  it('automatic steadying is never less steady than off while standing or moving slowly, even with a 3 times stronger shake', () => {
    for (const shake of [1, 3])
      for (const delay of ['steady', 'jittery'] as Delay[])
        for (const kase of ['still', 'slow'] as Case[]) {
          const off = runSteady({ mode: 'off', kase, delay, shake });
          const auto = runSteady({ mode: 'auto', kase, delay, shake });
          for (const c of ['at', 'above', 'side'] as Content[]) {
            expect(auto.stats[c].wobble, `${shake}x ${delay} ${kase} ${c} wobble`).toBeLessThanOrEqual(off.stats[c].wobble * 1.05 + 0.01);
            expect(auto.stats[c].err, `${shake}x ${delay} ${kase} ${c} error`).toBeLessThanOrEqual(off.stats[c].err * 1.05 + 0.01);
          }
        }
  });

  it('automatic steadying cuts the error by a third or more when walking, with no more wobble', () => {
    for (const delay of ['steady', 'jittery'] as Delay[]) {
      const off = runSteady({ mode: 'off', kase: 'walking', delay });
      const auto = runSteady({ mode: 'auto', kase: 'walking', delay });
      for (const c of ['above', 'side'] as Content[]) {
        expect(auto.stats[c].err, `${delay} ${c}`).toBeLessThan(off.stats[c].err * 0.67);
        expect(auto.stats[c].wobble, `${delay} ${c}`).toBeLessThan(off.stats[c].wobble * 1.1);
      }
    }
  });

  it('content at the placed spot is exact in every mode (the layer is at its depth)', () => {
    for (const mode of ['off', 'auto', 'predict'] as Mode[]) for (const kase of ['still', 'walking'] as Case[]) expect(runSteady({ mode, kase, delay: 'jittery', seconds: 8 }).stats.at.err).toBeLessThan(0.01);
  });
});
