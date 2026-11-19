/**
 * Camera and film movement shared by Camera Shake and Gate Weave: a position, tilt and zoom for a moment in time, and the
 * shader that draws the picture there.
 */

/** Where the picture sits: x and y as a share of the width (y too, so a number means the same distance both ways), tilt in radians, zoom. */
export interface Pose {
  x: number;
  y: number;
  rot: number;
  zoom: number;
}

export const REST: Pose = { x: 0, y: 0, rot: 0, zoom: 1 };

/** A repeatable number 0..1 from two numbers. */
export function hash2(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Smooth wandering between -1 and 1: a sum of sines an octave-and-a-bit apart, each `rough` times the one below.
 * `hz` is the speed of the slowest one. With `loop` (seconds) every sine makes a whole number of turns in that time,
 * so the movement at the end of the loop joins its start.
 */
export function wander(t: number, hz: number, rough: number, seed: number, loop = 0): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let f = hz;
  for (let i = 0; i < 5; i++) {
    let freq = f * (0.85 + 0.3 * hash2(seed, i + 0.5));
    if (loop > 0) freq = Math.max(1, Math.round(freq * loop)) / loop;
    sum += amp * Math.sin(2 * Math.PI * (freq * t + hash2(seed + 3.3, i)));
    norm += amp;
    amp *= rough;
    f *= 1.93;
  }
  return norm > 0 ? sum / norm : 0;
}

/** The zoom that keeps the edges of the picture out of sight for movement up to `x`, `y` (shares of the width) and tilt `rot`. */
export function coverZoom(x: number, y: number, rot: number, aspect: number): number {
  const a = Math.abs(rot);
  // a tilted frame needs room for its corners: the wider the picture, the more
  const tilt = Math.cos(a) + Math.sin(a) * Math.max(aspect, 1 / aspect);
  return tilt * (1 + 2 * Math.max(Math.abs(x), Math.abs(y) * aspect));
}

export const SHAKE_EDGES = [
  { value: 'fill', label: 'Zoom in to fill' },
  { value: 'mirror', label: 'Mirror the edge' },
  { value: 'repeat', label: 'Repeat the edge' },
  { value: 'clear', label: 'Transparent' },
];
export const shakeEdgeIndex = (edge: unknown): number => (edge === 'clear' ? 0 : edge === 'mirror' ? 2 : 1);

/** Uniform value for a pose: x, y, tilt, zoom. */
export const poseVec = (p: Pose, extraZoom = 1): number[] => [p.x, p.y, p.rot, p.zoom * extraZoom];

/**
 * WGSL: `shakeSample(uv, pose)` reads `src` as it looks moved to a pose (vec4: x, y, tilt, zoom; x and y in shares of the
 * width). Needs `u.edge` (0 transparent, 1 repeat the edge, 2 mirror).
 */
export const SHAKE_WGSL = /* wgsl */ `
fn shakeUv(uv: vec2f, pose: vec4f) -> vec2f {
  var p = (uv - 0.5) * u.size / pose.w;
  let c = cos(pose.z);
  let s = sin(pose.z);
  p = vec2f(p.x * c + p.y * s, -p.x * s + p.y * c);
  return p / u.size + 0.5 - vec2f(pose.x, pose.y * u.size.x / u.size.y);
}
fn shakeSample(uv: vec2f, pose: vec4f) -> vec4f {
  var st = shakeUv(uv, pose);
  if (u.edge < 0.5) {
    let e = min(min(st.x, 1.0 - st.x) * u.size.x, min(st.y, 1.0 - st.y) * u.size.y);
    if (e <= -0.5) { return vec4f(0.0); }
    return textureSampleLevel(src, smp, clamp(st, vec2f(0.0), vec2f(1.0)), 0.0) * clamp(e + 0.5, 0.0, 1.0);
  }
  if (u.edge > 1.5) { st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0); }
  return textureSampleLevel(src, smp, clamp(st, vec2f(0.0), vec2f(1.0)), 0.0);
}`;
