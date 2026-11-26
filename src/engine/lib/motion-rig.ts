/** Camera rig driven by a phone's look angles (pure). The phone is a window you look around with. */
import type { CameraValue } from '../types';
import { cameraBasis } from './gen-camera';
import { matFromQuat, quatFromLook, type Quat, type Vec3 } from './motion-math';

export interface RigOptions {
  /** Orbit: the phone's direction moves the camera round the target; otherwise the camera turns its head in place. */
  orbit: boolean;
  /** Keep the base camera's roll (ignore the phone's roll). */
  lockRoll: boolean;
  /** Added to the camera height (scene units). */
  heightOffset: number;
  /** Scene units per unit of the position input. */
  moveScale: number;
}

/** The camera used when none is wired: the Camera node's defaults (perspective, 40 degrees, 4.5 in front of the origin). */
export function defaultRigCamera(): CameraValue {
  return { kind: 'camera', projection: 'perspective', fov: 40, orthoSize: 2.8, position: [0, 0, -4.5], target: [0, 0, 0], roll: 0, shift: [0, 0] };
}

/** Forward (view direction) of the look angles, in scene axes. */
export function lookForward(yawDeg: number, pitchDeg: number, rollDeg = 0): Vec3 {
  const m = matFromQuat(quatFromLook(yawDeg, pitchDeg, rollDeg));
  return [m[2], m[5], m[8]];
}

export function applyRig(base: CameraValue, yaw: number, pitch: number, roll: number, pos: Vec3, o: RigOptions): CameraValue {
  const f = lookForward(yaw, Math.max(-89.5, Math.min(89.5, pitch)), 0);
  const off: Vec3 = [pos[0] * o.moveScale, pos[1] * o.moveScale + o.heightOffset, pos[2] * o.moveScale];
  const d0 = Math.hypot(base.target[0] - base.position[0], base.target[1] - base.position[1], base.target[2] - base.position[2]);
  const d = d0 < 1e-3 ? 1 : d0;
  let position: Vec3;
  let target: Vec3;
  if (o.orbit) {
    target = [base.target[0] + off[0], base.target[1] + off[1] - o.heightOffset, base.target[2] + off[2]];
    position = [target[0] - f[0] * d, target[1] - f[1] * d + o.heightOffset, target[2] - f[2] * d];
  } else {
    position = [base.position[0] + off[0], base.position[1] + off[1], base.position[2] + off[2]];
    target = [position[0] + f[0] * d, position[1] + f[1] * d, position[2] + f[2] * d];
  }
  return { ...base, position, target, roll: o.lockRoll ? base.roll : base.roll - roll };
}

/**
 * A camera that stands still and takes the orientation of a scene quaternion exactly (its right / up / forward axes are the
 * quaternion's), with no Euler angles in between, so pointing the phone straight up or down is as good as any other direction.
 * The camera stands `distance` in front of the origin (on -z) and `height` above it: with the identity it looks at the origin.
 */
export function cameraFromQuat(q: Quat, o: { fov: number; distance: number; height: number }): CameraValue {
  const m = matFromQuat(q);
  const forward: Vec3 = [m[2], m[5], m[8]];
  const right: Vec3 = [m[0], m[3], m[6]];
  const position: Vec3 = [0, o.height, -o.distance];
  const target: Vec3 = [position[0] + forward[0], position[1] + forward[1], position[2] + forward[2]];
  // roll: the angle from the camera's roll-free right axis to the wanted one, measured towards its up axis
  const b = cameraBasis({ position, target, roll: 0 });
  const dot = (a: Vec3, c: Vec3): number => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const roll = (Math.atan2(dot(right, b.up), dot(right, b.right)) * 180) / Math.PI;
  return { kind: 'camera', projection: 'perspective', fov: o.fov, orthoSize: 2.8, position, target, roll, shift: [0, 0] };
}
