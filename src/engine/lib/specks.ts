import type { ParamDef, TimeInfo } from '../types';
import { loopFrame } from './fx-util';

/**
 * Specks: tape dropouts, dust, film scratches, drawn as editable particles by one shared shader function.
 * Used by Analog Video (inside its tape pass) and by the standalone Specks node.
 *
 * What real tape dropouts look like, and what this models:
 *  - they lie along ONE scan line (or two), so the speck grid is made of scan lines (2 unit pixels tall), not texel rows;
 *  - a bright head, then a tail that decays to the right; lengths are long-tailed (many short, few long);
 *  - they come in bursts (a few rows get many, the rest almost none) and sit in bands (bottom of the picture, or a band that rolls);
 *  - they are not pure white: the signal drops out and the player holds / brightens what it had, so the colour follows the
 *    picture and loses its chroma; some are dark;
 *  - the pattern changes with the field, it does not move.
 * Everything is hashed from (seed, flicker epoch, scan line, slot), so it is deterministic, loops by whole frame indices and costs
 * a fixed handful of hashes per pixel. Positions are on a torus, so whole-cycle drift loops too.
 */

export const SPECK_SHAPES = [
  { value: 'streak', label: 'Streak' },
  { value: 'dash', label: 'Dash' },
  { value: 'dot', label: 'Dot' },
  { value: 'block', label: 'Block' },
  { value: 'scratch', label: 'Scratch' },
] as const;
const SHAPE_ID: Record<string, number> = { streak: 0, dash: 1, dot: 2, block: 3, scratch: 4 };
const COLOR_ID: Record<string, number> = { picture: 0, white: 1, black: 2, custom: 3, random: 4 };
const BLEND_ID: Record<string, number> = { replace: 0, add: 1, screen: 2 };
const BAND_ID: Record<string, number> = { uniform: 0, bottom: 1, rolling: 2 };

const G = 'Dropouts / specks';

/** Parameter definitions shared by every node that draws specks. The node adds its own amount param (key differs). */
export const SPECK_PARAMS = {
  speckShape: { type: 'enum', default: 'streak', options: SPECK_SHAPES, label: 'Shape', group: G, hint: 'Streak = horizontal dropout with a decaying tail. Scratch = long vertical hair, like film.' },
  speckBurst: { type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, label: 'Burstiness', group: G, hint: '0 = evenly scattered. 1 = a few clusters and bad frames, empty elsewhere.' },
  speckBand: {
    type: 'enum',
    default: 'rolling',
    options: [
      { value: 'uniform', label: 'Uniform' },
      { value: 'bottom', label: 'Bottom band' },
      { value: 'rolling', label: 'Rolling band' },
    ],
    label: 'Where',
    group: G,
    hint: 'Real dropouts concentrate in bands instead of covering the picture evenly.',
  },
  speckBandPos: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Band position', group: G, visibleIf: (p) => p.speckBand === 'rolling' },
  speckBandWidth: { type: 'number', default: 0.22, min: 0.03, max: 0.5, step: 0.01, unit: 'norm', label: 'Band width', group: G, visibleIf: (p) => p.speckBand !== 'uniform' },
  speckBandCycles: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Band rolls', group: G, hint: 'Needs Animate. 0 = the band stands still.', visibleIf: (p) => p.speckBand === 'rolling' },
  speckLenMin: { type: 'number', default: 10, min: 1, max: 400, softMax: 200, step: 0.5, unit: 'px', label: 'Length min', group: G, hint: 'Lengths are long-tailed: most specks are near the minimum, a few reach the maximum.' },
  speckLenMax: { type: 'number', default: 260, min: 1, max: 1500, softMax: 600, step: 1, unit: 'px', label: 'Length max', group: G },
  speckThickness: { type: 'number', default: 1.5, min: 0.25, max: 6, step: 0.05, label: 'Thickness', group: G, hint: 'A scan line is 2 pixels at the project size. Dots grow in every direction.' },
  speckTail: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Tail falloff', group: G, hint: 'Streak only. 0 = the tail fades slowly over its whole length, 1 = the head is a bright dot with a short fade.', visibleIf: (p) => p.speckShape === 'streak' },
  speckSoft: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Softness', group: G, hint: '0 = hard pixel edges.' },
  speckColorMode: {
    type: 'enum',
    default: 'picture',
    options: [
      { value: 'picture', label: 'Picture, brightened' },
      { value: 'white', label: 'White' },
      { value: 'black', label: 'Black' },
      { value: 'custom', label: 'Custom color' },
      { value: 'random', label: 'Random of two' },
    ],
    label: 'Color mode',
    group: G,
  },
  speckColor: { type: 'color', default: [1, 0.95, 0.85, 1], label: 'Color', group: G, visibleIf: (p) => p.speckColorMode === 'custom' || p.speckColorMode === 'random' },
  speckColor2: { type: 'color', default: [0.55, 0.8, 1, 1], label: 'Second color', group: G, visibleIf: (p) => p.speckColorMode === 'random' },
  speckBrightness: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Brightening', group: G, hint: 'How far the picture color is pushed to white.', visibleIf: (p) => p.speckColorMode === 'picture' },
  speckDark: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Dark share', group: G, hint: 'Fraction of specks that drop to black instead (From the picture / White only).', visibleIf: (p) => p.speckColorMode === 'picture' || p.speckColorMode === 'white' },
  speckAlpha: { type: 'number', default: 0.95, min: 0, max: 1, step: 0.01, label: 'Opacity', group: G },
  speckBlend: {
    type: 'enum',
    default: 'replace',
    options: [
      { value: 'replace', label: 'Replace' },
      { value: 'add', label: 'Add' },
      { value: 'screen', label: 'Screen' },
    ],
    label: 'Blend',
    group: G,
  },
  speckChroma: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Color loss', group: G, hint: 'How much of the picture color under a speck is lost.' },
  speckFlicker: { type: 'number', default: 2, min: 0, max: 24, step: 1, integer: true, unit: 'cycles', label: 'Change every N', group: G, hint: 'Needs Animate. 0 = one fixed pattern.' },
  speckDriftX: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Drift X', group: G, hint: 'Whole picture widths per loop. Combine with 0 flicker for specks that travel.' },
  speckDriftY: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Drift Y', group: G },
  speckSeed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Specks seed', group: G },
} satisfies Record<string, ParamDef>;

