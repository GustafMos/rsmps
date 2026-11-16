/**
 * Camera maths shared by the `camera` node and `object-3d`.
 * World: x right, y up, z into the screen. The default camera sits on -z looking at the origin.
 */
import type { CameraValue } from '../types';

export type V3 = [number, number, number];
export const PROJECTION_ID = { orthographic: 0, perspective: 1, fisheye: 2, panoramic: 3, cylindrical: 4 } as const;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Camera position on a sphere around `target`. azimuth 0 = in front (on -z), elevation 90 = straight above. */
export function orbitPosition(target: V3, distance: number, azimuthDeg: number, elevationDeg: number): V3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (Math.max(-89.9, Math.min(89.9, elevationDeg)) * Math.PI) / 180;
  return add(target, scale([Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)], distance));
}

export interface CameraBasis {
  position: V3;
  right: V3;
  up: V3;
  forward: V3;
}

/** Orthonormal view basis (with roll applied). */
export function cameraBasis(cam: Pick<CameraValue, 'position' | 'target' | 'roll'>): CameraBasis {
  let forward = sub(cam.target, cam.position);
  if (len(forward) < 1e-6) forward = [0, 0, 1];
  forward = norm(forward);
  const upRef: V3 = Math.abs(forward[1]) > 0.999 ? [0, 0, forward[1] > 0 ? -1 : 1] : [0, 1, 0];
  const right0 = norm(cross(upRef, forward));
  const up0 = cross(forward, right0);
  const r = (cam.roll * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  return {
    position: cam.position,
    forward,
    right: add(scale(right0, c), scale(up0, s)),
    up: add(scale(right0, -s), scale(up0, c)),
  };
}

/**
 * The simple built-in camera of the 3D generators, expressed as a CameraValue: an object about 2 units wide
 * at the origin fills `frameSize` of the frame's shorter side and sits at (x, y) of the frame.
 */
export function simpleCamera(o: { ortho: boolean; fovDeg: number; frameSize: number; x: number; y: number; width: number; height: number }): CameraValue {
  const scale = Math.max(0.001, o.frameSize);
  const short = Math.min(o.width, o.height);
  const D = 1 / Math.sin((Math.min(90, Math.max(5, o.fovDeg)) * Math.PI) / 360);
  const tanH = 1 / Math.sqrt(D * D - 1);
  return {
    kind: 'camera',
    projection: o.ortho ? 'orthographic' : 'perspective',
    fov: (2 * Math.atan(tanH / scale) * 180) / Math.PI,
    orthoSize: 2 / scale,
    position: [0, 0, o.ortho ? -6 : -D],
    target: [0, 0, 0],
    roll: 0,
    shift: [((o.x - 0.5) * o.width) / short, (-(o.y - 0.5) * o.height) / short],
  };
}
