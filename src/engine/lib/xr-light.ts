/**
 * The light of the room from the browser's AR light estimation (WebXR `light-estimation`), pure.
 *
 * What the browser reports (XRLightEstimate): `primaryLightDirection` (a vector pointing TOWARD the main light, in the AR reference
 * space: metres, x right, y up, the viewer looks along -z), `primaryLightIntensity` (red, green, blue of that light) and
 * `sphericalHarmonicsCoefficients` (27 numbers: 9 red-green-blue triples; the first triple is the average brightness of the
 * whole sky, which is the ambient light).
 *
 * The 3D nodes light their object with an azimuth and a height (gen-3d.ts `lightVector`): azimuth 0 = from the camera's side of the
 * object (scene -z), positive = towards +x (the right); height 90 = straight above. That frame is the scene's, the placed object's own
 * frame (its up is the surface normal, turned by the twist), so a light in the room is converted with the placement's orientation.
 *
 * Which numbers a real phone reports (how bright "1" is, whether the sky average is on the same scale as the main light) is only
 * known from a device; the mapping below is a sensible default and is checked by hand on the phone (see the AR view's "light" line).
 */
import { qConj, qNorm, rotate, type Quat, type Vec3 } from './motion-math';

/** One reading of the room's light, in AR axes. */
export interface WorldLight {
  /** Unit vector toward the main light (AR reference space). */
  dir: Vec3;
  /** Brightness of the main light, 1 = about as bright as the lamp the 3D nodes assume. */
  strength: number;
  /** Share of the light that comes from everywhere, 0..1 (the node's "Ambient light"). */
  ambient: number;
  /** Colour of the ambient light, normalised so its brightest channel is 1. */
  ambientColor: [number, number, number];
}

/** The estimate as the browser hands it over (`DOMPointReadOnly` members, `Float32Array`). */
export interface XrLightEstimateLike {
  primaryLightDirection?: { x: number; y: number; z: number } | null;
  primaryLightIntensity?: { x: number; y: number; z: number } | null;
  sphericalHarmonicsCoefficients?: ArrayLike<number> | null;
}

const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const finite = (...v: number[]): boolean => v.every((x) => Number.isFinite(x));

/** A reading from the browser's estimate, or null when it holds no usable main light. */
export function readLightEstimate(e: XrLightEstimateLike | null | undefined): WorldLight | null {
  const d = e?.primaryLightDirection;
  if (!e || !d || !finite(d.x, d.y, d.z)) return null;
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-6) return null;
  const i = e.primaryLightIntensity;
  const direct = i && finite(i.x, i.y, i.z) ? Math.max(0, lum(i.x, i.y, i.z)) : 1;
  const sh = e.sphericalHarmonicsCoefficients;
  let ambient = 0.35;
  let colour: [number, number, number] = [1, 1, 1];
  if (sh && sh.length >= 27 && finite(sh[0], sh[1], sh[2])) {
    // the average radiance of the sky is the first coefficient times 0.282; a surface under it receives pi times that
    const k = Math.PI * 0.282095;
    const a: [number, number, number] = [Math.max(0, sh[0] * k), Math.max(0, sh[1] * k), Math.max(0, sh[2] * k)];
    const al = lum(a[0], a[1], a[2]);
    ambient = direct + al > 1e-6 ? al / (direct + al) : 0.35;
    const m = Math.max(a[0], a[1], a[2], 1e-6);
    colour = [a[0] / m, a[1] / m, a[2] / m];
  }
  return {
    dir: [d.x / len, d.y / len, d.z / len],
    strength: Math.min(4, Math.max(0, direct)),
    ambient: Math.min(0.9, Math.max(0.05, ambient)),
    ambientColor: colour,
  };
}

/**
 * Smooth a stream of readings: the estimate jitters from frame to frame. Exponential with time constant `tau` seconds (a frame `dt` long
 * moves `1 - exp(-dt / tau)` of the way); the direction is blended as a vector and renormalised. `next` null = no estimate this frame:
 * the last value is held.
 */
export function smoothLight(prev: WorldLight | null, next: WorldLight | null, dt: number, tau = 0.35): WorldLight | null {
  if (!next) return prev;
  if (!prev) return next;
  const k = 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-3, tau));
  const mix = (a: number, b: number): number => a + (b - a) * k;
  const dir: Vec3 = [mix(prev.dir[0], next.dir[0]), mix(prev.dir[1], next.dir[1]), mix(prev.dir[2], next.dir[2])];
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  return {
    dir: l > 1e-6 ? [dir[0] / l, dir[1] / l, dir[2] / l] : prev.dir,
    strength: mix(prev.strength, next.strength),
    ambient: mix(prev.ambient, next.ambient),
    ambientColor: [mix(prev.ambientColor[0], next.ambientColor[0]), mix(prev.ambientColor[1], next.ambientColor[1]), mix(prev.ambientColor[2], next.ambientColor[2])],
  };
}

/** What the 3D nodes' Light azimuth / Light height / Ambient light say for a light of the room, seen from an object placed with `object` (full orientation). */
export function lightForScene(light: WorldLight, objectQ: Quat): { azimuth: number; elevation: number; ambient: number; strength: number } {
  const local = rotate(qConj(qNorm(objectQ)), light.dir);
  // AR axes to scene axes: flip z
  const x = local[0];
  const y = local[1];
  const z = -local[2];
  const elevation = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  // azimuth 0 = light at scene -z (from the side the default camera looks from), positive towards +x
  const azimuth = Math.hypot(x, z) < 1e-6 ? 0 : (Math.atan2(x, -z) * 180) / Math.PI;
  return { azimuth, elevation, ambient: light.ambient, strength: light.strength };
}
