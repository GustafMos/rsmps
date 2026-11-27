/**
 * Picking and moving ONE object in the AR view (pure). The room (metres, WebXR axes) and the object frame the 3D nodes live in (scene
 * units, scene axes: the placement's frame with z turned round) are tied together by `worldCamera` / `sceneToWorld` in xr-math.ts; this
 * file is the other direction (room to scene) plus the little bits of ray maths the picking needs.
 */
import { qConj, rotate, type Vec3 } from './motion-math';
import { flipZ, placementQuat, sceneToWorld, type Placement, type SceneFit } from './xr-math';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Metres per scene unit for this placement (its size times the camera's Object size / 2). */
export const metresPerUnit = (pl: Pick<Placement, 'scale'>, fit: SceneFit): number => Math.max(1e-6, pl.scale * fit.unit);

/** A point of the room in scene units: the inverse of `sceneToWorld`. `pl` is the placement as the scene sees it (height included). */
export function worldToScene(point: Vec3, pl: Placement, fit: SceneFit): Vec3 {
  const local = rotate(qConj(placementQuat(pl)), sub(point, pl.p));
  const k = 1 / metresPerUnit(pl, fit);
  return flipZ([local[0] * k, local[1] * k - fit.lift, local[2] * k]);
}

/** A direction of the room as a direction of the scene (unit length). */
export function worldDirToScene(dir: Vec3, pl: Placement): Vec3 {
  return norm(flipZ(rotate(qConj(placementQuat(pl)), dir)));
}

/** An amount of movement in the room (a difference of two points) as scene units. */
export function worldDeltaToScene(delta: Vec3, pl: Placement, fit: SceneFit): Vec3 {
  const local = rotate(qConj(placementQuat(pl)), delta);
  const k = 1 / metresPerUnit(pl, fit);
  return flipZ([local[0] * k, local[1] * k, local[2] * k]);
}

/** A ray of the room as a ray of the scene. */
export function worldRayToScene(ray: { origin: Vec3; dir: Vec3 }, pl: Placement, fit: SceneFit): { origin: Vec3; dir: Vec3 } {
  return { origin: worldToScene(ray.origin, pl, fit), dir: worldDirToScene(ray.dir, pl) };
}

/** Where a scene point is in the room (same as `sceneToWorld`, re-exported so callers of this file need one import). */
export const sceneToRoom = sceneToWorld;

/** Distance along a ray (unit direction) to the first point of a sphere it touches, or null when it misses (or the sphere is behind). */
export function raySphere(origin: Vec3, dir: Vec3, centre: Vec3, radius: number): number | null {
  const oc = sub(origin, centre);
  const b = dot(oc, dir);
  const c = dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t1 < 0) return null;
  return Math.max(0, t0);
}

/**
 * The sphere a ray enters first (the nearest along the ray). Generous spheres overlap, and then the one in front wins.
 */
export function pickSphere<T extends { centre: Vec3; radius: number }>(origin: Vec3, dir: Vec3, items: readonly T[]): T | null {
  let best: T | null = null;
  let bestT = Infinity;
  for (const it of items) {
    const t = raySphere(origin, dir, it.centre, it.radius);
    if (t === null) continue;
    if (t < bestT) {
      bestT = t;
      best = it;
    }
  }
  return best;
}
