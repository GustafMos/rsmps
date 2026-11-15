import { expect, it } from 'vitest';
import { harness } from '../../testing';
import type { CameraValue } from '../../types';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const project = { fps: 10, duration: 2, loop: true, width: 64, height: 64 };

async function cam(params: Record<string, unknown>, seconds = 0) {
  const t = await H();
  return (await t.run('camera', params, {}, { seconds, project })).camera as CameraValue;
}
const close = (a: number[], b: number[], eps = 1e-4) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));

it('default camera: perspective, in front of the origin, looking at it', async () => {
  const c = await cam({});
  expect(c.kind).toBe('camera');
  expect(c.projection).toBe('perspective');
  expect(c.target).toEqual([0, 0, 0]);
  expect(c.position[2]).toBeLessThan(0);
  expect(Math.hypot(...c.position)).toBeCloseTo(4.5, 3);
});

it('viewpoint presets and the free rig', async () => {
  close((await cam({ rig: 'front', distance: 5 })).position, [0, 0, -5]);
  close((await cam({ rig: 'side', distance: 5 })).position, [5, 0, 0]);
  const top = (await cam({ rig: 'top', distance: 5 })).position;
  expect(top[1]).toBeGreaterThan(4.99);
  close((await cam({ rig: 'free', posX: 1, posY: 2, posZ: -3 })).position, [1, 2, -3]);
  const o = await cam({ rig: 'orbit', azimuth: 90, elevation: 0, distance: 2 });
  close(o.position, [2, 0, 0]);
});

it('isometric and dimetric resolve to orthographic with the classic angles', async () => {
  const iso = await cam({ projection: 'isometric', distance: 10 });
  expect(iso.projection).toBe('orthographic');
  const [x, y, z] = iso.position;
  expect(Math.abs(x)).toBeCloseTo(Math.abs(z), 4);
  expect((Math.asin(y / 10) * 180) / Math.PI).toBeCloseTo(35.264, 2);
  const dim = await cam({ projection: 'dimetric', distance: 10 });
  expect((Math.asin(dim.position[1] / 10) * 180) / Math.PI).toBeCloseTo(30, 2);
});

it('lens settings are passed through', async () => {
  const c = await cam({ projection: 'fisheye', fov: 220, roll: 12, shiftX: 0.1, shiftY: -0.2, orthoSize: 5 });
  expect(c.projection).toBe('fisheye');
  expect(c.fov).toBe(220);
  expect(c.roll).toBe(12);
  expect(c.shift).toEqual([0.1, -0.2]);
  expect(c.orthoSize).toBe(5);
});

it('every motion loops exactly and moves', async () => {
  for (const motion of ['orbit', 'dolly', 'sway', 'roll']) {
    for (const cycles of [1, 3]) {
      const p = { motion, cycles, rig: 'orbit' };
      const [a, mid, end] = [await cam(p, 0), await cam(p, 0.7), await cam(p, 2)];
      close(a.position, end.position, 1e-3);
      expect(Math.abs(a.roll - end.roll) % 360, motion).toBeLessThan(1e-2);
      const moved = Math.hypot(...a.position.map((v, i) => v - mid.position[i])) + Math.abs(a.roll - mid.roll);
      expect(moved, `${motion} x${cycles}`).toBeGreaterThan(0.05);
    }
  }
  // no motion = static at any time
  close((await cam({ motion: 'none' }, 0)).position, (await cam({ motion: 'none' }, 1.3)).position);
});
