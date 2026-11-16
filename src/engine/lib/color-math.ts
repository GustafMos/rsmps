/**
 * Colour grading maths: the ONE TypeScript source of every constant and formula the grading nodes use.
 *
 *  - `color-wgsl.ts` generates its WGSL from the constants in this file (no number is typed twice), and
 *  - the tests use the plain functions here as the reference the GPU result is compared with.
 *
 * Everything is pure (no GPU, no DOM). Images in the engine are sRGB-encoded 8-bit, so "linear light" always means
 * the sRGB transfer function removed, Rec.709 / sRGB primaries, D65 white.
 *
 * Sources (so the formulas can be audited):
 *  - sRGB IEC 61966-2-1 transfer; Rec.709 luma 0.2126 / 0.7152 / 0.0722 (ITU-R BT.709, also ASC CDL saturation).
 *  - Primaries and D65 white: ITU-R BT.709, SMPTE EG 432-1 (Display P3), ITU-R BT.2020. Matrices are DERIVED from the
 *    chromaticities (no hand-typed matrices).
 *  - OKLab: Bjorn Ottosson, 2020 (the matrices of linear sRGB <-> LMS <-> Lab).
 *  - Chromatic adaptation: Bradford (Lam 1985) and CAT16 (Li et al. 2017) cone matrices, von Kries scaling in cone space.
 *  - Illuminant chromaticity: Planckian locus approximation of Kim et al. (2002, 1667-25000 K) and the CIE daylight locus
 *    (CIE 15, 4000-25000 K), blended between 4000 and 5000 K. Tint is Duv: an offset in CIE 1960 UCS perpendicular to the locus.
 *  - Log curves: Cineon (Kodak), Sony S-Log3, ARRI LogC3 (EI 800), Panasonic V-Log, ACEScct (S-2016-001), DaVinci Intermediate
 *    (Blackmagic whitepaper). Each one is checked in color-math.test.ts for continuity at its break point and for its published
 *    18% grey code value.
 */
import { evalCurve } from './util-curve';
import type { CurveValue } from '../types';

export type V3 = [number, number, number];
/** 3x3 matrix, row-major. */
export type M3 = [number, number, number, number, number, number, number, number, number];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ----------------------------------------------------------------------- */
/* Matrices                                                                 */
/* ----------------------------------------------------------------------- */

export const IDENTITY3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMM(a: M3, b: M3): M3 {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o as M3;
}
export function mulMV(m: M3, v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export function invM3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error('invM3: singular matrix');
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}
export function lerpM3(a: M3, b: M3, t: number): M3 {
  return a.map((v, i) => v + (b[i] - v) * t) as M3;
}
/** The rows of a matrix as three vec3 uniforms. */
export function rows(m: M3): [V3, V3, V3] {
  return [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
}

/* ----------------------------------------------------------------------- */
/* Primaries, white and colour spaces                                       */
/* ----------------------------------------------------------------------- */

export type XY = [number, number];
export interface Primaries {
  r: XY;
  g: XY;
  b: XY;
}
/** D65 white point (CIE xy). */
export const D65: XY = [0.3127, 0.329];
export const PRIMARIES = {
  rec709: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06] },
  p3: { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
  rec2020: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046] },
} as const satisfies Record<string, Primaries>;
export type PrimariesId = keyof typeof PRIMARIES;

export function xyToXYZ([x, y]: XY): V3 {
  return [x / y, 1, (1 - x - y) / y];
}

/** Linear RGB -> CIE XYZ for the given primaries and white (Y of white = 1). */
export function rgbToXyzMatrix(p: Primaries, white: XY): M3 {
  const r = xyToXYZ(p.r);
  const g = xyToXYZ(p.g);
  const b = xyToXYZ(p.b);
  const prim: M3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = mulMV(invM3(prim), xyToXYZ(white));
  return [r[0] * s[0], g[0] * s[1], b[0] * s[2], r[1] * s[0], g[1] * s[1], b[1] * s[2], r[2] * s[0], g[2] * s[1], b[2] * s[2]];
}

export const RGB_TO_XYZ: Record<PrimariesId, M3> = {
  rec709: rgbToXyzMatrix(PRIMARIES.rec709, D65),
  p3: rgbToXyzMatrix(PRIMARIES.p3, D65),
  rec2020: rgbToXyzMatrix(PRIMARIES.rec2020, D65),
};
export const XYZ_TO_SRGB: M3 = invM3(RGB_TO_XYZ.rec709);

/** Matrix taking linear RGB of primaries `from` to linear RGB of primaries `to` (both D65, so no adaptation is needed). */
export function primariesMatrix(from: PrimariesId, to: PrimariesId): M3 {
  return mulMM(invM3(RGB_TO_XYZ[to]), RGB_TO_XYZ[from]);
}

/** Rec.709 luma coefficients (BT.709, ASC CDL saturation, the engine's `luma()`). */
export const REC709_LUMA: V3 = [0.2126, 0.7152, 0.0722];
export const luma709 = (c: V3): number => c[0] * REC709_LUMA[0] + c[1] * REC709_LUMA[1] + c[2] * REC709_LUMA[2];

/* ----------------------------------------------------------------------- */
/* Transfer functions                                                       */
/* ----------------------------------------------------------------------- */

/** Order = the numeric id used by the shaders. NEVER reorder (ids are passed to the GPU). */
export const TRANSFER_IDS = ['srgb', 'linear', 'gamma22', 'gamma24', 'cineon', 'slog3', 'logc3', 'vlog', 'acescct', 'davinci'] as const;
export type TransferId = (typeof TRANSFER_IDS)[number];
export const transferIndex = (id: TransferId): number => TRANSFER_IDS.indexOf(id);

