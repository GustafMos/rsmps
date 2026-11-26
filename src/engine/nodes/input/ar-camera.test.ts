import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import type { CameraValue, Host } from '../../types';
import { cameraBasis } from '../../lib/gen-camera';
import { matFromQuat, quatFromLook, type Quat } from '../../lib/motion-math';
import { cameraFromQuat } from '../../lib/motion-rig';
import { THIS_DEVICE, motionSession } from '../../lib/motion-source';
import { buildTake, neutralFrame, sampleTake, takeDense, type MotionFrame, type RawSample } from '../../lib/motion-take';

function fakeHost(channels: Record<string, number>, opts: { live?: boolean; exporting?: boolean } = {}) {
  const asked: string[] = [];
  const host: Host = {
    assetInfo: () => null,
    assetFrame: async () => null,
    signal(nodeId, name) {
      asked.push(`${nodeId}|${name}`);
      if (name === 'export') return opts.exporting ? 1 : 0;
      if (opts.exporting) return 0;
      if (name === 'live') return opts.live === false ? 0 : 1;
      return channels[name.split('@')[0]] ?? 0;
    },
  };
  return { host, asked };
}
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 6) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], digits);
};
const lq = (q: Quat) => ({ lqx: q[0], lqy: q[1], lqz: q[2], lqw: q[3] });

describe('cameraFromQuat', () => {
  it('the camera axes are exactly the quaternion\'s, for every direction including straight up and down', () => {
    for (const [yaw, pitch, roll] of [[0, 0, 0], [70, 20, 0], [-130, -45, 25], [10, 90, 0], [200, -90, 40], [45, 89.99, -70], [0, 0, 180]]) {
      const q = quatFromLook(yaw, pitch, roll);
      const m = matFromQuat(q);
      const cam = cameraFromQuat(q, { fov: 50, distance: 3, height: 1 });
      const b = cameraBasis(cam);
      close(b.forward, [m[2], m[5], m[8]], 5);
      close(b.right, [m[0], m[3], m[6]], 5);
      close(b.up, [m[1], m[4], m[7]], 5);
      close(cam.position, [0, 1, -3]);
      expect(cam.fov).toBe(50);
    }
  });
  it('identity looks at the middle of the scene from the front', () => {
    const cam = cameraFromQuat([0, 0, 0, 1], { fov: 45, distance: 4.5, height: 0 });
    close(cam.position, [0, 0, -4.5]);
    close(cam.target, [0, 0, -3.5]);
    expect(cam.roll).toBeCloseTo(0, 9);
    expect(cam.projection).toBe('perspective');
  });
});

describe('ar-camera', () => {
  it('this device: reads the level orientation from phone.this-device and needs no linked phone', async () => {
    const q = quatFromLook(90, 0, 0);
    const { host, asked } = fakeHost(lq(q));
    const t = await harness([], host);
    const cam = (await t.run('ar-camera', { device: 'this', smoothing: 0 }, {}, { seconds: 0 })).camera as CameraValue;
    close(cameraBasis(cam).forward, [1, 0, 0], 6);
    expect(asked.every((a) => a.startsWith(`phone.${THIS_DEVICE}|`))).toBe(true);
    expect(asked).toContain(`phone.${THIS_DEVICE}|lqw`);
  });
  it('smoothing asks for the smoothed channels', async () => {
    const { host, asked } = fakeHost(lq([0, 0, 0, 1]));
    const t = await harness([], host);
    await t.run('ar-camera', { device: 'this', smoothing: 0.3 }, {}, { seconds: 0 });
    expect(asked).toContain(`phone.${THIS_DEVICE}|lqx@0.3`);
  });
  it('no sensor values (a computer): the neutral camera, not an error. A linked phone that was never linked: a clear error', async () => {
    const t = await harness([], fakeHost({}, { live: false }).host);
    const cam = (await t.run('ar-camera', { device: 'this' }, {}, { seconds: 0 })).camera as CameraValue;
    close(cameraBasis(cam).forward, [0, 0, 1]);
    close(cam.position, [0, 0, -4.5]);
    await expect(t.run('ar-camera', { device: 'linked', session: '' }, {}, { seconds: 0 })).rejects.toThrow(/Not linked/);
  });
  it('recorded take: plays back without sensors; exports use the take or say what to do', async () => {
    const samples: RawSample[] = [];
    for (let s = 0; s <= 2.001; s += 0.01) {
      const q = quatFromLook(45 * s, 0, 0);
      const v: MotionFrame = { ...neutralFrame(), ...lq(q) };
      samples.push({ t: s, v });
    }
    const take = buildTake(samples, { fps: 30 })!;
    const headless = await harness([]);
    const cam = (await headless.run('ar-camera', { source: 'recorded', take }, {}, { seconds: 1 })).camera as CameraValue;
    const f = cameraBasis(cam).forward;
    expect((Math.atan2(f[0], f[2]) * 180) / Math.PI).toBeCloseTo(45, 0);
    const exporting = await harness([], fakeHost({}, { exporting: true }).host);
    const viaTake = (await exporting.run('ar-camera', { device: 'this', take }, {}, { seconds: 2 })).camera as CameraValue;
    expect((Math.atan2(cameraBasis(viaTake).forward[0], cameraBasis(viaTake).forward[2]) * 180) / Math.PI).toBeCloseTo(90, 0);
    await expect(exporting.run('ar-camera', { device: 'this' }, {}, { seconds: 0 })).rejects.toThrow(/AR Camera is live only/);
    await expect(headless.run('ar-camera', { device: 'this' }, {}, { seconds: 0 })).rejects.toThrow(/live only/);
  });
});

