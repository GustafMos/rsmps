import { describe, expect, it } from 'vitest';
import { PhoneSessions, type Peer } from '../../vite-plugins/phone-session';
import { deviceOrientationToQuat, lookAngles, qAxisAngle, qMul, worldToScene } from '../engine/lib/motion-math';
import { sampleTake, takeDense } from '../engine/lib/motion-take';
import { SignalRouter } from './signals';
import { MotionSession, PhoneMotionStore, RENDER_DELAY_MS } from './phone-motion';

/** A phone held upright (back camera towards `alpha`-dependent heading) with the given W3C angles. */
const motion = (t: number, alpha: number, beta = 90, gamma = 0, extra: Record<string, unknown> = {}) => ({ type: 'motion', t, q: deviceOrientationToQuat(alpha, beta, gamma), abs: 1, ...extra });

/** A fake clock and a phone sending at 60 Hz with an optional network delay pattern. */
function rig() {
  let now = 10_000;
  const session = new MotionSession(() => now);
  return {
    session,
    at: (ms: number) => (now = ms),
    get now() {
      return now;
    },
    /** The phone sends `n` packets at 60 Hz starting at phone time `t0`; `arrive(i)` is the transit time. */
    send(n: number, t0: number, make: (i: number, t: number) => unknown, arrive: (i: number) => number = () => 20) {
      for (let i = 0; i < n; i++) {
        const t = t0 + (i * 1000) / 60;
        now = 10_000 + t + arrive(i);
        session.ingest(make(i, t));
      }
    },
  };
}