/** Published constants of the log curves (see the file header for the sources). */
export const TF = {
  srgb: { a: 0.055, cutEnc: 0.04045, cutLin: 0.0031308, slope: 12.92 },
  cineon: { refWhite: 685, refBlack: 95, density: 0.002, gamma: 0.6, codes: 1023 },
  slog3: { cut: 0.01125, mid: 0.18, off: 0.01, a: 420, b: 261.5, c: 95, d: 171.2102946929, codes: 1023 },
  logc3: { cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 },
  vlog: { cut: 0.01, linA: 5.6, linB: 0.125, b: 0.00873, c: 0.241514, d: 0.598206, cutEnc: 0.181 },
  acescct: { cut: 0.0078125, a: 10.5402377416545, b: 0.0729055341958355, c: 17.52, d: 9.72 },
  davinci: { a: 0.0075, b: 7.0, c: 0.07329248, m: 10.44426855, linCut: 0.00262409, logCut: 0.02740668 },
} as const;

export const CINEON_OFFSET = Math.pow(10, ((TF.cineon.refBlack - TF.cineon.refWhite) * TF.cineon.density) / TF.cineon.gamma);
const log10 = (x: number) => Math.log10(Math.max(x, 1e-12));
const pos = (x: number) => Math.max(x, 0);

/** Encoded value -> linear light, for one channel. */
export function tfDecode(id: TransferId, v: number): number {
  switch (id) {
    case 'srgb':
      return v <= TF.srgb.cutEnc ? v / TF.srgb.slope : Math.pow((pos(v) + TF.srgb.a) / (1 + TF.srgb.a), 2.4);
    case 'linear':
      return v;
    case 'gamma22':
      return Math.pow(pos(v), 2.2);
    case 'gamma24':
      return Math.pow(pos(v), 2.4);
    case 'cineon': {
      const c = TF.cineon;
      const code = v * c.codes;
      return (Math.pow(10, ((code - c.refWhite) * c.density) / c.gamma) - CINEON_OFFSET) / (1 - CINEON_OFFSET);
    }
    case 'slog3': {
      const c = TF.slog3;
      if (v >= c.d / c.codes) return Math.pow(10, (v * c.codes - c.a) / c.b) * (c.mid + c.off) - c.off;
      return ((v * c.codes - c.c) * c.cut) / (c.d - c.c);
    }
    case 'logc3': {
      const c = TF.logc3;
      if (v > c.e * c.cut + c.f) return (Math.pow(10, (v - c.d) / c.c) - c.b) / c.a;
      return (v - c.f) / c.e;
    }
    case 'vlog': {
      const c = TF.vlog;
      if (v < c.cutEnc) return (v - c.linB) / c.linA;
      return Math.pow(10, (v - c.d) / c.c) - c.b;
    }
    case 'acescct': {
      const c = TF.acescct;
      if (v <= c.a * c.cut + c.b) return (v - c.b) / c.a;
      return Math.pow(2, v * c.c - c.d);
    }
    case 'davinci': {
      const c = TF.davinci;
      if (v <= c.logCut) return v / c.m;
      return Math.pow(2, v / c.c - c.b) - c.a;
    }
  }
}

/** Linear light -> encoded value, for one channel. */
export function tfEncode(id: TransferId, l: number): number {
  switch (id) {
    case 'srgb':
      return l <= TF.srgb.cutLin ? l * TF.srgb.slope : (1 + TF.srgb.a) * Math.pow(pos(l), 1 / 2.4) - TF.srgb.a;
    case 'linear':
      return l;
    case 'gamma22':
      return Math.pow(pos(l), 1 / 2.2);
    case 'gamma24':
      return Math.pow(pos(l), 1 / 2.4);
    case 'cineon': {
      const c = TF.cineon;
      const code = c.refWhite + (log10(l * (1 - CINEON_OFFSET) + CINEON_OFFSET) * c.gamma) / c.density;
      return code / c.codes;
    }
    case 'slog3': {
      const c = TF.slog3;
      if (l >= c.cut) return (c.a + log10((l + c.off) / (c.mid + c.off)) * c.b) / c.codes;
      return ((l * (c.d - c.c)) / c.cut + c.c) / c.codes;
    }
    case 'logc3': {
      const c = TF.logc3;
      if (l > c.cut) return c.c * log10(c.a * l + c.b) + c.d;
      return c.e * l + c.f;
    }
    case 'vlog': {
      const c = TF.vlog;
      if (l < c.cut) return c.linA * l + c.linB;
      return c.c * log10(l + c.b) + c.d;
    }
    case 'acescct': {
      const c = TF.acescct;
      if (l <= c.cut) return c.a * l + c.b;
      return (Math.log2(l) + c.d) / c.c;
    }
    case 'davinci': {
      const c = TF.davinci;
      if (l <= c.linCut) return l * c.m;
      return (Math.log2(l + c.a) + c.b) * c.c;
    }
  }
}

/** Break points where each log curve switches formula, as linear values (for continuity tests). */
export const TF_BREAKS: Partial<Record<TransferId, number>> = {
  slog3: TF.slog3.cut,
  logc3: TF.logc3.cut,
  vlog: TF.vlog.cut,
  acescct: TF.acescct.cut,
  davinci: TF.davinci.linCut,
  srgb: TF.srgb.cutLin,
};

