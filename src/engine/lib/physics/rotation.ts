/**
 * Rotations for the physics node: quaternion <-> the Euler angles of the 3D nodes (degrees, matrix = Rz * Ry * Rx, see
 * `rotationZYX` in ../gen-common.ts). The simulation works with quaternions; the 3D nodes' Rotate XYZ wants these angles.
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Quaternion of the rotation `Rz(z) * Ry(y) * Rx(x)` (degrees). */
export function quatFromEuler(xDeg: number, yDeg: number, zDeg: number): Quat {
  const [hx, hy, hz] = [xDeg * D2R * 0.5, yDeg * D2R * 0.5, zDeg * D2R * 0.5];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(hx), Math.sin(hx), Math.cos(hy), Math.sin(hy), Math.cos(hz), Math.sin(hz)];
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

/** Row-major 3 x 3 matrix of a quaternion (the layout `rotationZYX` returns). */
export function matrixFromQuat(q: Quat): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [a, b, c, d] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  return [
    1 - 2 * (b * b + c * c), 2 * (a * b - c * d), 2 * (a * c + b * d),
    2 * (a * b + c * d), 1 - 2 * (a * a + c * c), 2 * (b * c - a * d),
    2 * (a * c - b * d), 2 * (b * c + a * d), 1 - 2 * (a * a + b * b),
  ];
}

/** Euler angles (degrees) such that `rotationZYX(x, y, z)` is the quaternion's matrix. Y stays within -90..90. */
export function eulerFromQuat(q: Quat): Vec3 {
  const m = matrixFromQuat(q);
  const sy = Math.max(-1, Math.min(1, -m[6]));
  const y = Math.asin(sy);
  if (Math.abs(sy) > 0.999999) {
    // looking straight up or down: x and z are one rotation, put it all in x
    return [Math.atan2(-m[5], m[4]) * R2D, y * R2D, 0];
  }
  return [Math.atan2(m[7], m[8]) * R2D, y * R2D, Math.atan2(m[3], m[0]) * R2D];
}
