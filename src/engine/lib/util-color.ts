import type { ColorValue } from '../types';

type V3 = [number, number, number];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((Math.max(c, 0) + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

function linearToOklab([r, g, b]: V3): V3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear([L, a, b]: V3): V3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

export type MixSpace = 'srgb' | 'linear' | 'oklab';

/** Mix two straight sRGB colours (0..1) with factor k in the chosen colour space. Alpha is mixed linearly. */
export function mixColors(a: ColorValue, b: ColorValue, k: number, space: MixSpace): ColorValue {
  const alpha = a[3] + (b[3] - a[3]) * k;
  const lerp = (x: number, y: number) => x + (y - x) * k;
  if (space === 'srgb') return [lerp(a[0], b[0]), lerp(a[1], b[1]), lerp(a[2], b[2]), alpha];
  const la: V3 = [srgbToLinear(a[0]), srgbToLinear(a[1]), srgbToLinear(a[2])];
  const lb: V3 = [srgbToLinear(b[0]), srgbToLinear(b[1]), srgbToLinear(b[2])];
  if (space === 'linear') return [linearToSrgb(lerp(la[0], lb[0])), linearToSrgb(lerp(la[1], lb[1])), linearToSrgb(lerp(la[2], lb[2])), alpha];
  const oa = linearToOklab(la);
  const ob = linearToOklab(lb);
  const lin = oklabToLinear([lerp(oa[0], ob[0]), lerp(oa[1], ob[1]), lerp(oa[2], ob[2])]);
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  return [clamp01(linearToSrgb(lin[0])), clamp01(linearToSrgb(lin[1])), clamp01(linearToSrgb(lin[2])), alpha];
}