/** Colour spaces offered by the Colour Space and LUT nodes. Log curves carry Rec.709/sRGB primaries (camera gamuts are NOT applied). */
export interface SpaceDef {
  id: string;
  label: string;
  primaries: PrimariesId;
  transfer: TransferId;
}
export const SPACES: readonly SpaceDef[] = [
  { id: 'srgb', label: 'sRGB', primaries: 'rec709', transfer: 'srgb' },
  { id: 'linear', label: 'Linear sRGB', primaries: 'rec709', transfer: 'linear' },
  { id: 'gamma22', label: 'Gamma 2.2', primaries: 'rec709', transfer: 'gamma22' },
  { id: 'rec709-g24', label: 'Rec.709 gamma 2.4', primaries: 'rec709', transfer: 'gamma24' },
  { id: 'p3', label: 'Display P3', primaries: 'p3', transfer: 'srgb' },
  { id: 'p3-linear', label: 'Linear P3', primaries: 'p3', transfer: 'linear' },
  { id: 'p3-g26', label: 'P3 D65 gamma 2.4', primaries: 'p3', transfer: 'gamma24' },
  { id: 'rec2020-linear', label: 'Linear Rec.2020', primaries: 'rec2020', transfer: 'linear' },
  { id: 'rec2020-g24', label: 'Rec.2020 gamma 2.4', primaries: 'rec2020', transfer: 'gamma24' },
  { id: 'cineon', label: 'Cineon log', primaries: 'rec709', transfer: 'cineon' },
  { id: 'slog3', label: 'Sony S-Log3', primaries: 'rec709', transfer: 'slog3' },
  { id: 'logc3', label: 'ARRI LogC3', primaries: 'rec709', transfer: 'logc3' },
  { id: 'vlog', label: 'Panasonic V-Log', primaries: 'rec709', transfer: 'vlog' },
  { id: 'acescct', label: 'ACEScct', primaries: 'rec709', transfer: 'acescct' },
  { id: 'davinci', label: 'DaVinci Intermediate', primaries: 'rec709', transfer: 'davinci' },
];
export const spaceDef = (id: string): SpaceDef => SPACES.find((s) => s.id === id) ?? SPACES[0];
export const SPACE_OPTIONS = SPACES.map((s) => ({ value: s.id, label: s.label }));

/** Convert an encoded colour from one space to another (float, no clamping). */
export function convertSpace(c: V3, from: string, to: string): V3 {
  const a = spaceDef(from);
  const b = spaceDef(to);
  const lin: V3 = [tfDecode(a.transfer, c[0]), tfDecode(a.transfer, c[1]), tfDecode(a.transfer, c[2])];
  const m = mulMV(primariesMatrix(a.primaries, b.primaries), lin);
  return [tfEncode(b.transfer, m[0]), tfEncode(b.transfer, m[1]), tfEncode(b.transfer, m[2])];
}

/* sRGB convenience (the engine's pixel format) */
export const srgbToLinear = (c: V3): V3 => [tfDecode('srgb', c[0]), tfDecode('srgb', c[1]), tfDecode('srgb', c[2])];
export const linearToSrgb = (c: V3): V3 => [tfEncode('srgb', c[0]), tfEncode('srgb', c[1]), tfEncode('srgb', c[2])];

/* ----------------------------------------------------------------------- */
/* OKLab                                                                    */
/* ----------------------------------------------------------------------- */

export const OKLAB = {
  toLms: [0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566, 0.0883024619, 0.2817188376, 0.6299787005] as M3,
  lmsToLab: [0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099, 0.0259040371, 0.7827717662, -0.808675766] as M3,
  labToLms: [1, 0.3963377774, 0.2158037573, 1, -0.1055613458, -0.0638541728, 1, -0.0894841775, -1.291485548] as M3,
  lmsToRgb: [4.0767416621, -3.3077115913, 0.2309699292, -1.2684380046, 2.6097574011, -0.3413193965, -0.0041960863, -0.7034186147, 1.707614701] as M3,
};
export function linearToOklab(c: V3): V3 {
  const lms = mulMV(OKLAB.toLms, c).map(Math.cbrt) as V3;
  return mulMV(OKLAB.lmsToLab, lms);
}
export function oklabToLinear(c: V3): V3 {
  const lms = mulMV(OKLAB.labToLms, c).map((v) => v * v * v) as V3;
  return mulMV(OKLAB.lmsToRgb, lms);
}
/** Chroma at which the strongest sRGB primary sits (used to normalise "how saturated is this colour"). */
export const OKLAB_CHROMA_REF = 0.32;

const inGamut = (c: V3) => c.every((v) => v >= -0.0005 && v <= 1.0005);

/**
 * Colour at lightness L with chroma vector (a, b), pulled toward the grey of the same lightness (chroma reduced, never clipped)
 * until it fits the sRGB gamut. Returns linear sRGB. Reference of `cg_gamutLC` in color-wgsl.ts.
 */
export function oklabToLinearMapped(L: number, a: number, b: number): V3 {
  const Lc = clamp(L, 0, 1);
  const direct = oklabToLinear([Lc, a, b]);
  if (inGamut(direct)) return direct;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < GAMUT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear([Lc, a * mid, b * mid]))) lo = mid;
    else hi = mid;
  }
  return oklabToLinear([Lc, a * lo, b * lo]);
}
export const GAMUT_ITERATIONS = 14;

/* ----------------------------------------------------------------------- */
/* Saturation                                                               */
/* ----------------------------------------------------------------------- */

export type SaturationMode = 'oklab' | 'linear' | 'hsl';
/** OKLCh hue (turns, 0..1) around which skin tones sit, and the half-width of the protected band. Centre = mean OKLCh hue (about 52 degrees) of light to dark skin sRGB patches, which sit between 36 and 70 degrees. */
export const SKIN = { hue: 0.145, width: 0.05, falloff: 0.04 };
export function skinWeight(hueTurns: number): number {
  let d = Math.abs(hueTurns - SKIN.hue);
  d = Math.min(d, 1 - d);
  return 1 - smoothstep(SKIN.width, SKIN.width + SKIN.falloff, d);
}

