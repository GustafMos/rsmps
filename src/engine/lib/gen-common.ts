/**
 * Shared helpers for the generator nodes (src/engine/nodes/generate).
 */
import type { NodeGpu } from '../types';

/** Colour stops → a tiny lookup texture (one texel per stop). Always at least two stops. */
export function genPaletteTexture(
  gpu: NodeGpu,
  colors: readonly (readonly number[])[] | null | undefined,
  fallback: readonly (readonly number[])[] = [
    [0, 0, 0],
    [1, 1, 1],
  ],
): { texture: { texture: GPUTexture }; count: number } {
  let list = colors && colors.length ? colors : fallback;
  if (list.length === 1) list = [list[0], list[0]];
  const data = new Float32Array(list.length * 4);
  list.forEach((c, i) => {
    data[i * 4] = c[0] ?? 0;
    data[i * 4 + 1] = c[1] ?? 0;
    data[i * 4 + 2] = c[2] ?? 0;
    data[i * 4 + 3] = 1;
  });
  return { texture: gpu.dataTexture(data, list.length, 1), count: list.length };
}

/** WGSL: `palAt(t)` samples evenly spaced stops from texture `pal` (uniform `u.palN` = stop count). sRGB in/out. */
export const GEN_PALETTE_WGSL = /* wgsl */ `
fn palAt(t: f32) -> vec3f {
  let n = i32(u.palN);
  let x = clamp(t, 0.0, 1.0) * f32(n - 1);
  let i = i32(floor(x));
  let j = min(i + 1, n - 1);
  return mix(textureLoad(pal, vec2i(i, 0), 0).rgb, textureLoad(pal, vec2i(j, 0), 0).rgb, x - f32(i));
}
fn palIndex(k: i32) -> vec3f {
  let n = i32(u.palN);
  return textureLoad(pal, vec2i(((k % n) + n) % n, 0), 0).rgb;
}
`;

/** WGSL: integer hash giving 4 well-mixed randoms in 0..1 from three integers (cell x, cell y, salt). */
export const GEN_HASH_WGSL = /* wgsl */ `
fn gpcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd4(a: i32, b: i32, c: i32) -> vec4f {
  let s = gpcg(bitcast<u32>(a) + gpcg(bitcast<u32>(b) + gpcg(bitcast<u32>(c))));
  let r0 = gpcg(s);
  let r1 = gpcg(r0 ^ 0x9e3779b9u);
  let r2 = gpcg(r1 ^ 0x85ebca6bu);
  let r3 = gpcg(r2 ^ 0xc2b2ae35u);
  return vec4f(f32(r0 >> 8u), f32(r1 >> 8u), f32(r2 >> 8u), f32(r3 >> 8u)) / 16777216.0;
}
`;

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Rotation matrix Rz * Ry * Rx (row-major) from degrees. */
export function rotationZYX(xDeg: number, yDeg: number, zDeg: number): Mat3 {
  const [ax, ay, az] = [xDeg, yDeg, zDeg].map((d) => (d * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const mul = (a: number[], b: number[]): number[] => {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return r;
  };
  const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul(rz, mul(ry, rx)) as Mat3;
}

/** `[r,g,b,a]` straight colour → premultiplied-ready vec4 array (just a copy; shaders premul themselves). */
export function rgba(c: readonly number[]): [number, number, number, number] {
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1];
}