describe('phone-motion with this device, and the new outputs', () => {
  it('Sensors from: This device reads phone.this-device, with no session', async () => {
    const { host, asked } = fakeHost({ yaw: 12, gx: 0.5, gy: -0.8, jolt: 1 });
    const t = await harness([], host);
    const o = await t.run('phone-motion', { device: 'this', smoothing: 0.2 }, {}, { seconds: 0 });
    expect(o.yaw).toBe(12);
    expect(o.gravX).toBe(0.5);
    expect(o.gravY).toBe(-0.8);
    expect(o.jolt).toBe(1);
    expect(asked.every((a) => a.startsWith(`phone.${THIS_DEVICE}|`))).toBe(true);
    expect(asked).toContain(`phone.${THIS_DEVICE}|gx@0.2`);
    expect(asked).toContain(`phone.${THIS_DEVICE}|jolt`); // a pulse is never smoothed
  });
  it('the default is still the linked phone (old projects are unchanged)', async () => {
    expect(motionSession({ session: 'abc' })).toBe('abc');
    expect(motionSession({ session: 'abc', device: 'linked' })).toBe('abc');
    expect(motionSession({ session: 'abc', device: 'this' })).toBe(THIS_DEVICE);
    const { host, asked } = fakeHost({ yaw: 5 });
    const t = await harness([], host);
    await t.run('phone-motion', { session: 'abc' }, {}, { seconds: 0 });
    expect(asked.every((a) => a.startsWith('phone.abc|'))).toBe(true);
  });
});

describe('takes and the level orientation', () => {
  it('a take from before the level orientation existed plays its recentered orientation instead', () => {
    const q = quatFromLook(30, 10, 0);
    const samples: RawSample[] = [0, 0.5, 1].map((s) => ({ t: s, v: { ...neutralFrame(), qx: q[0], qy: q[1], qz: q[2], qw: q[3] } }));
    const take = buildTake(samples, { fps: 30 })!;
    const old = { ...take, raw: Object.fromEntries(Object.entries(take.raw).filter(([k]) => !k.startsWith('lq') && k !== 'gx' && k !== 'gy' && k !== 'jolt')) };
    const fr = sampleTake(takeDense(old), 0.5, false);
    close([fr.lqx, fr.lqy, fr.lqz, fr.lqw], q, 3);
    expect(fr.gx).toBe(0);
    expect(fr.jolt).toBe(0);
  });
  it('the level orientation is stored and smoothed as a rotation (unit length at every frame)', () => {
    const samples: RawSample[] = [];
    for (let s = 0; s <= 1.001; s += 0.02) samples.push({ t: s, v: { ...neutralFrame(), ...lq(quatFromLook(170 * s, 80 * s, 0)) } });
    const d = takeDense(buildTake(samples, { fps: 30 })!, { amount: 0.4 });
    for (let i = 0; i < d.frames; i++) expect(Math.hypot(d.ch.lqx[i], d.ch.lqy[i], d.ch.lqz[i], d.ch.lqw[i])).toBeCloseTo(1, 3);
  });
});

describe('ar-camera in a picture (GPU)', () => {
  it('the object is in the middle when looking straight ahead, moves left when the phone turns right, and is gone when looking away', async () => {
    const centreOf = async (yaw: number) => {
      const t = await harness([], fakeHost(lq(quatFromLook(yaw, 0, 0))).host);
      const camera = (await t.run('ar-camera', { device: 'this', smoothing: 0, fov: 45 }, {}, { seconds: 0 })).camera as CameraValue;
      const img = (await t.run('object-3d', { shape: 'sphere', spinX: 0, spinY: 0, spinZ: 0 }, { camera } as never, { project: { width: 96, height: 96 } })).image;
      const px = await t.pixels(img as never);
      let n = 0;
      let sx = 0;
      for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) if (px.data[(y * px.width + x) * 4 + 3] > 128) (n++, (sx += x));
      return { n, x: n ? sx / n : NaN };
    };
    const ahead = await centreOf(0);
    expect(ahead.n).toBeGreaterThan(50);
    expect(Math.abs(ahead.x - 47.5)).toBeLessThan(1.5);
    const right = await centreOf(10);
    expect(right.n).toBeGreaterThan(50);
    // the phone turned right, so the object slid to the left: 10 degrees through a 45 degree lens on 96 px is tan(10) / tan(22.5) * 48 = 20.4 px
    expect(ahead.x - right.x).toBeGreaterThan(18);
    expect(ahead.x - right.x).toBeLessThan(23);
    expect((await centreOf(120)).n).toBe(0);
  });
});