export interface SaturationOpts {
  mode: SaturationMode;
  saturation: number;
  vibrance: number;
  protectSkin: number;
  shadowRolloff: number;
  highlightRolloff: number;
}
/** Chroma multiplier after vibrance, skin protection and the shadow/highlight roll-off. Reference of `cg_satGain`. */
export function saturationGain(o: SaturationOpts, L: number, C: number, hueTurns: number): number {
  const rel = clamp(C / OKLAB_CHROMA_REF, 0, 1);
  const vw = o.vibrance >= 0 ? (1 - rel) * (1 - o.protectSkin * skinWeight(hueTurns)) : rel;
  const roll = clamp(1 - o.shadowRolloff * (1 - smoothstep(0, 0.4, L)) - o.highlightRolloff * smoothstep(0.6, 1, L), 0, 1);
  const g = Math.max(o.saturation * (1 + o.vibrance * vw), 0);
  return 1 + (g - 1) * roll;
}

/** Reference of the Saturation node on one colour. Input and output are sRGB-encoded 0..1. */
export function saturateReference(rgb: V3, o: SaturationOpts): V3 {
  const lin = srgbToLinear(rgb);
  const lab = linearToOklab(lin);
  const C = Math.hypot(lab[1], lab[2]);
  const hue = (Math.atan2(lab[2], lab[1]) / (2 * Math.PI) + 1) % 1;
  const m = saturationGain(o, lab[0], C, hue);
  if (o.mode === 'oklab') return linearToSrgb(oklabToLinearMapped(lab[0], lab[1] * m, lab[2] * m).map((v) => clamp(v, 0, 1)) as V3);
  if (o.mode === 'linear') {
    const Y = luma709(lin);
    let k = m;
    if (m > 1) for (const ch of lin) {
      const d = ch - Y;
      if (d > 1e-9) k = Math.min(k, (1 - Y) / d);
      else if (d < -1e-9) k = Math.min(k, Y / -d);
    }
    k = Math.max(k, Math.min(1, m));
    return linearToSrgb(lin.map((v) => clamp(Y + k * (v - Y), 0, 1)) as V3);
  }
  // HSL, legacy: on the encoded values
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, clamp(s * m, 0, 1), l]);
}
export function rgbToHsl([r, g, b]: V3): V3 {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d < 1e-9) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (mx === r) h = ((g - b) / d + 6) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
export function hslToRgb([h, s, l]: V3): V3 {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - (c / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/* ----------------------------------------------------------------------- */
/* White balance                                                            */
/* ----------------------------------------------------------------------- */

export type CatMethod = 'bradford' | 'cat16';
export const CAT_MATRICES: Record<CatMethod, M3> = {
  bradford: [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296],
  cat16: [0.401288, 0.650173, -0.051461, -0.250268, 1.204414, 0.045854, -0.002079, 0.048952, 0.953127],
};

/** XYZ -> XYZ von Kries adaptation taking white `src` to white `dst` in the cone space of `method`. */
export function adaptationMatrix(src: V3, dst: V3, method: CatMethod): M3 {
  const M = CAT_MATRICES[method];
  const a = mulMV(M, src);
  const b = mulMV(M, dst);
  const D: M3 = [b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]];
  return mulMM(invM3(M), mulMM(D, M));
}

/** Planckian locus (Kim et al. 2002), 1667..25000 K. */
export function planckianXY(kelvin: number): XY {
  const T = clamp(kelvin, 1667, 25000);
  const x = T <= 4000 ? -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991 : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.24039;
  let y: number;
  if (T <= 2222) y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
/** CIE daylight locus, 4000..25000 K. */
export function daylightXY(kelvin: number): XY {
  const T = clamp(kelvin, 4000, 25000);
  const x = T <= 7000 ? 0.244063 + 0.09911e3 / T + 2.9678e6 / T ** 2 - 4.607e9 / T ** 3 : 0.23704 + 0.24748e3 / T + 1.9018e6 / T ** 2 - 2.0064e9 / T ** 3;
  return [x, -3 * x * x + 2.87 * x - 0.275];
}
/** The locus used by the White Balance node: Planckian below 4000 K, daylight above 5000 K, a smooth blend in between. */
export function locusXY(kelvin: number): XY {
  const p = planckianXY(kelvin);
  if (kelvin <= 4000) return p;
  const d = daylightXY(kelvin);
  const w = smoothstep(4000, 5000, kelvin);
  return [mix(p[0], d[0], w), mix(p[1], d[1], w)];
}
export const xyToUv = ([x, y]: XY): XY => {
  const k = -2 * x + 12 * y + 3;
  return [(4 * x) / k, (6 * y) / k];
};
export const uvToXy = ([u, v]: XY): XY => {
  const k = 2 * u - 8 * v + 4;
  return [(3 * u) / k, (2 * v) / k];
};

/** Reference temperature: the image is left alone at this temperature (and tint 0). */
export const WB_NEUTRAL_KELVIN = 6500;
/** Tint 1 = this much Duv (CIE 1960 UCS distance from the locus, + = green side). */
export const WB_TINT_DUV = 0.03;

/**
 * Chromaticity of the scene illuminant for a temperature and tint. Measured RELATIVE to 6500 K, so that 6500 K / tint 0 is
 * exactly the sRGB white point (D65) and the correction is exactly the identity there.
 * `tint` > 0 moves the assumed light toward green, so the correction (the picture) moves toward magenta, as in photo editors.
 */
export function illuminantXY(kelvin: number, tint: number): XY {
  const here = locusXY(kelvin);
  const ref = locusXY(WB_NEUTRAL_KELVIN);
  const uv = xyToUv(here);
  const h = kelvin * 0.01;
  const a = xyToUv(locusXY(kelvin - h));
  const b = xyToUv(locusXY(kelvin + h));
  let du = b[0] - a[0];
  let dv = b[1] - a[1];
  const len = Math.hypot(du, dv) || 1;
  du /= len;
  dv /= len;
  let n: XY = [-dv, du];
  if (n[1] < 0) n = [-n[0], -n[1]];
  const uvT: XY = [uv[0] + n[0] * tint * WB_TINT_DUV, uv[1] + n[1] * tint * WB_TINT_DUV];
  const xyT = uvToXy(uvT);
  return [D65[0] + (xyT[0] - here[0]) + (here[0] - ref[0]), D65[1] + (xyT[1] - here[1]) + (here[1] - ref[1])];
}

/** Linear-sRGB matrix of the temperature/tint correction. */
export function whiteBalanceMatrix(kelvin: number, tint: number, method: CatMethod): M3 {
  const src = xyToXYZ(illuminantXY(kelvin, tint));
  const dst = xyToXYZ(D65);
  return mulMM(XYZ_TO_SRGB, mulMM(adaptationMatrix(src, dst, method), RGB_TO_XYZ.rec709));
}

/** Linear-sRGB matrix that maps the sRGB-encoded colour `picked` to a neutral grey of the same luminance. */
export function neutralMatrix(picked: V3, method: CatMethod): M3 {
  const lin = srgbToLinear(picked).map((v) => Math.max(v, 1e-3)) as V3;
  const xyz = mulMV(RGB_TO_XYZ.rec709, lin);
  const src: V3 = [xyz[0] / xyz[1], 1, xyz[2] / xyz[1]];
  return mulMM(XYZ_TO_SRGB, mulMM(adaptationMatrix(src, xyToXYZ(D65), method), RGB_TO_XYZ.rec709));
}

/**
 * Colour that should be treated as neutral, estimated from straight-alpha RGBA8 pixels (a small downsample).
 * grey-world: the mean linear colour. white-patch: the mean of the brightest 2% of pixels (by luma). Returns sRGB-encoded.
 */
export function estimateNeutral(rgba: ArrayLike<number>, method: 'grey-world' | 'white-patch'): V3 {
  const n = Math.floor(rgba.length / 4);
  const px: { y: number; c: V3 }[] = [];
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 8) continue;
    const c = srgbToLinear([rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255]);
    px.push({ y: luma709(c), c });
  }
  if (!px.length) return [0.5, 0.5, 0.5];
  let use = px;
  if (method === 'white-patch') {
    px.sort((a, b) => b.y - a.y);
    use = px.slice(0, Math.max(1, Math.ceil(px.length * 0.02)));
  }
  const sum: V3 = [0, 0, 0];
  for (const p of use) for (let k = 0; k < 3; k++) sum[k] += p.c[k];
  return linearToSrgb([sum[0] / use.length, sum[1] / use.length, sum[2] / use.length]);
}

