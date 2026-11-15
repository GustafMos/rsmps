/**
 * Passing regions to shaders. Boxes ride in a small rgba16float data texture; half floats alone would
 * give ~1 px error on a 4K frame, so every value is stored as hi + lo (two half floats = ~22 bits).
 *
 * Layout (one column per region): row 0 = box hi, row 1 = box lo, rows 2.. = caller extras (plain halves).
 * WGSL access (texture must be bound under the name `regs`): `regBox(i)` → vec4f box (x0,y0,x1,y1),
 * `regExtra(i, r)` → extra row r.
 */
import type { NodeGpu } from '../types';
import type { Box } from './track-core';

export const MAX_REGIONS = 64;

/** Round to the nearest half-precision float. */
export function roundHalf(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const e = Math.max(Math.floor(Math.log2(Math.abs(x))), -14);
  const step = Math.pow(2, e - 10);
  return Math.round(x / step) * step;
}

export function regionTable(gpu: NodeGpu, boxes: Box[], extras: number[][][] = [], cap = MAX_REGIONS): { texture: GPUTexture } {
  const n = Math.max(1, Math.min(cap, boxes.length));
  const rows = 2 + extras.length;
  const data = new Float32Array(n * rows * 4);
  for (let i = 0; i < Math.min(n, boxes.length); i++) {
    for (let k = 0; k < 4; k++) {
      const v = boxes[i][k];
      const hi = roundHalf(v);
      data[(0 * n + i) * 4 + k] = hi;
      data[(1 * n + i) * 4 + k] = roundHalf(v - hi);
    }
    extras.forEach((row, r) => {
      const vals = row[i] ?? [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) data[((2 + r) * n + i) * 4 + k] = vals[k] ?? 0;
    });
  }
  return gpu.dataTexture(data, n, rows);
}

export const REGION_WGSL = /* wgsl */ `
fn regBox(i: i32) -> vec4f { return textureLoad(regs, vec2i(i, 0), 0) + textureLoad(regs, vec2i(i, 1), 0); }
fn regExtra(i: i32, r: i32) -> vec4f { return textureLoad(regs, vec2i(i, 2 + r), 0); }
fn sdBox(p: vec2f, hs: vec2f) -> f32 {
  let q = abs(p) - hs;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}
fn sdRoundBox(p: vec2f, hs: vec2f, r: f32) -> f32 {
  let rr = min(r, min(hs.x, hs.y));
  return sdBox(p, hs - vec2f(rr)) - rr;
}
fn sdEllipse(p: vec2f, r: vec2f) -> f32 {
  let rr = max(r, vec2f(0.5));
  let k0 = length(p / rr);
  let k1 = length(p / (rr * rr));
  if (k1 < 1e-6) { return -min(rr.x, rr.y); }
  return k0 * (k0 - 1.0) / k1;
}
fn cov(d: f32) -> f32 { return clamp(0.5 - d, 0.0, 1.0); }
fn over(top: vec4f, bottom: vec4f) -> vec4f { return top + bottom * (1.0 - top.a); }
`;