export type SpeckParamValues = {
  speckShape: string;
  speckBurst: number;
  speckBand: string;
  speckBandPos: number;
  speckBandWidth: number;
  speckBandCycles: number;
  speckLenMin: number;
  speckLenMax: number;
  speckThickness: number;
  speckTail: number;
  speckSoft: number;
  speckColorMode: string;
  speckColor: number[];
  speckColor2: number[];
  speckBrightness: number;
  speckDark: number;
  speckAlpha: number;
  speckBlend: string;
  speckChroma: number;
  speckFlicker: number;
  speckDriftX: number;
  speckDriftY: number;
  speckSeed: number;
};

function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 8) / 16777216;
}

/**
 * Uniform values for SPECKS_WGSL. `amount` is the node's own amount param (0..1). Reads the clock only when `time` is given
 * (animating): a still node stays cached. Same keys every call, so the layout (and the pipeline) never changes with the sliders.
 */
export function speckUniforms(
  p: SpeckParamValues,
  o: { amount: number; unit: number; time?: TimeInfo | null },
): Record<string, number | number[]> {
  const flick = Math.max(0, Math.round(p.speckFlicker));
  let epoch = 0;
  if (o.time && flick > 0) epoch = Math.floor(loopFrame(o.time, flick) / flick);
  const phase = o.time ? o.time.phase : 0;
  const burst = p.speckBurst;
  // some frames are much worse than others (a bad stretch of tape), averaging out to 1
  const frameGain = 1 + burst * 0.7 * (3 * hash01(p.speckSeed * 7 + 3, epoch) ** 2 - 1);
  const bw = Math.min(0.5, Math.max(0.02, p.speckBandWidth));
  const bandMode = BAND_ID[p.speckBand] ?? 0;
  const meanW = bandMode === 2 ? 0.1 + 0.9 * bw : bandMode === 1 ? 0.1 + 0.9 * Math.min(1, 1.15 * bw) : 1;
  const lineH = Math.max(1e-3, 2 * o.unit);
  const thick = Math.max(0.1, p.speckThickness);
  const lenMin = Math.max(0.5, Math.min(p.speckLenMin, p.speckLenMax));
  const lenMax = Math.max(lenMin * 1.001, p.speckLenMax);
  const col = (c: number[]) => [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1];
  return {
    spAmt: Math.max(0, o.amount) * frameGain,
    spBurst: burst,
    spBandMode: bandMode,
    spBandC: (((p.speckBandPos + phase * Math.round(p.speckBandCycles)) % 1) + 1) % 1,
    spBandW: bw,
    spBandNorm: 1 / meanW,
    spLineH: lineH,
    spRowsMax: Math.max(1, Math.ceil(thick * 1.3)),
    spThick: thick,
    spShape: SHAPE_ID[p.speckShape] ?? 0,
    spLenMin: lenMin,
    spLenMax: lenMax,
    spTail: 0.35 + p.speckTail * 7,
    spColMode: COLOR_ID[p.speckColorMode] ?? 0,
    spColA: col(p.speckColor),
    spColB: col(p.speckColor2),
    spAlpha: p.speckAlpha,
    spBlend: BLEND_ID[p.speckBlend] ?? 0,
    spBright: p.speckBrightness,
    spChroma: p.speckChroma,
    spDark: p.speckDark,
    spSoft: p.speckSoft,
    spEpoch: epoch,
    spSeed: Math.round(p.speckSeed),
    spDriftX: (Math.round(p.speckDriftX) * phase) % 1, // fraction of the width; the shader scales it
    spDriftY: (Math.round(p.speckDriftY) * phase) % 1,
    spUnit: o.unit,
  };
}