/* ----------------------------------------------------------------------- */
/* Lift / Gamma / Gain, ASC CDL                                             */
/* ----------------------------------------------------------------------- */

/** Working spaces of the grade: values as stored, linear light, or Cineon log (offset then behaves like printer lights). */
export type WorkingSpace = 'display' | 'linear' | 'log';
export const WORKING_ID: Record<WorkingSpace, TransferId> = { display: 'srgb', linear: 'linear', log: 'cineon' };
/** How strongly a fully saturated wheel colour tints each range: tint = (rgb - mean(rgb)) * scale. */
export const WHEEL_SCALE = { lift: 0.25, gamma: 0.5, gain: 0.5, offset: 0.1 };

/** Wheel colour + master -> per-channel value (added to the neutral value of the range by the caller). */
export function wheelVec(color: ArrayLike<number>, master: number, scale: number): V3 {
  const m = (color[0] + color[1] + color[2]) / 3;
  return [master + (color[0] - m) * scale, master + (color[1] - m) * scale, master + (color[2] - m) * scale];
}

export interface GradeOpts {
  mode: 'lgg' | 'cdl';
  lift: V3; // added to black
  gamma: V3; // 1 = none, > 1 brightens mids
  gain: V3; // multiplier of white
  offset: V3;
  slope: V3;
  cdlOffset: V3;
  power: V3;
  contrast: number;
  pivot: number; // in working space
  saturation: number;
}
/** One channel of the grade, in the working space. */
export function gradeChannel(x: number, o: GradeOpts, ch: 0 | 1 | 2): number {
  let y: number;
  if (o.mode === 'cdl') {
    y = Math.pow(Math.max(x * o.slope[ch] + o.cdlOffset[ch], 0), o.power[ch]);
  } else {
    y = Math.pow(Math.max(x, 0), 1 / Math.max(o.gamma[ch], 0.01));
    y = y * o.gain[ch];
    y = y * (1 - o.lift[ch]) + o.lift[ch];
    y = y + o.offset[ch];
    y = (y - o.pivot) * o.contrast + o.pivot;
  }
  return y;
}
/** Reference of the Lift Gamma Gain node. sRGB-encoded in and out; `space` picks the working space. */
export function gradeReference(rgb: V3, o: GradeOpts, space: WorkingSpace): V3 {
  const tf = WORKING_ID[space];
  const lin = srgbToLinear(rgb);
  const w: V3 = [tfEncode(tf, lin[0]), tfEncode(tf, lin[1]), tfEncode(tf, lin[2])];
  let y: V3 = [gradeChannel(w[0], o, 0), gradeChannel(w[1], o, 1), gradeChannel(w[2], o, 2)];
  const l = luma709(y);
  y = y.map((v) => l + o.saturation * (v - l)) as V3;
  const back: V3 = [tfDecode(tf, y[0]), tfDecode(tf, y[1]), tfDecode(tf, y[2])];
  return linearToSrgb(back.map((v) => clamp(v, 0, 1)) as V3);
}

