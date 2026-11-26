import { describe, expect, it } from 'vitest';
import { cameraBasis } from '../engine/lib/gen-camera';
import { deviceOrientationToQuat, lookAngles, matFromQuat, qAxisAngle, qMul, quatFromLook, worldToScene, type Quat, type Vec3 } from '../engine/lib/motion-math';
import { cameraFromQuat } from '../engine/lib/motion-rig';
import { DeviceSensors, IDLE_STOP_MS, SILENT_AFTER_MS, buildDevicePacket, followAngle, northOffset, toScreenAxes, type SensorEnv } from './device-sensors';
import { JOLT_AT, MotionSession, levelQuat, screenGravity } from './phone-motion';

const RAD = 180 / Math.PI;

/**
 * The W3C angles of a pose given by where the phone's own axes point in the world (x east, y north, z up): `right` = towards its right
 * edge, `top` = towards its top edge. Written from the specification's rotation matrix, independently of the code under test.
 */
function anglesOf(right: Vec3, top: Vec3): { alpha: number; beta: number; gamma: number } {
  const out: Vec3 = [right[1] * top[2] - right[2] * top[1], right[2] * top[0] - right[0] * top[2], right[0] * top[1] - right[1] * top[0]];
  // R (columns = right, top, out) = Rz(alpha) Rx(beta) Ry(gamma)
  const r = (row: number, col: number): number => [right, top, out][col][row];
  const beta = Math.asin(Math.max(-1, Math.min(1, r(2, 1))));
  if (Math.abs(r(2, 1)) > 0.9999) return { alpha: Math.atan2(r(1, 0), r(0, 0)) * RAD, beta: beta * RAD, gamma: 0 }; // upright: alpha and gamma are one turn
  return { alpha: Math.atan2(-r(0, 1), r(1, 1)) * RAD, beta: beta * RAD, gamma: Math.atan2(-r(2, 0), r(2, 2)) * RAD };
}
const E: Vec3 = [1, 0, 0];
const W: Vec3 = [-1, 0, 0];
const N: Vec3 = [0, 1, 0];
const S: Vec3 = [0, -1, 0];
const UP: Vec3 = [0, 0, 1];
const DOWN: Vec3 = [0, 0, -1];
/** Poses: [name, right edge points, top edge points, screen angle]. The user looks at the screen; the back camera looks the other way. */
const POSES = {
  flatNorth: { right: E, top: N, screen: 0 },
  uprightNorth: { right: E, top: UP, screen: 0 },
  uprightEast: { right: S, top: UP, screen: 0 },
  landscapeLeftNorth: { right: UP, top: W, screen: 90 }, // top edge to the left
  landscapeRightNorth: { right: DOWN, top: E, screen: 270 }, // top edge to the right
};
const sceneOf = (p: { right: Vec3; top: Vec3; screen: number }): Quat => {
  const a = anglesOf(p.right, p.top);
  return worldToScene(deviceOrientationToQuat(a.alpha, a.beta, a.gamma, p.screen));
};
/** Camera axes of a scene quaternion: [right, up, forward]. */
const axes = (q: Quat): [Vec3, Vec3, Vec3] => {
  const m = matFromQuat(q);
  return [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]];
};
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 6) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], digits);
};

describe('orientation of known poses (alpha / beta / gamma + screen angle to a rotation)', () => {
  it('flat on a table, screen up: the back camera looks straight down, the top of the picture is north', () => {
    const [right, up, forward] = axes(sceneOf(POSES.flatNorth));
    close(forward, [0, -1, 0]);
    close(up, [0, 0, 1]); // scene z = north
    close(right, [1, 0, 0]);
  });
  it('upright portrait, looking north: the neutral pose', () => {
    const [right, up, forward] = axes(sceneOf(POSES.uprightNorth));
    close(forward, [0, 0, 1]);
    close(up, [0, 1, 0]);
    close(right, [1, 0, 0]);
  });
  it('upright, looking east: turned 90 degrees to the right', () => {
    const q = sceneOf(POSES.uprightEast);
    close(axes(q)[2], [1, 0, 0]);
    expect(lookAngles(q).yaw).toBeCloseTo(90, 5);
    expect(lookAngles(q).pitch).toBeCloseTo(0, 5);
  });
  it('landscape either way round reads exactly like upright: the screen angle is taken out', () => {
    for (const p of [POSES.landscapeLeftNorth, POSES.landscapeRightNorth]) {
      const [right, up, forward] = axes(sceneOf(p));
      close(forward, [0, 0, 1]);
      close(up, [0, 1, 0]);
      close(right, [1, 0, 0]);
    }
  });
  it('without the screen angle a landscape phone would read as rolled by a quarter turn (the compensation matters)', () => {
    const a = anglesOf(POSES.landscapeLeftNorth.right, POSES.landscapeLeftNorth.top);
    expect(Math.abs(lookAngles(worldToScene(deviceOrientationToQuat(a.alpha, a.beta, a.gamma, 0))).roll)).toBeCloseTo(90, 5);
  });
});

