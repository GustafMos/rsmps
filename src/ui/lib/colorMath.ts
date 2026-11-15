/** Colour maths for the pickers and the palette studio. All RGB is straight sRGB 0..1. */
export type RGB = [number, number, number];
export type HSV = [number, number, number]; // h 0..360, s 0..1, v 0..1

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function rgbToHsv([r, g, b]: RGB): HSV {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb([h, s, v]: HSV): RGB {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export function rgbToHsl(rgb: RGB): HSV {
  const [h, , v] = rgbToHsv(rgb);
  const min = Math.min(...rgb);
  const l = (v + min) / 2;
  const d = v - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, clamp01(s), l];
}

export function hslToRgb([h, s, l]: HSV): RGB {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb([h, v === 0 ? 0 : 2 * (1 - l / v), v]);
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055);

export function rgbToOklab([r, g, b]: RGB): [number, number, number] {
  const lr = toLin(r), lg = toLin(g), lb = toLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Unclamped conversion (values may leave 0..1 when out of gamut). */
export function oklabToRgbRaw([L, a, b]: [number, number, number]): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
const inGamut = (c: RGB) => c.every((v) => v >= -0.0005 && v <= 1.0005);
export function oklabToRgb(lab: [number, number, number]): RGB {
  const c = oklabToRgbRaw(lab);
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

export function rgbToOklch(rgb: RGB): [number, number, number] {
  const [L, a, b] = rgbToOklab(rgb);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.hypot(a, b), h];
}

/** OKLCH to sRGB; chroma is reduced until the colour fits the gamut. */
export function oklchToRgb(L: number, C: number, h: number): RGB {
  const rad = (h * Math.PI) / 180;
  let lo = 0;
  let hi = C;
  const at = (c: number) => oklabToRgbRaw([L, c * Math.cos(rad), c * Math.sin(rad)]);
  if (inGamut(at(C))) return oklabToRgb([L, C * Math.cos(rad), C * Math.sin(rad)]);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) lo = mid;
    else hi = mid;
  }
  const c = at(lo);
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/* ------------------------------ text formats ------------------------------ */

const h2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
export function toHex(rgb: readonly number[], alpha?: number): string {
  return `#${h2(rgb[0])}${h2(rgb[1])}${h2(rgb[2])}${alpha !== undefined && alpha < 1 ? h2(alpha) : ''}`.toUpperCase();
}

/** Accepts 3/4/6/8 hex digits, with or without '#'. */
export function parseHex(text: string): { rgb: RGB; a: number | null } | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { rgb: [n(0), n(2), n(4)], a: h.length === 8 ? n(6) : null };
}

/** Every hex colour in a blob of text (6-digit, # optional when the token is exactly 6 digits). */
export function findHexColors(text: string): RGB[] {
  const out: RGB[] = [];
  for (const m of text.matchAll(/(?:^|[^0-9a-z])#?([0-9a-f]{6})(?![0-9a-z])/gi)) {
    const p = parseHex(m[1]);
    if (p) out.push(p.rgb);
  }
  return out;
}

/* ------------------------------- accessibility ----------------------------- */

export function luminance([r, g, b]: RGB): number {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type CvdKind = 'protan' | 'deutan' | 'tritan';
const CVD: Record<CvdKind, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export function simulateCvd(rgb: RGB, kind: CvdKind): RGB {
  const lin = rgb.map(toLin);
  const m = CVD[kind];
  return m.map((row) => clamp01(toSrgb(clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])))) as RGB;
}