/* ----------------------------------------------------------------------- */
/* Exposure and tone mapping                                                */
/* ----------------------------------------------------------------------- */

export type ToneMap = 'none' | 'reinhard' | 'hable';
/** John Hable's "Uncharted 2" filmic curve constants (GDC 2010). */
export const HABLE = { A: 0.15, B: 0.5, C: 0.1, D: 0.2, E: 0.02, F: 0.3 };
export const hable = (x: number): number => {
  const h = HABLE;
  return (x * (h.A * x + h.C * h.B) + h.D * h.E) / (x * (h.A * x + h.B) + h.D * h.F) - h.E / h.F;
};
/** Soft shoulder: identity below `knee`, then approaches 1 with matching slope (C1). knee = 1 gives a hard clip. */
export function shoulder(x: number, knee: number): number {
  if (x <= knee) return x;
  const span = 1 - knee;
  return span <= 1e-6 ? 1 : knee + span * (1 - Math.exp(-(x - knee) / span));
}
export interface ExposureOpts {
  stops: number;
  blackPoint: number; // linear
  rolloff: number; // 0..1
  tonemap: ToneMap;
  whitePoint: number; // linear value that maps to 1
}
export function exposureChannel(lin: number, o: ExposureOpts): number {
  let x = (lin - o.blackPoint) / Math.max(1 - o.blackPoint, 1e-3);
  x = Math.max(x, 0) * Math.pow(2, o.stops);
  if (o.tonemap === 'reinhard') {
    const w = Math.max(o.whitePoint, 1e-3);
    return (x * (1 + x / (w * w))) / (1 + x);
  }
  if (o.tonemap === 'hable') return Math.min(hable(x) / hable(Math.max(o.whitePoint, 1e-3)), 1);
  return shoulder(x, 1 - o.rolloff);
}

/* ----------------------------------------------------------------------- */
/* Curves                                                                   */
/* ----------------------------------------------------------------------- */

export const CURVE_TABLE_SIZE = 256;
/** Axis of every curve is 0..1; the value range of the hue/sat/lum curves is 0..1 with 0.5 = no change. */
export const CURVE_NEUTRAL = 0.5;
/** Full vertical range of Hue vs Hue (turns, +/-). */
export const HUE_SHIFT_TURNS = 0.5;
/** Hue vs Lum: +/- this much OKLab lightness at the curve's extremes. */
export const LUM_SHIFT = 0.5;

const memo = new Map<string, Float32Array>();
/** Pure memoisation of table builds keyed by content (a handful of recent tables, so dragging a point does not grow it). */
function memoTable(key: string, build: () => Float32Array): Float32Array {
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const t = build();
  memo.set(key, t);
  while (memo.size > 16) memo.delete(memo.keys().next().value as string);
  return t;
}

/** RGB table: texel i = (R, G, B, 0) with master applied first, then the channel curve. */
export function rgbCurveTable(master: CurveValue, r: CurveValue, g: CurveValue, b: CurveValue): Float32Array {
  return memoTable(JSON.stringify(['rgb', master, r, g, b]), () => {
    const out = new Float32Array(CURVE_TABLE_SIZE * 4);
    for (let i = 0; i < CURVE_TABLE_SIZE; i++) {
      const x = i / (CURVE_TABLE_SIZE - 1);
      const m = evalCurve(master, x);
      out[i * 4] = evalCurve(r, m);
      out[i * 4 + 1] = evalCurve(g, m);
      out[i * 4 + 2] = evalCurve(b, m);
    }
    return out;
  });
}
/** Five rows (hue-vs-hue, hue-vs-sat, hue-vs-lum, lum-vs-sat, sat-vs-sat) of 256 texels, value in .r. Hue curves wrap around. */
export function hslCurveTable(curves: CurveValue[]): Float32Array {
  return memoTable(JSON.stringify(['hsl', curves]), () => {
    const out = new Float32Array(CURVE_TABLE_SIZE * 5 * 4);
    curves.forEach((c, row) => {
      const loop = row < 3;
      for (let i = 0; i < CURVE_TABLE_SIZE; i++) {
        const x = i / (CURVE_TABLE_SIZE - 1);
        out[(row * CURVE_TABLE_SIZE + i) * 4] = evalCurve(c, x, { loop });
      }
    });
    return out;
  });
}
/** True when the curve is a straight line from (0,0) to (1,1). */
export function isIdentityCurve(c: CurveValue): boolean {
  for (let i = 0; i <= 16; i++) if (Math.abs(evalCurve(c, i / 16) - i / 16) > 1e-4) return false;
  return true;
}
/** True when the curve is flat at 0.5 (the neutral of the hue / sat / lum curves). */
export function isNeutralCurve(c: CurveValue): boolean {
  for (let i = 0; i <= 32; i++) if (Math.abs(evalCurve(c, i / 32, { loop: true }) - CURVE_NEUTRAL) > 1e-4) return false;
  return true;
}

/* ----------------------------------------------------------------------- */
/* .cube LUTs                                                               */
/* ----------------------------------------------------------------------- */

