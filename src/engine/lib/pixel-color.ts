/** CPU colour helpers shared by the pixel-art nodes. Colours are [r, g, b] in 0..1 sRGB unless noted. */

export type Rgb = [number, number, number];
export type DitherSpace = 'oklab' | 'linear' | 'srgb';

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Rgb): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((Math.max(v, 0) + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
}

/** sRGB (0..1) → OKLab [L, a, b]. Same matrices as the WGSL prelude. */
export function srgbToOklab(c: Rgb): Rgb {
  const r = srgbToLinear(c[0]);
  const g = srgbToLinear(c[1]);
  const b = srgbToLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToSrgb(c: Rgb): Rgb {
  const l_ = c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2];
  const m_ = c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2];
  const s_ = c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2];
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lin: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
}

/** Colour in the space the matcher works in. */
export function toSpace(c: Rgb, space: DitherSpace): Rgb {
  if (space === 'oklab') return srgbToOklab(c);
  if (space === 'linear') return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
  return c;
}

/** Per-axis distance weights (must match the WGSL `spaceDist` in pixel-gpu.ts). */
export function spaceWeights(space: DitherSpace): Rgb {
  if (space === 'oklab') return [1, 1.6, 1.6];
  if (space === 'linear') return [0.3, 0.59, 0.11];
  return [0.3, 0.59, 0.11];
}

export function nearestIndex(c: Rgb, paletteInSpace: Rgb[], space: DitherSpace): number {
  const w = spaceWeights(space);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < paletteInSpace.length; i++) {
    const p = paletteInSpace[i];
    const d = w[0] * (c[0] - p[0]) ** 2 + w[1] * (c[1] - p[1]) ** 2 + w[2] * (c[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
