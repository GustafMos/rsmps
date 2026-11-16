/**
 * WGSL for the grading nodes, generated from the constants and formulas of `color-math.ts` (the reference the tests
 * compare the GPU with). Paste `COLOR_WGSL` in front of a node's `fx`. Everything is prefixed `cg_` so it cannot clash with
 * the engine prelude (which supplies srgbToLinear, linearToOklab, oklabToLinear, rgbToHsv, hsvToRgb, unpremul, premul).
 *
 * The text is a constant: numbers that change while the user works go in uniforms, so one node = one shader
 * (docs/ENGINE.md rule 24).
 */
import { CINEON_OFFSET, GAMUT_ITERATIONS, OKLAB_CHROMA_REF, REC709_LUMA, SKIN, TF } from './color-math';

/** A JS number as a WGSL float literal. */
export const fl = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const t = TF;

export const COLOR_WGSL = /* wgsl */ `
const CG_LUMA = vec3f(${fl(REC709_LUMA[0])}, ${fl(REC709_LUMA[1])}, ${fl(REC709_LUMA[2])});
fn cg_luma(c: vec3f) -> f32 { return dot(c, CG_LUMA); }
fn cg_pos(x: f32) -> f32 { return max(x, 0.0); }
fn cg_log10(x: f32) -> f32 { return log2(max(x, 1e-12)) * 0.30102999566398; }

// ---- transfer functions: id = index in TRANSFER_IDS (srgb, linear, gamma22, gamma24, cineon, slog3, logc3, vlog, acescct, davinci) ----
fn cg_dec1(v: f32, id: f32) -> f32 {
  if (id < 0.5) {
    if (v <= ${fl(t.srgb.cutEnc)}) { return v / ${fl(t.srgb.slope)}; }
    return pow((cg_pos(v) + ${fl(t.srgb.a)}) / ${fl(1 + t.srgb.a)}, 2.4);
  }
  if (id < 1.5) { return v; }
  if (id < 2.5) { return pow(cg_pos(v), 2.2); }
  if (id < 3.5) { return pow(cg_pos(v), 2.4); }
  if (id < 4.5) {
    let code = v * ${fl(t.cineon.codes)};
    return (pow(10.0, (code - ${fl(t.cineon.refWhite)}) * ${fl(t.cineon.density)} / ${fl(t.cineon.gamma)}) - ${fl(CINEON_OFFSET)}) / ${fl(1 - CINEON_OFFSET)};
  }
  if (id < 5.5) {
    if (v >= ${fl(t.slog3.d / t.slog3.codes)}) { return pow(10.0, (v * ${fl(t.slog3.codes)} - ${fl(t.slog3.a)}) / ${fl(t.slog3.b)}) * ${fl(t.slog3.mid + t.slog3.off)} - ${fl(t.slog3.off)}; }
    return (v * ${fl(t.slog3.codes)} - ${fl(t.slog3.c)}) * ${fl(t.slog3.cut)} / ${fl(t.slog3.d - t.slog3.c)};
  }
  if (id < 6.5) {
    if (v > ${fl(t.logc3.e * t.logc3.cut + t.logc3.f)}) { return (pow(10.0, (v - ${fl(t.logc3.d)}) / ${fl(t.logc3.c)}) - ${fl(t.logc3.b)}) / ${fl(t.logc3.a)}; }
    return (v - ${fl(t.logc3.f)}) / ${fl(t.logc3.e)};
  }
  if (id < 7.5) {
    if (v < ${fl(t.vlog.cutEnc)}) { return (v - ${fl(t.vlog.linB)}) / ${fl(t.vlog.linA)}; }
    return pow(10.0, (v - ${fl(t.vlog.d)}) / ${fl(t.vlog.c)}) - ${fl(t.vlog.b)};
  }
  if (id < 8.5) {
    if (v <= ${fl(t.acescct.a * t.acescct.cut + t.acescct.b)}) { return (v - ${fl(t.acescct.b)}) / ${fl(t.acescct.a)}; }
    return exp2(v * ${fl(t.acescct.c)} - ${fl(t.acescct.d)});
  }
  if (v <= ${fl(t.davinci.logCut)}) { return v / ${fl(t.davinci.m)}; }
  return exp2(v / ${fl(t.davinci.c)} - ${fl(t.davinci.b)}) - ${fl(t.davinci.a)};
}
fn cg_enc1(l: f32, id: f32) -> f32 {
  if (id < 0.5) {
    if (l <= ${fl(t.srgb.cutLin)}) { return l * ${fl(t.srgb.slope)}; }
    return ${fl(1 + t.srgb.a)} * pow(cg_pos(l), 1.0 / 2.4) - ${fl(t.srgb.a)};
  }
  if (id < 1.5) { return l; }
  if (id < 2.5) { return pow(cg_pos(l), 1.0 / 2.2); }
  if (id < 3.5) { return pow(cg_pos(l), 1.0 / 2.4); }
  if (id < 4.5) {
    let code = ${fl(t.cineon.refWhite)} + cg_log10(l * ${fl(1 - CINEON_OFFSET)} + ${fl(CINEON_OFFSET)}) * ${fl(t.cineon.gamma)} / ${fl(t.cineon.density)};
    return code / ${fl(t.cineon.codes)};
  }
  if (id < 5.5) {
    if (l >= ${fl(t.slog3.cut)}) { return (${fl(t.slog3.a)} + cg_log10((l + ${fl(t.slog3.off)}) / ${fl(t.slog3.mid + t.slog3.off)}) * ${fl(t.slog3.b)}) / ${fl(t.slog3.codes)}; }
    return (l * ${fl(t.slog3.d - t.slog3.c)} / ${fl(t.slog3.cut)} + ${fl(t.slog3.c)}) / ${fl(t.slog3.codes)};
  }
  if (id < 6.5) {
    if (l > ${fl(t.logc3.cut)}) { return ${fl(t.logc3.c)} * cg_log10(${fl(t.logc3.a)} * l + ${fl(t.logc3.b)}) + ${fl(t.logc3.d)}; }
    return ${fl(t.logc3.e)} * l + ${fl(t.logc3.f)};
  }
  if (id < 7.5) {
    if (l < ${fl(t.vlog.cut)}) { return ${fl(t.vlog.linA)} * l + ${fl(t.vlog.linB)}; }
    return ${fl(t.vlog.c)} * cg_log10(l + ${fl(t.vlog.b)}) + ${fl(t.vlog.d)};
  }
  if (id < 8.5) {
    if (l <= ${fl(t.acescct.cut)}) { return ${fl(t.acescct.a)} * l + ${fl(t.acescct.b)}; }
    return (log2(l) + ${fl(t.acescct.d)}) / ${fl(t.acescct.c)};
  }
  if (l <= ${fl(t.davinci.linCut)}) { return l * ${fl(t.davinci.m)}; }
  return (log2(l + ${fl(t.davinci.a)}) + ${fl(t.davinci.b)}) * ${fl(t.davinci.c)};
}
fn cg_dec(c: vec3f, id: f32) -> vec3f { return vec3f(cg_dec1(c.x, id), cg_dec1(c.y, id), cg_dec1(c.z, id)); }
fn cg_enc(c: vec3f, id: f32) -> vec3f { return vec3f(cg_enc1(c.x, id), cg_enc1(c.y, id), cg_enc1(c.z, id)); }

// ---- OKLab with gamut mapping by chroma reduction ----
fn cg_inGamut(c: vec3f) -> bool { return all(c >= vec3f(-0.0005)) && all(c <= vec3f(1.0005)); }
/** Linear sRGB of lightness L with chroma vector ab, pulled toward the grey of the same lightness until it fits (never clipped). */
fn cg_gamutLC(L0: f32, ab: vec2f) -> vec3f {
  let L = clamp(L0, 0.0, 1.0);
  let direct = oklabToLinear(vec3f(L, ab));
  if (cg_inGamut(direct)) { return direct; }
  var lo = 0.0;
  var hi = 1.0;
  for (var i = 0; i < ${GAMUT_ITERATIONS}; i++) {
    let mid = 0.5 * (lo + hi);
    if (cg_inGamut(oklabToLinear(vec3f(L, ab * mid)))) { lo = mid; } else { hi = mid; }
  }
  return oklabToLinear(vec3f(L, ab * lo));
}
const CG_CHROMA_REF: f32 = ${fl(OKLAB_CHROMA_REF)};
fn cg_skinWeight(hueTurns: f32) -> f32 {
  var d = abs(hueTurns - ${fl(SKIN.hue)});
  d = min(d, 1.0 - d);
  return 1.0 - smoothstep(${fl(SKIN.width)}, ${fl(SKIN.width + SKIN.falloff)}, d);
}
/** Chroma multiplier after vibrance, skin protection and the shadow / highlight roll-off (see saturationGain in color-math.ts). */
fn cg_satGain(sat: f32, vib: f32, protect: f32, shRoll: f32, hiRoll: f32, L: f32, C: f32, hueTurns: f32) -> f32 {
  let rel = clamp(C / CG_CHROMA_REF, 0.0, 1.0);
  var vw = rel;
  if (vib >= 0.0) { vw = (1.0 - rel) * (1.0 - protect * cg_skinWeight(hueTurns)); }
  let roll = clamp(1.0 - shRoll * (1.0 - smoothstep(0.0, 0.4, L)) - hiRoll * smoothstep(0.6, 1.0, L), 0.0, 1.0);
  let g = max(sat * (1.0 + vib * vw), 0.0);
  return 1.0 + (g - 1.0) * roll;
}

// ---- HSL (on encoded values) ----
fn cg_rgbToHsl(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let l = 0.5 * (mx + mn);
  let d = mx - mn;
  if (d < 1e-6) { return vec3f(0.0, 0.0, l); }
  let s = d / max(1.0 - abs(2.0 * l - 1.0), 1e-6);
  var h: f32;
  if (mx == c.r) { h = ((c.g - c.b) / d + 6.0) % 6.0; }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h / 6.0, s, l);
}
fn cg_hslToRgb(c: vec3f) -> vec3f {
  let ch = (1.0 - abs(2.0 * c.z - 1.0)) * c.y;
  let k = (vec3f(0.0, 8.0, 4.0) + c.x * 12.0) % 12.0;
  return vec3f(c.z) - 0.5 * ch * clamp(min(k - 3.0, 9.0 - k), vec3f(-1.0), vec3f(1.0));
}
fn cg_softRange(x: f32, lo: f32, hi: f32, soft: f32) -> f32 {
  let s = max(soft, 1e-4);
  return smoothstep(lo - s, lo, x) * (1.0 - smoothstep(hi, hi + s, x));
}
`;