export const CUBE_MAX_3D = 65;
export const CUBE_MAX_1D = 4096;
export interface CubeLut {
  kind: '1d' | '3d';
  size: number;
  title: string;
  domainMin: V3;
  domainMax: V3;
  /** 3D: size^3 RGB triples, red fastest. 1D: size RGB triples. */
  rgb: Float32Array;
}

/** Parse the text of an Adobe/Resolve .cube file. Throws an Error with a readable message. */
export function parseCube(text: string): CubeLut {
  let size1 = 0;
  let size3 = 0;
  let title = '';
  let dmin: V3 = [0, 0, 0];
  let dmax: V3 = [1, 1, 1];
  const nums: number[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const triple = (parts: string[], what: string): V3 => {
    const v = parts.slice(1, 4).map(Number);
    if (v.length < 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`.cube: bad ${what} line`);
    return v as V3;
  };
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].split('#')[0].trim();
    if (!line) continue;
    const first = line.charCodeAt(0);
    if ((first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46) {
      const p = line.split(/\s+/);
      if (p.length < 3) throw new Error(`.cube: line ${ln + 1} does not hold three numbers`);
      const r = Number(p[0]);
      const g = Number(p[1]);
      const b = Number(p[2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) throw new Error(`.cube: line ${ln + 1} is not numeric`);
      nums.push(r, g, b);
      continue;
    }
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'TITLE':
        title = line.slice(5).trim().replace(/^"|"$/g, '');
        break;
      case 'LUT_1D_SIZE':
        size1 = parseInt(parts[1], 10);
        break;
      case 'LUT_3D_SIZE':
        size3 = parseInt(parts[1], 10);
        break;
      case 'DOMAIN_MIN':
        dmin = triple(parts, 'DOMAIN_MIN');
        break;
      case 'DOMAIN_MAX':
        dmax = triple(parts, 'DOMAIN_MAX');
        break;
      case 'LUT_1D_INPUT_RANGE':
      case 'LUT_3D_INPUT_RANGE':
        dmin = [Number(parts[1]), Number(parts[1]), Number(parts[1])];
        dmax = [Number(parts[2]), Number(parts[2]), Number(parts[2])];
        break;
      default:
        break; // unknown keywords (LUT_IN_VIDEO_RANGE, ...) are ignored
    }
  }
  const kind = size3 > 0 ? '3d' : size1 > 0 ? '1d' : null;
  if (!kind) throw new Error('.cube: no LUT_3D_SIZE or LUT_1D_SIZE line');
  const size = kind === '3d' ? size3 : size1;
  if (!Number.isInteger(size) || size < 2) throw new Error(`.cube: invalid size ${size}`);
  if (kind === '3d' && size > CUBE_MAX_3D) throw new Error(`.cube: 3D LUT of ${size}^3 is larger than the supported ${CUBE_MAX_3D}^3`);
  if (kind === '1d' && size > 65536) throw new Error(`.cube: 1D LUT of ${size} entries is larger than the supported 65536`);
  const expected = (kind === '3d' ? size * size * size : size) * 3;
  if (nums.length !== expected) throw new Error(`.cube: expected ${expected / 3} entries for size ${size}, found ${nums.length / 3}`);
  if (dmax.some((v, i) => v <= dmin[i])) throw new Error('.cube: DOMAIN_MAX must be larger than DOMAIN_MIN');
  let rgb = Float32Array.from(nums);
  let outSize = size;
  if (kind === '1d' && size > CUBE_MAX_1D) {
    // Resample very long 1D tables so they fit a texture row (linear interpolation, exact at both ends).
    const res = new Float32Array(CUBE_MAX_1D * 3);
    for (let i = 0; i < CUBE_MAX_1D; i++) {
      const f = (i / (CUBE_MAX_1D - 1)) * (size - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(size - 1, i0 + 1);
      const t = f - i0;
      for (let c = 0; c < 3; c++) res[i * 3 + c] = rgb[i0 * 3 + c] * (1 - t) + rgb[i1 * 3 + c] * t;
    }
    rgb = res;
    outSize = CUBE_MAX_1D;
  }
  return { kind, size: outSize, title, domainMin: dmin, domainMax: dmax, rgb };
}

/** Texture layout of a LUT: 3D = atlas of `size` slices side by side (x = r + b*size, y = g); 1D = one row. RGBA floats. */
export function cubeTexture(lut: CubeLut): { data: Float32Array; width: number; height: number } {
  const n = lut.size;
  if (lut.kind === '1d') {
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = lut.rgb[i * 3];
      data[i * 4 + 1] = lut.rgb[i * 3 + 1];
      data[i * 4 + 2] = lut.rgb[i * 3 + 2];
      data[i * 4 + 3] = 1;
    }
    return { data, width: n, height: 1 };
  }
  const width = n * n;
  const data = new Float32Array(width * n * 4);
  for (let i = 0; i < n * n * n; i++) {
    const r = i % n;
    const g = Math.floor(i / n) % n;
    const b = Math.floor(i / (n * n));
    const o = (g * width + (r + b * n)) * 4;
    data[o] = lut.rgb[i * 3];
    data[o + 1] = lut.rgb[i * 3 + 1];
    data[o + 2] = lut.rgb[i * 3 + 2];
    data[o + 3] = 1;
  }
  return { data, width, height: n };
}

/** Text of a .cube file from a function (for tests and tools). 3D order: red fastest. */
export function cubeText(kind: '1d' | '3d', size: number, fn: (r: number, g: number, b: number) => V3, title = 'generated'): string {
  const out = [`TITLE "${title}"`, kind === '3d' ? `LUT_3D_SIZE ${size}` : `LUT_1D_SIZE ${size}`];
  const f = (v: number) => v.toFixed(6);
  if (kind === '1d') {
    for (let i = 0; i < size; i++) {
      const x = i / (size - 1);
      out.push(fn(x, x, x).map(f).join(' '));
    }
  } else {
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) out.push(fn(r / (size - 1), g / (size - 1), b / (size - 1)).map(f).join(' '));
  }
  return out.join('\n') + '\n';
}

