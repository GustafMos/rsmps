/** Test fixtures for Stabilize: a continuous textured scene that can be drawn under any similarity transform. */
import { applySim, invert, type Grey, type Sim } from './stabilize';

/** A continuous textured "scene": value noise at three scales, defined for any (x, y) in normalised units, so it can be rendered under any transform. */
function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
export const scene = (x: number, y: number, seed = 1): number =>
  255 * (0.5 * noise(x * 14, y * 14, seed) + 0.3 * noise(x * 31 + 7, y * 31 + 3, seed + 1) + 0.2 * noise(x * 60 + 1, y * 60 + 9, seed + 2));

/** The picture of the scene when the scene point s appears at T(s). `extra` adds things (a moving blob). */
export function render(w: number, h: number, t: Sim, seed = 1, extra?: (x: number, y: number, v: number) => number): Grey {
  const inv = invert(t);
  const L = Math.max(w, h);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = (x + 0.5 - w / 2) / L;
      const qy = (y + 0.5 - h / 2) / L;
      const [sx, sy] = applySim(inv, qx, qy);
      let v = scene(sx, sy, seed);
      if (extra) v = extra(qx, qy, v);
      d[y * w + x] = v;
    }
  }
  return { w, h, d };
}
