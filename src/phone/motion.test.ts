import { describe, expect, it } from 'vitest';
import { GeoOrigin, RateGate, buildMotionPacket, iosAlphaOffset, type RawSensors } from './motion-pure';
import { parseMotionMessage } from './motion-protocol';
import { TapDetector, newGesture, updateGesture } from './touch-gestures';
import { lookAngles, worldToScene, qMul, qAxisAngle } from '../engine/lib/motion-math';

const sensors = (o: Partial<RawSensors> = {}): RawSensors => ({ alpha: 0, beta: 90, gamma: 0, absolute: true, heading: null, screenAngle: 0, rate: null, accel: null, accelG: null, ...o });

describe('motion packets', () => {
  it('builds a compact packet with the quaternion, rate and acceleration', () => {
    const m = buildMotionPacket(sensors({ rate: { alpha: 3, beta: 1, gamma: 2 }, accel: { x: 0.1234, y: 0, z: 9.81 }, accelG: { x: 0, y: 0, z: 9.8 } }), 1234.567, null);
    expect(m.type).toBe('motion');
    expect(m.t).toBe(1234.6);
    expect(m.abs).toBe(1);
    expect(m.r).toEqual([1, 2, 3]); // x, y, z = beta, gamma, alpha
    expect(m.a).toEqual([0.123, 0, 9.81]);
    expect(Math.hypot(...m.q!)).toBeCloseTo(1, 4);
    expect(parseMotionMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
  it('leaves out what the sensors do not report', () => {
    const m = buildMotionPacket(sensors({ alpha: null, beta: null, gamma: null, rate: { alpha: 1, beta: 2, gamma: 3 } }), 5, null);
    expect(m.q).toBeUndefined();
    expect(m.a).toBeUndefined();
    expect(parseMotionMessage({ type: 'motion', t: 5 })).toBeNull();
  });
  it('applies the screen orientation: landscape reads like portrait', () => {
    const portrait = buildMotionPacket(sensors({ alpha: 0, beta: 90, gamma: 0, screenAngle: 0 }), 0, null).q!;
    const a = lookAngles(worldToScene(portrait));
    expect(Math.abs(a.yaw) + Math.abs(a.pitch) + Math.abs(a.roll)).toBeLessThan(0.01);
    const chassisLandscape = qMul(qAxisAngle('z', 0), qAxisAngle('z', 0));
    expect(chassisLandscape[3]).toBe(1);
  });
  it('iOS: without an absolute event, the compass heading fixes the yaw offset and marks the packet absolute', () => {
    expect(iosAlphaOffset(100, 90, null)).toBeCloseTo(170, 6); // 360 - 90 - 100 = 170
    const off = iosAlphaOffset(100, 90, null);
    const m = buildMotionPacket(sensors({ absolute: false, heading: 90, alpha: 100 }), 0, off);
    expect(m.abs).toBe(1);
    expect(m.h).toBe(90);
    const plain = buildMotionPacket(sensors({ absolute: false, heading: null, alpha: 100 }), 0, off);
    expect(plain.abs).toBe(0);
    // the offset is smoothed on the circle: a +-180 wrap in the raw value does not swing it
    const next = iosAlphaOffset(100, 90, 179);
    expect(Math.abs(next - 179) < 20 || Math.abs(next + 181) < 20).toBe(true);
  });
  it('validates incoming frames', () => {
    expect(parseMotionMessage({ type: 'touch', t: 1, p: Array.from({ length: 9 }, (_, i) => [i, 0.5, 0.5, 0]), ps: 1, tw: 0, pn: [0, 0], g: 1 })).toMatchObject({ type: 'touch' });
    expect((parseMotionMessage({ type: 'touch', t: 1, p: Array.from({ length: 9 }, (_, i) => [i, 0.5, 0.5, 0]) }) as { p: unknown[] }).p).toHaveLength(5);
    expect(parseMotionMessage({ type: 'geo', t: 1, x: 'a', y: 2 })).toBeNull();
    expect(parseMotionMessage({ type: 'ar', t: 1, p: [0, 0, 0], q: [0, 0, 0, NaN] })).toBeNull();
    expect(parseMotionMessage({ type: 'mevent', t: 1, e: 'explode' })).toBeNull();
    expect(parseMotionMessage({ type: 'offer', sdp: 'x' })).toBeNull();
  });
});

describe('rate cap and location', () => {
  it('coalesces display frames to the capped rate', () => {
    const g = new RateGate(30);
    let sent = 0;
    for (let t = 0; t < 1000; t += 1000 / 120) if (g.ready(t)) sent++; // a 120 Hz display
    expect(sent).toBeGreaterThan(25);
    expect(sent).toBeLessThanOrEqual(35);
    const g60 = new RateGate(60);
    let n = 0;
    for (let t = 0; t < 1000; t += 1000 / 60) if (g60.ready(t)) n++; // a 60 Hz display passes everything
    expect(n).toBeGreaterThanOrEqual(60);
  });
  it('location is relative to the first fix, in metres east and north', () => {
    const o = new GeoOrigin();
    expect(o.fix(52, 5, 10)).toEqual({ x: 0, y: 0, alt: 0 });
    const f = o.fix(52.0001, 5.0001, 12);
    expect(f.y).toBeCloseTo(11.132, 2);
    expect(f.x).toBeCloseTo(11.132 * Math.cos((52 * Math.PI) / 180), 2);
    expect(f.alt).toBe(2);
    expect(o.fix(52, 5, null).alt).toBeUndefined();
  });
});

describe('touch pad gestures', () => {
  const two = (ax: number, ay: number, bx: number, by: number) => [
    { id: 0, x: ax, y: ay, force: 0 },
    { id: 1, x: bx, y: by, force: 0 },
  ];
  it('pinch scale, twist and two-finger pan, relative to where the gesture started', () => {
    const st = newGesture();
    expect(updateGesture(st, two(0.4, 0.5, 0.6, 0.5))).toEqual({ pinch: 1, twist: 0, pan: [0, 0] });
    const spread = updateGesture(st, two(0.3, 0.5, 0.7, 0.5));
    expect(spread.pinch).toBeCloseTo(2, 9);
    expect(spread.twist).toBeCloseTo(0, 6);
    const twisted = updateGesture(st, two(0.5 - 0.1, 0.5 + 0.1, 0.5 + 0.1, 0.5 - 0.1)); // clockwise on the screen is y-down positive
    expect(twisted.twist).toBeLessThan(0);
    const moved = updateGesture(st, two(0.5, 0.6, 0.7, 0.6));
    expect(moved.pan[0]).toBeCloseTo(0.1, 6);
    expect(moved.pan[1]).toBeCloseTo(0.1, 6);
  });
  it('a clockwise twist as the user sees it is positive and keeps counting past 180 degrees', () => {
    const st = newGesture();
    updateGesture(st, two(0.4, 0.5, 0.6, 0.5));
    let last = 0;
    for (let a = 10; a <= 270; a += 10) {
      const r = (a * Math.PI) / 180;
      const out = updateGesture(st, two(0.5 - 0.1 * Math.cos(r), 0.5 - 0.1 * Math.sin(r), 0.5 + 0.1 * Math.cos(r), 0.5 + 0.1 * Math.sin(r)));
      expect(out.twist).toBeGreaterThan(last - 1e-9);
      last = out.twist;
    }
    expect(last).toBeCloseTo(270, 4);
  });
  it('a new gesture starts when fingers change, one finger gives neutral values, up to 5 touches are tracked by the caller', () => {
    const st = newGesture();
    updateGesture(st, two(0.4, 0.5, 0.6, 0.5));
    const g1 = st.gid;
    expect(updateGesture(st, [{ id: 0, x: 0.5, y: 0.5, force: 0 }])).toEqual({ pinch: 1, twist: 0, pan: [0, 0] });
    updateGesture(st, two(0.2, 0.5, 0.8, 0.5));
    expect(st.gid).toBe(g1 + 1);
  });
  it('tap and double tap', () => {
    const d = new TapDetector();
    d.start(0, 0, 0.5, 0.5);
    expect(d.end(0, 100, 0.5, 0.5)).toEqual(['tap']);
    d.start(0, 200, 0.5, 0.5);
    expect(d.end(0, 280, 0.5, 0.51)).toEqual(['tap', 'doubletap']);
    d.start(0, 1000, 0.5, 0.5);
    expect(d.end(0, 1600, 0.5, 0.5)).toEqual([]); // too long: a hold
    d.start(0, 2000, 0.1, 0.1);
    expect(d.end(0, 2050, 0.5, 0.5)).toEqual([]); // moved: a drag
    d.start(0, 3000, 0.5, 0.5);
    expect(d.end(0, 3050, 0.5, 0.5, true)).toEqual([]); // two fingers were down
  });
});