describe('pure helpers', () => {
  it('toScreenAxes: with the top edge to the left, the phone\'s "up" is the picture\'s left and its "right" is the picture\'s up', () => {
    close(toScreenAxes([0, 1, 5], 90), [-1, 0, 5]);
    close(toScreenAxes([1, 0, 5], 90), [0, 1, 5]);
    close(toScreenAxes([1, 2, 3], 0), [1, 2, 3]);
    close(toScreenAxes([1, 2, 3], 180), [-1, -2, 3]);
    close(toScreenAxes([0, 1, 0], 270), [1, 0, 0]);
  });
  it('northOffset: the turn about the vertical between the gyro-only and the compass orientation, in any pose (also upright, where alpha is unstable)', () => {
    for (const [beta, gamma] of [[0, 0], [40, -20], [90, 0], [89.99, 30], [-60, 70]]) {
      const rel = deviceOrientationToQuat(10, beta, gamma);
      const abs = qMul(qAxisAngle('z', 75), rel);
      expect(northOffset(rel, abs)).toBeCloseTo(75, 6);
    }
    expect(northOffset(deviceOrientationToQuat(350, 20, 5), deviceOrientationToQuat(10, 20, 5))).toBeCloseTo(20, 6);
  });
  it('followAngle goes the short way round and starts at the first value', () => {
    expect(followAngle(null, 170)).toBe(170);
    expect(followAngle(10, 20, 0.5)).toBeCloseTo(15, 6);
    expect(Math.abs(followAngle(175, -175, 0.5))).toBeCloseTo(180, 6);
  });
  it('levelQuat removes only the heading: pitch and roll stay true to gravity', () => {
    const q = quatFromLook(70, 25, -10);
    const a = lookAngles(levelQuat(q, 70));
    expect(a.yaw).toBeCloseTo(0, 6);
    expect(a.pitch).toBeCloseTo(25, 6);
    expect(a.roll).toBeCloseTo(-10, 6);
    expect(lookAngles(levelQuat(q, 30)).yaw).toBeCloseTo(40, 6);
  });
  it('screenGravity: down on the screen for upright, flat, tilted and landscape phones', () => {
    const g = (p: { right: Vec3; top: Vec3; screen: number }) => {
      const a = anglesOf(p.right, p.top);
      return screenGravity(deviceOrientationToQuat(a.alpha, a.beta, a.gamma, p.screen));
    };
    close(g(POSES.uprightNorth), [0, -1]);
    close(g(POSES.flatNorth), [0, 0]);
    close(g(POSES.landscapeLeftNorth), [0, -1]); // held in landscape, down is still the bottom of the picture
    close(g(POSES.landscapeRightNorth), [0, -1]);
    // upright, then turned clockwise as the user sees it (right edge lower): gravity pulls to the right of the picture
    const s = Math.SQRT1_2;
    const tilted = g({ right: [s, 0, -s], top: [s, 0, s], screen: 0 });
    expect(tilted[0]).toBeCloseTo(s, 6);
    expect(tilted[1]).toBeCloseTo(-s, 6);
  });
  it('buildDevicePacket: screen-compensated vectors, the compass offset only when the orientation is not absolute itself', () => {
    const base = { rel: { alpha: 10, beta: 90, gamma: 0 }, relIsAbsolute: false, abs: null, heading: null, north: 33, rate: [1, 2, 3] as Vec3, accel: [0, 1, 0] as Vec3, accelG: null };
    const m = buildDevicePacket(base, 5, 90)!;
    expect(m.abs).toBe(0);
    expect(m.n).toBe(33);
    close(m.q!, deviceOrientationToQuat(10, 90, 0, 90));
    close(m.r!, [-2, 1, 3]);
    close(m.a!, [-1, 0, 0]);
    expect(buildDevicePacket({ ...base, relIsAbsolute: true }, 5, 0)!.n).toBeUndefined();
    expect(buildDevicePacket({ ...base, relIsAbsolute: true }, 5, 0)!.abs).toBe(1);
    const onlyAbs = buildDevicePacket({ ...base, rel: null, abs: { alpha: 1, beta: 2, gamma: 3 } }, 5, 0)!;
    expect(onlyAbs.abs).toBe(1);
    expect(buildDevicePacket({ rel: null, relIsAbsolute: false, abs: null, heading: null, north: null, rate: null, accel: null, accelG: null }, 5, 0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ the provider, with fake events and a fake clock */

function fakeEnv(over: Partial<SensorEnv> = {}) {
  const listeners = new Map<string, Set<(e: never) => void>>();
  const timers = new Set<{ ms: number; fn: () => void; next: number }>();
  const clock = { t: 1000, angle: 0 };
  const env: SensorEnv = {
    target: {
      addEventListener: (type, fn) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn),
    },
    now: () => clock.t,
    secure: true,
    hasOrientation: true,
    hasMotion: true,
    hasAbsoluteEvent: true,
    screenAngle: () => clock.angle,
    every: (ms, fn) => {
      const tm = { ms, fn, next: clock.t + ms };
      timers.add(tm);
      return () => void timers.delete(tm);
    },
    ...over,
  };
  const session = new MotionSession(() => clock.t);
  const sensors = new DeviceSensors(session, env);
  return {
    env,
    clock,
    session,
    sensors,
    count: (type: string) => listeners.get(type)?.size ?? 0,
    emit: (type: string, e: object) => listeners.get(type)?.forEach((fn) => fn(e as never)),
    /** Move the clock, running the interval timers on the way. */
    advance(ms: number) {
      const end = clock.t + ms;
      for (;;) {
        const due = [...timers].filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        clock.t = due.next;
        due.next += due.ms;
        due.fn();
      }
      clock.t = end;
    },
  };
}
type Fake = ReturnType<typeof fakeEnv>;
/** Hold a pose for `ms` (events every 16 ms), asking for values the way a rendering node does. */
function hold(f: Fake, pose: { right: Vec3; top: Vec3; screen: number }, ms = 200, type = 'deviceorientation', extra: object = {}) {
  const a = anglesOf(pose.right, pose.top);
  f.clock.angle = pose.screen;
  for (let i = 0; i < ms / 16; i++) {
    f.sensors.demand();
    f.emit(type, { ...a, absolute: false, ...extra });
    f.advance(16);
  }
}

describe('DeviceSensors: listening only while used', () => {
  it('does not listen until a value is asked for, and stops a few seconds after the last request', () => {
    const f = fakeEnv();
    expect(f.count('deviceorientation')).toBe(0);
    expect(f.sensors.status().state).toBe('idle');
    f.sensors.demand();
    expect(f.count('deviceorientation')).toBe(1);
    expect(f.count('deviceorientationabsolute')).toBe(1);
    expect(f.count('devicemotion')).toBe(1);
    expect(f.sensors.status().state).toBe('waiting');
    f.sensors.demand(); // asking again adds nothing
    expect(f.count('deviceorientation')).toBe(1);
    f.advance(IDLE_STOP_MS + 1500);
    expect(f.count('deviceorientation')).toBe(0);
    expect(f.count('deviceorientationabsolute')).toBe(0);
    expect(f.count('devicemotion')).toBe(0);
    expect(f.sensors.active).toBe(false);
    f.sensors.demand(); // and starts again on the next request
    expect(f.sensors.active).toBe(true);
  });
  it('keeps listening while it is asked', () => {
    const f = fakeEnv();
    for (let i = 0; i < 10; i++) {
      f.sensors.demand();
      f.advance(1000);
    }
    expect(f.sensors.active).toBe(true);
  });
  it('a computer: events exist but nothing arrives, so it says there are no sensors (an empty event does not count)', () => {
    const f = fakeEnv();
    f.sensors.demand();
    f.emit('deviceorientation', { alpha: null, beta: null, gamma: null });
    f.emit('devicemotion', { acceleration: { x: null, y: null, z: null }, accelerationIncludingGravity: null, rotationRate: null });
    f.sensors.demand();
    f.advance(SILENT_AFTER_MS - 600);
    f.sensors.demand();
    expect(f.sensors.status().state).toBe('waiting');
    f.advance(700);
    expect(f.sensors.status().state).toBe('silent');
    expect(f.sensors.status().message).toMatch(/no motion sensors/);
    expect(f.session.isLive()).toBe(false);
  });
  it('no motion events in the browser, or a page that is not https: says so and never listens', () => {
    const none = fakeEnv({ hasOrientation: false, hasMotion: false });
    none.sensors.demand();
    expect(none.sensors.status().state).toBe('unsupported');
    expect(none.sensors.active).toBe(false);
    const http = fakeEnv({ secure: false });
    http.sensors.demand();
    expect(http.sensors.status().state).toBe('insecure');
    expect(http.sensors.status().message).toMatch(/https/);
    expect(http.sensors.active).toBe(false);
    const noWindow = new DeviceSensors(new MotionSession(() => 0), null);
    noWindow.demand();
    expect(noWindow.status().state).toBe('unsupported');
  });
});

describe('DeviceSensors: permission', () => {
  it('iOS: never asks by itself; the button asks for both sensors, then values flow', async () => {
    const asked: string[] = [];
    const f = fakeEnv({
      hasAbsoluteEvent: false,
      requestOrientation: async () => (asked.push('orientation'), 'granted'),
      requestMotion: async () => (asked.push('motion'), 'granted'),
    });
    f.sensors.demand();
    expect(f.sensors.status().state).toBe('waiting'); // listening costs nothing and asks nothing
    f.advance(SILENT_AFTER_MS + 100);
    f.sensors.demand();
    expect(asked).toEqual([]);
    expect(f.sensors.status().state).toBe('needs-permission');
    expect(f.sensors.status().needsButton).toBe(true);
    expect(f.session.isLive()).toBe(false);
    const p = f.sensors.allow();
    expect(asked).toEqual(['orientation', 'motion']); // both asked inside the press, before anything is awaited
    expect((await p).state).toBe('waiting');
    expect(f.sensors.active).toBe(true);
    hold(f, POSES.uprightNorth);
    expect(f.sensors.status().state).toBe('live');
  });
  it('iOS: a refusal is remembered and explained. Values that arrive all the same count more than the answer', async () => {
    const f = fakeEnv({ requestOrientation: async () => 'denied', requestMotion: async () => 'granted' });
    const st = await f.sensors.allow();
    expect(st.state).toBe('denied');
    expect(st.message).toMatch(/blocked/);
    f.advance(IDLE_STOP_MS + 1500);
    expect(f.sensors.status().state).toBe('denied');
    expect(f.session.isLive()).toBe(false);
    hold(f, POSES.uprightNorth); // a browser that says "denied" and delivers anyway
    expect(f.sensors.status().state).toBe('live');
    const thrown = fakeEnv({ requestOrientation: () => Promise.reject(new Error('no gesture')) });
    expect((await thrown.sensors.allow()).state).toBe('denied');
  });
  it('Chrome has the same question and answers it by itself: values flow without the button, and a computer still ends at "no sensors"', async () => {
    const asked: string[] = [];
    const ask = async () => (asked.push('x'), 'granted');
    const phone = fakeEnv({ requestOrientation: ask, requestMotion: ask });
    hold(phone, POSES.uprightNorth);
    expect(phone.sensors.status().state).toBe('live');
    expect(asked).toEqual([]);
    const computer = fakeEnv({ requestOrientation: ask, requestMotion: ask });
    computer.sensors.demand();
    computer.advance(SILENT_AFTER_MS + 100);
    computer.sensors.demand();
    expect(computer.sensors.status().state).toBe('needs-permission');
    await computer.sensors.allow();
    computer.advance(SILENT_AFTER_MS + 100);
    computer.sensors.demand();
    expect(computer.sensors.status().state).toBe('silent');
  });
  it('Android: no question exists, the button just starts the sensors', async () => {
    const f = fakeEnv();
    const st = await f.sensors.allow();
    expect(st.needsButton).toBe(false);
    expect(st.state).toBe('waiting');
    expect(f.sensors.active).toBe(true);
  });
});

describe('DeviceSensors: the values reach the motion session', () => {
  it('orientation: the first pose is straight ahead, turning to the east turns the AR camera to the right, in portrait and landscape', () => {
    for (const first of [POSES.uprightNorth, POSES.landscapeLeftNorth, POSES.landscapeRightNorth]) {
      const f = fakeEnv();
      hold(f, first);
      const fr = f.session.frame();
      close([fr.lqx, fr.lqy, fr.lqz, Math.abs(fr.lqw)], [0, 0, 0, 1], 4);
      expect(f.session.channel('live')).toBe(1);
      expect(fr.gx).toBeCloseTo(0, 4);
      expect(fr.gy).toBeCloseTo(-1, 4);
      hold(f, POSES.uprightEast);
      const e = f.session.frame();
      expect(e.yaw).toBeCloseTo(90, 3);
      const cam = cameraFromQuat([e.lqx, e.lqy, e.lqz, e.lqw], { fov: 45, distance: 4.5, height: 0 });
      const b = cameraBasis(cam);
      close(b.forward, [1, 0, 0], 4);
      close(b.up, [0, 1, 0], 4);
      // the scene's middle (straight ahead before the turn) is now on the left of the picture: it stayed put in the room
      const toOrigin: Vec3 = [-cam.position[0], -cam.position[1], -cam.position[2]];
      expect(toOrigin[0] * b.right[0] + toOrigin[1] * b.right[1] + toOrigin[2] * b.right[2]).toBeLessThan(-4);
    }
  });
  it('the level orientation stays true to gravity after Recenter: a phone pointed at the floor still looks at the floor', () => {
    const f = fakeEnv();
    hold(f, POSES.uprightEast);
    hold(f, POSES.flatNorth, 300);
    f.session.recenter();
    f.advance(20);
    const fr = f.session.frame();
    close([fr.qx, fr.qy, fr.qz, Math.abs(fr.qw)], [0, 0, 0, 1], 4); // the recentered orientation is neutral...
    const b = cameraBasis(cameraFromQuat([fr.lqx, fr.lqy, fr.lqz, fr.lqw], { fov: 45, distance: 4.5, height: 0 }));
    close(b.forward, [0, -1, 0], 4); // ...the level one still looks down
  });
  it('compass: the absolute event gives a north reference while the orientation itself stays gyro-only', () => {
    const f = fakeEnv();
    // the gyro-only stream believes the phone looks "north"; the compass knows it looks east
    const rel = anglesOf(POSES.uprightNorth.right, POSES.uprightNorth.top);
    const abs = anglesOf(POSES.uprightEast.right, POSES.uprightEast.top);
    for (let i = 0; i < 20; i++) {
      f.sensors.demand();
      f.emit('deviceorientation', { ...rel, absolute: false });
      f.emit('deviceorientationabsolute', { ...abs, absolute: true });
      f.advance(16);
    }
    const fr = f.session.frame();
    expect(fr.yaw).toBeCloseTo(0, 3);
    expect(fr.heading).toBeCloseTo(90, 3);
    expect(fr['abs.yaw']).toBeCloseTo(90, 3);
    expect(f.sensors.status().compass).toBe(true);
    expect(f.session.status().caps?.absolute).toBe(true);
    expect(f.session.status().caps?.orientation).toBe(true);
  });
  it('rotation rate and acceleration arrive along the screen axes; shake rises and a bump gives one jolt pulse', () => {
    const f = fakeEnv();
    f.clock.angle = 90;
    const motion = (acc: number) => ({ rotationRate: { alpha: 3, beta: 1, gamma: 2 }, acceleration: { x: 0, y: acc, z: 0 }, accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 } });
    for (let i = 0; i < 12; i++) {
      f.sensors.demand();
      f.emit('devicemotion', motion(1));
      f.advance(16);
    }
    let fr = f.session.frame();
    close([fr.rx, fr.ry, fr.rz], [-2, 1, 3], 6); // about x, y, z of the phone = (1, 2, 3), turned to the screen
    close([fr.ax, fr.ay, fr.az], [-1, 0, 0], 6);
    expect(fr.jolt).toBe(0);
    const calm = fr.shake;
    f.emit('devicemotion', motion(JOLT_AT + 6));
    f.advance(16);
    f.emit('devicemotion', motion(JOLT_AT + 6));
    f.advance(50);
    fr = f.session.frame();
    expect(fr.jolt).toBe(1);
    expect(fr.shake).toBeGreaterThan(calm + 0.3);
    f.emit('devicemotion', motion(1));
    f.advance(200);
    expect(f.session.frame().jolt).toBe(0); // a pulse, not a level
    expect(f.session.status().caps?.motion).toBe(true);
  });
  it('a take recorded from this device plays the same turn back', () => {
    const f = fakeEnv();
    hold(f, POSES.uprightNorth);
    f.session.startRecording();
    hold(f, POSES.uprightNorth, 300);
    hold(f, POSES.uprightEast, 300);
    const take = f.session.stopRecording({ fps: 30 })!;
    expect(take.frames).toBeGreaterThan(10);
    expect(take.raw.lqw.length).toBeGreaterThanOrEqual(2);
    expect(take.raw.gy.length).toBeGreaterThanOrEqual(2);
  });
});