/** Reference sampling of a parsed LUT (the shader does the same with texture fetches). `rgb` is in the LUT's input domain. */
export function sampleCube(lut: CubeLut, rgb: V3, interp: 'tetrahedral' | 'trilinear' = 'tetrahedral'): V3 {
  const n = lut.size;
  const t: V3 = [0, 1, 2].map((i) => clamp((rgb[i] - lut.domainMin[i]) / (lut.domainMax[i] - lut.domainMin[i]), 0, 1)) as V3;
  const at = (r: number, g: number, b: number): V3 => {
    const i = lut.kind === '3d' ? r + g * n + b * n * n : r;
    return [lut.rgb[i * 3], lut.rgb[i * 3 + 1], lut.rgb[i * 3 + 2]];
  };
  if (lut.kind === '1d') {
    const out: V3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const f = t[c] * (n - 1);
      const i0 = Math.min(Math.floor(f), n - 2);
      const w = f - i0;
      out[c] = lut.rgb[i0 * 3 + c] * (1 - w) + lut.rgb[(i0 + 1) * 3 + c] * w;
    }
    return out;
  }
  const f = t.map((v) => v * (n - 1));
  const i0 = f.map((v) => Math.min(Math.floor(v), n - 2));
  const [fr, fg, fb] = [f[0] - i0[0], f[1] - i0[1], f[2] - i0[2]];
  const c = (dr: number, dg: number, db: number) => at(i0[0] + dr, i0[1] + dg, i0[2] + db);
  const out: V3 = [0, 0, 0];
  if (interp === 'trilinear') {
    for (let k = 0; k < 3; k++) {
      const x = (g: number, b: number) => mix(c(0, g, b)[k], c(1, g, b)[k], fr);
      out[k] = mix(mix(x(0, 0), x(1, 0), fg), mix(x(0, 1), x(1, 1), fg), fb);
    }
    return out;
  }
  const c000 = c(0, 0, 0);
  const c111 = c(1, 1, 1);
  for (let k = 0; k < 3; k++) {
    let v: number;
    if (fr >= fg && fg >= fb) v = c000[k] + fr * (c(1, 0, 0)[k] - c000[k]) + fg * (c(1, 1, 0)[k] - c(1, 0, 0)[k]) + fb * (c111[k] - c(1, 1, 0)[k]);
    else if (fr >= fb && fb >= fg) v = c000[k] + fr * (c(1, 0, 0)[k] - c000[k]) + fb * (c(1, 0, 1)[k] - c(1, 0, 0)[k]) + fg * (c111[k] - c(1, 0, 1)[k]);
    else if (fb >= fr && fr >= fg) v = c000[k] + fb * (c(0, 0, 1)[k] - c000[k]) + fr * (c(1, 0, 1)[k] - c(0, 0, 1)[k]) + fg * (c111[k] - c(1, 0, 1)[k]);
    else if (fg >= fr && fr >= fb) v = c000[k] + fg * (c(0, 1, 0)[k] - c000[k]) + fr * (c(1, 1, 0)[k] - c(0, 1, 0)[k]) + fb * (c111[k] - c(1, 1, 0)[k]);
    else if (fg >= fb && fb >= fr) v = c000[k] + fg * (c(0, 1, 0)[k] - c000[k]) + fb * (c(0, 1, 1)[k] - c(0, 1, 0)[k]) + fr * (c111[k] - c(0, 1, 1)[k]);
    else v = c000[k] + fb * (c(0, 0, 1)[k] - c000[k]) + fg * (c(0, 1, 1)[k] - c(0, 0, 1)[k]) + fr * (c111[k] - c(0, 1, 1)[k]);
    out[k] = v;
  }
  return out;
}

/* ----------------------------------------------------------------------- */
/* HSL qualifier                                                            */
/* ----------------------------------------------------------------------- */

/** Soft box: 1 inside [lo, hi], falling to 0 over `soft` outside each edge. */
export function softRange(x: number, lo: number, hi: number, soft: number): number {
  const s = Math.max(soft, 1e-4);
  return smoothstep(lo - s, lo, x) * (1 - smoothstep(hi, hi + s, x));
}
export interface QualifierOpts {
  hueCenter: number; // turns
  hueWidth: number; // turns, half width of the solid part; >= 0.5 disables the hue test
  hueSoft: number;
  satLow: number;
  satHigh: number;
  satSoft: number;
  lumLow: number;
  lumHigh: number;
  lumSoft: number;
  invert: boolean;
}
/** Reference of the Colour Key node: coverage 0..1 of one sRGB-encoded colour. Hue/saturation/lightness are HSL of the encoded values. */
export function qualify(rgb: V3, o: QualifierOpts): number {
  const [h, s, l] = rgbToHsl(rgb);
  let dh = Math.abs(h - o.hueCenter);
  dh = Math.min(dh, 1 - dh);
  const hueOn = o.hueWidth < 0.4999;
  const hueM = hueOn ? (1 - smoothstep(o.hueWidth, o.hueWidth + Math.max(o.hueSoft, 1e-4), dh)) * smoothstep(0.02, 0.1, s) : 1;
  const m = hueM * softRange(s, o.satLow, o.satHigh, o.satSoft) * softRange(l, o.lumLow, o.lumHigh, o.lumSoft);
  return o.invert ? 1 - m : m;
}