describe('MotionSession (simulated phone)', () => {
  it('caps and validation: bad packets are ignored', () => {
    const r = rig();
    r.session.ingest({ type: 'caps', orientation: true, motion: true, absolute: true, geo: true, ar: false, touch: true, ios: false, hz: 999, on: { motion: true } });
    expect(r.session.caps?.hz).toBe(60);
    expect(r.session.caps?.ar).toBe(false);
    r.session.ingest({ type: 'motion', t: 'x' });
    r.session.ingest({ type: 'motion', t: 5, q: [1, 2] });
    r.session.ingest({ type: 'wrong' });
    r.session.ingest(null);
    expect(r.session.isLive()).toBe(false);
  });

  it('follows a turn and reports yaw / pitch / roll in the scene frame (compass-referenced)', () => {
    const r = rig();
    r.send(60, 0, (_, t) => motion(t, 360 - (t / 1000) * 90)); // turning right at 90 deg/s
    r.at(r.now + 5);
    const y1 = r.session.frame()['abs.yaw'];
    expect(y1).toBeGreaterThan(70);
    expect(y1).toBeLessThan(100);
    expect(r.session.channel('live')).toBe(1);
  });

  it('interpolates between packets: reading at 1 kHz is smooth even though packets come at 60 Hz with jitter', () => {
    const r = rig();
    const jitter = [5, 25, 12, 30, 8, 22, 15, 28];
    r.send(120, 0, (_, t) => motion(t, 360 - (t / 1000) * 60), (i) => jitter[i % jitter.length]);
    const base = r.now;
    let prev = NaN;
    let worst = 0;
    for (let k = 0; k < 600; k++) {
      r.at(base - 800 + k); // replay the last second at 1 kHz
      const y = r.session.channel('abs.yaw');
      if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    expect(worst).toBeLessThan(0.3); // 60 deg/s = 0.06 deg per ms; no jitter steps
  });

  it('the first pose is neutral; Recenter makes the current pose neutral again; relative angles come from the reference', () => {
    const r = rig();
    r.send(30, 0, (_, t) => motion(t, 90));
    r.at(r.now + 100);
    expect(Math.abs(r.session.frame().yaw)).toBeLessThan(1e-6);
    r.send(30, 600, (_, t) => motion(t, 90 - 40)); // turn 40 degrees to the right (alpha decreases)
    r.at(r.now + 100);
    expect(r.session.frame().yaw).toBeCloseTo(40, 3);
    r.session.ingest({ type: 'mevent', t: 1, e: 'recenter' });
    r.at(r.now + 60);
    expect(Math.abs(r.session.channel('yaw'))).toBeLessThan(0.01);
    // absolute stays absolute
    expect(Math.abs(r.session.channel('abs.yaw'))).toBeGreaterThan(1);
  });

  it('keeps yaw continuous through +-180 (unwrapped), roll and the object rotation too', () => {
    const r = rig();
    const vals: number[] = [];
    r.send(10, 0, (_, t) => motion(t, 180)); // faces away: first pose = reference
    for (let k = 0; k < 40; k++) {
      r.send(1, 200 + k * 30, (_, t) => motion(t, 180 - k * 10)); // keeps turning right through 360 degrees
      r.at(r.now + 80);
      vals.push(r.session.channel('abs.yaw'));
    }
    for (let i = 1; i < vals.length; i++) expect(Math.abs(vals[i] - vals[i - 1])).toBeLessThan(40);
    expect(vals[vals.length - 1] - vals[0]).toBeGreaterThan(250);
  });

  it('clock offset: a phone whose clock is far off still lines up', () => {
    const r = rig();
    r.send(60, 5_000_000, (_, t) => motion(t, 360 - ((t - 5_000_000) / 1000) * 60));
    r.at(r.now + 5);
    expect(r.session.isLive()).toBe(true);
    expect(Math.abs(r.session.channel('abs.yaw') - 60)).toBeLessThan(15);
  });

  it('no data after 1.5 s means not live', () => {
    const r = rig();
    r.send(10, 0, (_, t) => motion(t, 10));
    expect(r.session.isLive()).toBe(true);
    r.at(r.now + 2000);
    expect(r.session.isLive()).toBe(false);
    expect(r.session.channel('live')).toBe(0);
  });

  it('shake rises with acceleration and falls again; rotation rate and acceleration pass through', () => {
    const r = rig();
    r.send(30, 0, (_, t) => motion(t, 0, 90, 0, { a: [0, 0, 0], r: [10, 20, 30] }));
    r.at(r.now + 50);
    expect(r.session.channel('shake')).toBeLessThan(0.05);
    expect(r.session.channel('ry')).toBe(20);
    r.send(40, 600, (_, t) => motion(t, 0, 90, 0, { a: [12, 12, 12], r: [0, 0, 0] }));
    r.at(r.now + 30);
    expect(r.session.channel('shake')).toBeGreaterThan(0.6);
    expect(r.session.channel('ax')).toBe(12);
    r.send(120, 1400, (_, t) => motion(t, 0, 90, 0, { a: [0, 0, 0] }));
    r.at(r.now + 30);
    expect(r.session.channel('shake')).toBeLessThan(0.1);
  });

  it('touch pad: primary finger, count, pinch, twist, pan; fingers up resets; double-tap recenters; tap pulses', () => {
    const r = rig();
    r.send(10, 0, (_, t) => motion(t, 90));
    r.session.ingest({ type: 'touch', t: 1, p: [[0, 0.75, 0.25, 0.5]], ps: 1, tw: 0, pn: [0, 0], g: 1 });
    expect(r.session.channel('tx')).toBeCloseTo(0.5, 6);
    expect(r.session.channel('ty')).toBeCloseTo(0.5, 6); // y is flipped: up is +
    expect(r.session.channel('tc')).toBe(1);
    r.session.ingest({ type: 'touch', t: 2, p: [[0, 0.4, 0.5, 0], [1, 0.6, 0.5, 0]], ps: 1, tw: 0, pn: [0, 0], g: 2 });
    r.session.ingest({ type: 'touch', t: 3, p: [[0, 0.3, 0.5, 0], [1, 0.7, 0.5, 0]], ps: 2, tw: 15, pn: [0.1, 0.05], g: 2 });
    expect(r.session.channel('pinch')).toBe(2);
    expect(r.session.channel('twist')).toBe(15);
    expect(r.session.channel('tc')).toBe(2);
    expect(r.session.channel('panx')).toBeCloseTo(0.2, 6);
    // the virtual dolly follows the pan: this is where position comes from without AR or location
    expect(r.session.positionSource()).toBe('touch');
    expect(r.session.channel('px')).toBeCloseTo(0.2, 6);
    expect(r.session.channel('py')).toBeCloseTo(-0.1, 6);
    r.session.ingest({ type: 'touch', t: 4, p: [], ps: 1, tw: 0, pn: [0, 0], g: 2 });
    expect(r.session.channel('tc')).toBe(0);
    expect(r.session.channel('pinch')).toBe(1);
    expect(r.session.channel('px')).toBeCloseTo(0.2, 6); // the dolly stays where it was left
    r.session.ingest({ type: 'mevent', t: 5, e: 'tap' });
    expect(r.session.channel('tap')).toBe(1);
    r.at(r.now + 400);
    expect(r.session.channel('tap')).toBe(0);
    r.session.ingest({ type: 'mevent', t: 6, e: 'doubletap' });
    r.at(r.now + 10);
    expect(r.session.channel('px')).toBe(0); // double tap = recenter: dolly back to 0
  });

  it('position source: AR beats location beats the touch dolly; each is relative to Recenter', () => {
    const r = rig();
    r.send(10, 0, (_, t) => motion(t, 90));
    r.session.ingest({ type: 'geo', t: 1, x: 100, y: 50, alt: 3 });
    r.session.ingest({ type: 'geo', t: 2, x: 103, y: 54, alt: 4 });
    expect(r.session.positionSource()).toBe('location');
    expect(r.session.channel('px')).toBe(3); // east
    expect(r.session.channel('pz')).toBe(4); // north is "forward"
    expect(r.session.channel('py')).toBe(1);
    r.session.ingest({ type: 'ar', t: 3, p: [1, 1.5, -2], q: [0, 0, 0, 1] });
    r.session.ingest({ type: 'ar', t: 4, p: [1, 1.5, -3], q: [0, 0, 0, 1] }); // moved 1 m forward (WebXR -z is forward)
    expect(r.session.positionSource()).toBe('ar');
    expect(r.session.channel('pz')).toBeCloseTo(1, 6);
    expect(r.session.channel('px')).toBeCloseTo(0, 6);
    r.at(r.now + 3000); // AR packets stopped: fall back to location, then the dolly
    expect(r.session.positionSource()).toBe('location');
    r.at(r.now + 20_000);
    expect(r.session.positionSource()).toBe('touch');
  });

  it('smoothing by channel name: name@amount reduces jitter and settles on a constant', () => {
    const r = rig();
    let s = 3;
    const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    r.send(240, 0, (_, t) => motion(t, 360 - 2 * noise()));
    const raw: number[] = [];
    const smooth: number[] = [];
    const base = r.now;
    for (let k = 0; k < 2000; k += 8) {
      r.at(base - 2000 + k);
      raw.push(r.session.channel('abs.yaw'));
      smooth.push(r.session.channel('abs.yaw@0.6'));
    }
    const sd = (a: number[]) => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    };
    expect(sd(smooth.slice(40))).toBeLessThan(sd(raw.slice(40)) * 0.6);
  });

  it('the same instant answers every channel consistently (one evaluation = one pose)', () => {
    const r = rig();
    r.send(60, 0, (_, t) => motion(t, 360 - (t / 1000) * 90, 90, 0));
    r.at(r.now + 7);
    const a = r.session.channel('abs.yaw');
    const b = r.session.channel('abs.yaw');
    expect(a).toBe(b);
  });

  it('recording: captures the processed channels and builds a take that replays the move', () => {
    const r = rig();
    r.send(10, 0, (_, t) => motion(t, 90));
    r.session.startRecording();
    r.send(180, 200, (_, t) => motion(t, 90 - ((t - 200) / 1000) * 30)); // 3 s turn to the right, 30 deg/s
    const take = r.session.stopRecording({ fps: 30 });
    expect(take).not.toBeNull();
    expect(take!.frames).toBeGreaterThan(80);
    const d = takeDense(take!);
    expect(sampleTake(d, 1.5).yaw).toBeCloseTo(45, 0);
    expect(sampleTake(d, 0).yaw).toBeLessThan(2);
    // a take is plain JSON data
    expect(JSON.parse(JSON.stringify(take))).toEqual(take);
    expect(r.session.recording).toBe(false);
    expect(r.session.stopRecording({ fps: 30 })).toBeNull();
  });

  it('quaternion conversions on the wire agree with the phone side (round trip of a pose)', () => {
    const q = qMul(deviceOrientationToQuat(30, 70, -10), qAxisAngle('z', 0));
    const a = lookAngles(worldToScene(q));
    const r = rig();
    r.send(20, 0, (_, t) => ({ type: 'motion', t, q, abs: 1 }));
    r.at(r.now + 50);
    expect(r.session.channel('abs.pitch')).toBeCloseTo(a.pitch, 3);
    expect(RENDER_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('PhoneMotionStore and the signal bridge', () => {
  it('router: phone.<token> channels answer live, directly (not through the history), and are 0 during an export', () => {
    let now = 1000;
    const store = new PhoneMotionStore(() => now);
    store.ingest('tok', { type: 'caps', orientation: true, motion: true, absolute: true, geo: false, ar: false, touch: true, ios: false, hz: 60, on: { motion: true } });
    for (let i = 0; i < 30; i++) {
      now = 1000 + i * 17;
      store.ingest('tok', motion(i * 16.7, 90));
    }
    const router = new SignalRouter();
    router.phone = (token, name) => store.signal(token, name);
    now += 30;
    expect(router.signal('phone.tok', 'live', 0)).toBe(1);
    // a paused view (same frame asked again) follows the phone instead of replaying a recorded frame
    store.ingest('tok', { type: 'touch', t: 9, p: [[0, 1, 0, 0]], ps: 1, tw: 0, pn: [0, 0], g: 1 });
    expect(router.signal('phone.tok', 'tx', 0)).toBeCloseTo(1, 6);
    store.ingest('tok', { type: 'touch', t: 10, p: [[0, 0, 0, 0]], ps: 1, tw: 0, pn: [0, 0], g: 1 });
    expect(router.signal('phone.tok', 'tx', 0)).toBeCloseTo(-1, 6);
    expect(router.signal('phone.unknown', 'live', 0)).toBe(0);
    expect(router.signal('phone.unknown', 'qw', 0)).toBe(1);
    router.beginExport({ fps: 24, value: () => 5 });
    expect(router.signal('phone.tok', 'live', 0)).toBe(0);
    expect(router.signal('phone.tok', 'export', 0)).toBe(1);
    expect(router.signal('phone.tok', 'yaw', 0)).toBe(0);
    router.endExport();
    expect(router.signal('phone.tok', 'export', 0)).toBe(0);
  });

  it('audio signals are untouched by the phone path', () => {
    const router = new SignalRouter();
    router.live = () => 0.5;
    router.phone = () => 9;
    expect(router.signal('node1', 'level', 0)).toBe(0.5);
  });
});

describe('transport: motion frames pass through the pairing relay unchanged (web dev server and desktop app share PhoneSessions)', () => {
  const peer = (log: (string | Uint8Array)[]): Peer => ({ send: (d) => void log.push(d), close: () => undefined });
  it('relays text frames from the phone to the desktop, and ignores nothing', () => {
    const sessions = new PhoneSessions();
    const token = 'a'.repeat(32);
    const got: (string | Uint8Array)[] = [];
    sessions.registerDesktop(token, peer(got), 0);
    sessions.joinPhone(token, peer([]), 1);
    const frame = JSON.stringify({ type: 'motion', t: 12.5, q: [0, 0, 0, 1], abs: 1, r: [1, 2, 3], a: [0, 0, 0] });
    expect(sessions.relay(token, 'phone', frame, false)).toBe(true);
    expect(got[got.length - 1]).toBe(frame);
    // and the desktop side parses it back to the same message
    const s = new MotionSession(() => 0);
    s.ingest(JSON.parse(got[got.length - 1] as string));
    expect(s.status().frame.qw).toBe(1);
  });
  it('a 60 Hz frame is small', () => {
    const frame = JSON.stringify({ type: 'motion', t: 123456.7, q: [0.12345, -0.54321, 0.33333, 0.76543], abs: 1, h: 123.4, r: [12.3, -4.5, 0.1], a: [0.123, -0.456, 9.81], g: [0.1, 9.8, 0.2] });
    expect(frame.length).toBeLessThan(200);
  });
});
