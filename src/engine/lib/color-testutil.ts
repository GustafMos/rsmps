/** Test helpers for the grading nodes: a colour chart (hue sweep, grey ramp, skin and scene patches) and small colour utilities. Tests only. */
import type { Harness } from '../testing';
import type { ImageValue } from '../types';
import { type V3, linearToOklab, luma709, srgbToLinear } from './color-math';

export const CHART_W = 384;
export const CHART_H = 240;

/** Skin-ish sRGB patches (light to dark, plus rosy and olive). */
export const SKIN_PATCHES: V3[] = [
  [0.96, 0.8, 0.69],
  [0.87, 0.69, 0.58],
  [0.78, 0.57, 0.44],
  [0.65, 0.46, 0.33],
  [0.55, 0.36, 0.26],
  [0.36, 0.22, 0.16],
  [0.9, 0.68, 0.62],
  [0.76, 0.6, 0.42],
];
/** Scene colours: sea, sky, foliage, red, yellow, magenta, deep shadow, bright highlight. */
export const SCENE_PATCHES: V3[] = [
  [0.08, 0.35, 0.67],
  [0.43, 0.63, 0.86],
  [0.24, 0.47, 0.2],
  [0.85, 0.12, 0.1],
  [0.95, 0.85, 0.15],
  [0.8, 0.2, 0.7],
  [0.12, 0.1, 0.16],
  [0.94, 0.92, 0.88],
];

function hsv(h: number, s: number, v: number): V3 {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export function chartPixel(x: number, y: number): [number, number, number, number] {
  let c: V3;
  const h = x / CHART_W;
  if (y < 80) c = hsv(h, 1, 0.9);
  else if (y < 120) c = hsv(h, 0.45, 0.8);
  else if (y < 160) {
    const g = x / (CHART_W - 1);
    c = [g, g, g];
  } else if (y < 200) c = SKIN_PATCHES[Math.floor((x * 8) / CHART_W)];
  else c = SCENE_PATCHES[Math.floor((x * 8) / CHART_W)];
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255];
}
export function makeChart(t: Harness): ImageValue {
  return t.fromFn(CHART_W, CHART_H, chartPixel);
}
/** Centre of patch `i` (0..7) in the skin row (row 0) or the scene row (row 1). */
export const patchXY = (i: number, row: 0 | 1): [number, number] => [Math.floor(((i + 0.5) * CHART_W) / 8), row === 0 ? 180 : 220];

export const to01 = (p: ArrayLike<number>): V3 => [p[0] / 255, p[1] / 255, p[2] / 255];
export const lightness = (p: ArrayLike<number>): number => linearToOklab(srgbToLinear(to01(p)))[0];
export const linY = (p: ArrayLike<number>): number => luma709(srgbToLinear(to01(p)));
export const chroma = (p: ArrayLike<number>): number => {
  const l = linearToOklab(srgbToLinear(to01(p)));
  return Math.hypot(l[1], l[2]);
};
/** Largest absolute channel difference (0..255) between two straight RGBA buffers (alpha ignored). */
export function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[i + c] - b[i + c]));
  return m;
}