/**
 * WGSL. Needs the uniforms of `speckUniforms` and a host pass with `u.size`. Provides:
 *   spField(px) -> SpHit   the strongest speck covering this pixel (cov 0 = none; d = texels from its head, for sampling a held colour)
 *   spApply(rgb, hit, held) -> vec3f   composites it (straight sRGB colour in, out)
 * `held` is the picture colour just before the speck starts (the hold of a dropped-out line).
 */
export const SPECKS_WGSL = /* wgsl */ `
struct SpHit { cov: f32, d: f32, r: f32, dark: f32 };
fn spPcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn spR(a: i32, b: u32, c: u32) -> f32 {
  let key = spPcg(u32(u.spSeed) * 2654435761u + spPcg(u32(u.spEpoch) + 0x9e3779b9u));
  let h = spPcg(spPcg(bitcast<u32>(a) ^ key) + b * 0x85ebca6bu + c * 0xc2b2ae35u);
  return f32(h >> 8u) / 16777216.0;
}
fn spBand(yc: f32) -> f32 {
  var w = 1.0;
  if (u.spBandMode > 1.5) {
    let d = abs(fract(yc - u.spBandC + 0.5) - 0.5);
    w = 0.1 + 0.9 * (1.0 - smoothstep(0.0, u.spBandW, d));
  } else if (u.spBandMode > 0.5) {
    w = 0.1 + 0.9 * smoothstep(1.0 - u.spBandW * 2.0, 1.0 - u.spBandW * 0.3, yc);
  }
  return w * u.spBandNorm;
}
fn spOverlap(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 { return clamp(min(a1, b1) - max(a0, b0), 0.0, 1.0e6); }
fn spField(px: vec2f) -> SpHit {
  let W = u.size.x;
  let H = u.size.y;
  var best = SpHit(0.0, 0.0, 0.0, 0.0);
  var xs = px.x - u.spDriftX * W;
  xs = xs - floor(xs / W) * W;
  var ys = px.y - u.spDriftY * H;
  ys = ys - floor(ys / H) * H;
  let lineH = u.spLineH;
  let un = u.spUnit;
  if (u.spShape < 3.5) {
    let nR = i32(u.spRowsMax);
    let rHi = i32(floor((ys + 1.0) / lineH));
    let rLo = i32(floor(ys / lineH)) - nR;
    for (var r = rLo; r <= rHi; r++) {
      let g = i32(floor(f32(r) / 6.0));
      let gh = spR(g, 0u, 11u);
      let wg = mix(1.0, pow(gh, 4.0) * 5.0, u.spBurst);
      let yc = clamp((f32(r) + 0.5) * lineH / H, 0.0, 1.0);
      let p = clamp(u.spAmt * 0.5 * 0.333 * wg * spBand(yc), 0.0, 0.9);
      for (var k = 0u; k < 3u; k++) {
        if (spR(r, k, 1u) >= p) { continue; }
        let rowsF = max(0.2, u.spThick * (0.7 + 0.6 * spR(r, k, 2u)));
        let y0 = f32(r) * lineH;
        let y1 = y0 + rowsF * lineH;
        if (y1 <= ys - 1.0 || y0 >= ys + 2.0) { continue; }
        var len = u.spLenMin * pow(u.spLenMax / u.spLenMin, pow(spR(r, k, 4u), 1.7));
        let centre = spR(g, 1u, 12u) * W;
        let spread = (spR(r, k, 6u) - 0.5) * 0.3 * W;
        var x0 = mix(spR(r, k, 5u) * W, clamp(centre + spread, 0.0, W), u.spBurst * 0.8);
        if (u.spShape > 2.5) {
          let cell = 4.0 * un;
          x0 = floor(x0 / cell) * cell;
          len = max(cell, floor(len * 0.5 / cell + 0.5) * cell);
        }
        let d = xs - x0;
        var cx = 0.0;
        var cy = 0.0;
        if (u.spShape > 1.5 && u.spShape < 2.5) {
          // dot: round, sized by the speck height
          let rad = max(0.8, 0.5 * (y1 - y0)) * (0.7 + 0.6 * spR(r, k, 13u));
          let cc = vec2f(x0 + rad, 0.5 * (y0 + y1));
          let e = length((vec2f(xs, ys + 0.5) - cc) / rad);
          cx = clamp((1.0 - e) * rad / (0.6 + u.spSoft * rad * 0.8) + 0.5, 0.0, 1.0);
          cy = 1.0;
        } else {
          let hw = select(0.5, 0.5 + u.spSoft * 2.0 * un, u.spShape < 2.5);
          let head = smoothstep(-hw, hw, d);
          if (u.spShape < 0.5) {
            let s = d / len;
            cx = head * exp(-max(s, 0.0) * u.spTail) * (1.0 - smoothstep(0.7, 1.0, s));
          } else {
            cx = head * (1.0 - smoothstep(len - hw, len + hw, d));
          }
          let core = spOverlap(y0, y1, ys, ys + 1.0);
          let sl = u.spSoft * lineH * 0.7;
          let halo = spOverlap(y0 - sl, y1 + sl, ys, ys + 1.0);
          cy = max(core, halo * 0.5 * min(1.0, u.spSoft * 2.0));
        }
        let nz = 0.86 + 0.14 * spR(i32(floor(xs / (1.5 * un))) + r * 131, k, 8u);
        let cov = cx * cy * (0.72 + 0.28 * spR(r, k, 7u)) * nz;
        if (cov > best.cov) {
          best = SpHit(cov, select(d, 0.0, u.spShape > 1.5 && u.spShape < 2.5), spR(r, k, 9u), select(0.0, 1.0, spR(r, k, 10u) < u.spDark));
        }
      }
    }
  } else {
    // scratch: vertical hair, one per column cell at most twice
    let cw = max(1.0, 2.0 * un);
    let wS = max(0.05, u.spThick * 0.5 * lineH);
    let cHi = i32(floor((xs + 1.0) / cw));
    let cLo = i32(floor(xs / cw)) - 2 - i32(ceil(wS / cw));
    for (var c = cLo; c <= cHi; c++) {
      let p = clamp(u.spAmt * 0.007 * mix(1.0, pow(spR(c / 8, 0u, 21u), 3.0) * 4.0, u.spBurst * 0.5), 0.0, 0.5);
      for (var k = 0u; k < 2u; k++) {
        if (spR(c, k, 20u) >= p) { continue; }
        let len = u.spLenMin * pow(u.spLenMax / u.spLenMin, pow(spR(c, k, 24u), 2.2)) * 4.0;
        let yS = spR(c, k, 22u) * H;
        let t = (ys - yS) / len;
        if (t < 0.0 || t > 1.0) { continue; }
        let wob = sin(ys / (40.0 * un) + spR(c, k, 23u) * 6.2832) * 0.7 * un;
        let xl = (f32(c) + spR(c, k, 25u)) * cw + wob;
        let ov = spOverlap(xl - u.spSoft * un, xl + wS + u.spSoft * un, xs, xs + 1.0);
        let cx = clamp(ov / min(1.0, wS + u.spSoft * 2.0 * un), 0.0, 1.0);
        let fade = smoothstep(0.0, 0.08 + u.spSoft * 0.2, t) * (1.0 - smoothstep(0.7, 1.0, t));
        let nz = 0.6 + 0.4 * spR(i32(floor(ys / (8.0 * un))) + c * 977, k, 26u);
        let cov = cx * fade * nz * (0.75 + 0.25 * spR(c, k, 27u));
        if (cov > best.cov) {
          best = SpHit(cov, 0.0, spR(c, k, 9u), select(0.0, 1.0, spR(c, k, 10u) < u.spDark));
        }
      }
    }
  }
  return best;
}
fn spApply(rgb: vec3f, hit: SpHit, held: vec3f) -> vec3f {
  let mode = u.spColMode;
  let a = clamp(hit.cov * u.spAlpha, 0.0, 1.0);
  let lumaC = vec3f(0.299, 0.587, 0.114);
  var col = vec3f(1.0);
  if (mode < 0.5) {
    col = mix(held, vec3f(1.0), u.spBright);
    col = col * (0.85 + 0.3 * dot(rgb, lumaC));
    col = mix(col, vec3f(dot(col, lumaC)), u.spChroma);
  } else if (mode < 1.5) {
    col = vec3f(1.0);
  } else if (mode < 2.5) {
    col = vec3f(0.0);
  } else if (mode < 3.5) {
    col = u.spColA;
  } else {
    col = mix(u.spColA, u.spColB, hit.r);
  }
  if (hit.dark > 0.5 && mode < 1.5) { col = held * 0.08; }
  col = clamp(col, vec3f(0.0), vec3f(1.0));
  let base = mix(rgb, vec3f(dot(rgb, lumaC)), u.spChroma * a);
  if (u.spBlend < 0.5) { return mix(base, col, a); }
  if (u.spBlend < 1.5) { return clamp(base + col * a, vec3f(0.0), vec3f(1.0)); }
  return vec3f(1.0) - (vec3f(1.0) - base) * (vec3f(1.0) - col * a);
}
`;
