import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import type { CameraValue, Host } from '../../types';
import { rotationZYX } from '../../lib/gen-common';
import { cameraBasis } from '../../lib/gen-camera';
import { matFromQuat, qAxisAngle, quatFromLook, type Quat } from '../../lib/motion-math';
import { buildTake, neutralFrame, type MotionFrame, type RawSample } from '../../lib/motion-take';

/** A fake host: `channels` answers Host.signal for 'phone.<token>' and records every request. */
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
const P = { session: 'abc123', smoothing: 0 };

function takeOf(yawAt: (t: number) => number, seconds = 2) {
  const samples: RawSample[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += 0.01) {
    const q = qAxisAngle('y', yawAt(t));
    const v: MotionFrame = { ...neutralFrame(), qx: q[0], qy: q[1], qz: q[2], qw: q[3], aqx: q[0], aqy: q[1], aqz: q[2], aqw: q[3], tx: 0.5 };
    samples.push({ t, v });
  }
  return buildTake(samples, { fps: 30 })!;
}

describe('phone-motion', () => {
  it('live: outputs follow the signal bridge, in the namespace phone.<session>', async () => {
    const { host, asked } = fakeHost({ yaw: 30, pitch: 10, roll: -20, rx: 5, ax: 2, tx: 0.25, ty: -0.5, tc: 2, pinch: 1.5, heading: 123, px: 1, tap: 1, shake: 0.4 });
    const t = await harness([], host);
    const o = await t.run('phone-motion', P, {}, { seconds: 1 });
    expect(o.yaw).toBe(30);
    expect(o.pitch).toBe(10);
    expect(o.roll).toBe(-20);
    expect(o.rateX).toBe(5);
    expect(o.accX).toBe(2);
    expect(o.touchX).toBe(0.25);
    expect(o.touchY).toBe(-0.5);
    expect(o.touches).toBe(2);
    expect(o.pinch).toBe(1.5);
    expect(o.heading).toBe(123);
    expect(o.posX).toBe(1);
    expect(o.tap).toBe(1);
    expect(o.shake).toBeCloseTo(0.4, 9);
    expect(asked.every((a) => a.startsWith('phone.abc123|'))).toBe(true);
  });
  it('asks for the smoothed channel (name@amount), except counts, taps and shake', async () => {
    const { host, asked } = fakeHost({});
    const t = await harness([], host);
    await t.run('phone-motion', { ...P, smoothing: 0.4 }, {}, { seconds: 0 });
    expect(asked).toContain('phone.abc123|yaw@0.4');
    expect(asked).toContain('phone.abc123|tc');
    expect(asked).toContain('phone.abc123|tap');
    expect(asked).toContain('phone.abc123|shake');
  });
  it('sensitivity, invert, dead zone, limit and tilt stick', async () => {
    const { host } = fakeHost({ yaw: 40, pitch: 30, roll: 100 });
    const t = await harness([], host);
    const o = await t.run('phone-motion', { ...P, gainY: 3, invertX: true, deadzone: 5, limit: 90, tiltRange: 60 }, {}, { seconds: 0 });
    expect(o.yaw).toBe(90);
    expect(o.pitch as number).toBeLessThan(0);
    expect(o.roll as number).toBeLessThanOrEqual(90);
    expect(o.tiltX as number).toBeCloseTo(Math.min(1, (o.roll as number) / 60), 9);
    expect(o.tiltY as number).toBeCloseTo(Math.max(-1, (o.pitch as number) / 60), 9);
    const dz = await t.run('phone-motion', { ...P, deadzone: 5 }, {}, { seconds: 0 });
    expect(dz.yaw as number).toBeGreaterThan(30);
    expect(dz.yaw as number).toBeLessThan(40);
  });
  it('absolute mode reads the compass-referenced channels', async () => {
    const { host } = fakeHost({ yaw: 10, 'abs.yaw': 200 });
    const t = await harness([], host);
    expect((await t.run('phone-motion', { ...P, mode: 'absolute' }, {}, { seconds: 0 })).yaw).toBe(200);
    expect((await t.run('phone-motion', { ...P, mode: 'relative' }, {}, { seconds: 0 })).yaw).toBe(10);
  });
  it('linked but no motion arriving: neutral numbers, no error. Not linked and no take: a clear error', async () => {
    const t = await harness([], fakeHost({ yaw: 50 }, { live: false }).host);
    const o = await t.run('phone-motion', P, {}, { seconds: 0 });
    expect(o.yaw).toBe(0);
    expect(o.pinch).toBe(1);
    await expect(t.run('phone-motion', { session: '' }, {}, { seconds: 0 })).rejects.toThrow(/Not linked/);
  });
  it('recorded source: deterministic and independent of the host', async () => {
    const take = takeOf((s) => 40 * s);
    const a = await (await harness([], fakeHost({ yaw: 999 }).host)).run('phone-motion', { source: 'recorded', take }, {}, { seconds: 1 });
    const b = await (await harness([])).run('phone-motion', { source: 'recorded', take }, {}, { seconds: 1 });
    expect(a.yaw as number).toBeCloseTo(40, 1);
    expect(b.yaw as number).toBeCloseTo(a.yaw as number, 9);
  });
  it('recorded outputs follow the recorded move at every time', async () => {
    const take = takeOf((s) => 30 * Math.sin(s * 2));
    const t = await harness([]);
    for (const s of [0, 12 / 24, 21 / 24, 36 / 24]) { // whole frames of the default 24 fps project
      const x = await t.run('phone-motion', { source: 'recorded', take }, {}, { seconds: s });
      expect(Math.abs((x.yaw as number) - 30 * Math.sin(s * 2))).toBeLessThan(0.5);
    }
  });
  it('export: the live source uses the take when there is one, and says so clearly when there is none', async () => {
    const take = takeOf((s) => 40 * s);
    const t = await harness([], fakeHost({}, { exporting: true }).host);
    const o = await t.run('phone-motion', { ...P, take }, {}, { seconds: 1 });
    expect(o.yaw as number).toBeCloseTo(40, 1);
    await expect(t.run('phone-motion', P, {}, { seconds: 1 })).rejects.toThrow(/live only/);
    const headless = await harness([]);
    await expect(headless.run('phone-motion', P, {}, { seconds: 0 })).rejects.toThrow(/live only/);
  });
  it('take smoothing is applied at read time and does not shift the move', async () => {
    const take = takeOf((s) => 40 * s, 3);
    const t = await harness([]);
    const a = await t.run('phone-motion', { source: 'recorded', take, takeSmoothing: 0 }, {}, { seconds: 1.5 });
    const b = await t.run('phone-motion', { source: 'recorded', take, takeSmoothing: 0.6 }, {}, { seconds: 1.5 });
    expect(Math.abs((a.yaw as number) - (b.yaw as number))).toBeLessThan(0.5);
  });
  it('object rotation outputs reproduce the phone orientation in the order 3D Object uses', async () => {
    const q: Quat = quatFromLook(70, 55, 30);
    const samples: RawSample[] = [0, 0.5, 1].map((s) => ({ t: s, v: { ...neutralFrame(), qx: q[0], qy: q[1], qz: q[2], qw: q[3], aqx: q[0], aqy: q[1], aqz: q[2], aqw: q[3] } }));
    const take = buildTake(samples, { fps: 30 })!;
    const t = await harness([]);
    const o = await t.run('phone-motion', { source: 'recorded', take }, {}, { seconds: 0.5 });
    const R = rotationZYX(o.objX as number, o.objY as number, o.objZ as number);
    const M = matFromQuat(q);
    for (let i = 0; i < 9; i++) expect(Math.abs(R[i] - M[i])).toBeLessThan(2e-3);
  });
});

describe('phone-camera-rig', () => {
  const rig = (t: Awaited<ReturnType<typeof harness>>, params: Record<string, unknown>, camera?: CameraValue) => t.run('phone-camera-rig', params, (camera ? { camera } : {}) as never, { seconds: 0 });
  it('a neutral phone gives the default camera; the output is a normal camera value', async () => {
    const t = await harness([]);
    const c = (await rig(t, {})).camera as CameraValue;
    expect(c.kind).toBe('camera');
    expect(c.position).toEqual([0, 0, -4.5]);
    expect(c.target[2]).toBeCloseTo(0, 9);
  });
  it('looks where the phone looks (camera basis = phone orientation)', async () => {
    const t = await harness([]);
    const c = (await rig(t, { yaw: 50, pitch: 20, roll: 15 })).camera as CameraValue;
    const m = matFromQuat(quatFromLook(50, 20, 15));
    const b = cameraBasis(c);
    for (const [got, want] of [[b.forward, [m[2], m[5], m[8]]], [b.right, [m[0], m[3], m[6]]], [b.up, [m[1], m[4], m[7]]]] as [number[], number[]][]) for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 6);
  });
  it('uses a wired camera (keeps its lens), moves with position, orbit and lock roll', async () => {
    const t = await harness([]);
    const base: CameraValue = { kind: 'camera', projection: 'fisheye', fov: 120, orthoSize: 2, position: [0, 1, -3], target: [0, 1, 0], roll: 4, shift: [0.1, 0] };
    const c = (await rig(t, { yaw: 90, posX: 1, moveScale: 2, lockRoll: true, roll: 30 }, base)).camera as CameraValue;
    expect(c.projection).toBe('fisheye');
    expect(c.fov).toBe(120);
    expect(c.roll).toBe(4);
    expect(c.position[0]).toBeCloseTo(2, 9);
    expect(c.target[0]).toBeCloseTo(2 + 3, 6);
    const o = (await rig(t, { yaw: 90, orbit: true }, base)).camera as CameraValue;
    expect(o.target).toEqual([0, 1, 0]);
    expect(o.position[0]).toBeCloseTo(-3, 6);
  });
});
