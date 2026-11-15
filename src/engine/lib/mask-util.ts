/**
 * Shared GPU helpers for the mask / layer nodes: resampling, morphology (square and
 * exact-round via jump flooding), mask blur and a joint-bilateral "snap to image edges" filter.
 */
import { gaussianBlur } from '../nodes/filter/blur.node';
import type { ImageValue, MaskValue, NodeGpu } from '../types';

export type Tex = ImageValue | MaskValue;

export const asImage = (t: Tex): ImageValue => ({ ...t, kind: 'image' });
export const asMask = (t: Tex): MaskValue => ({ ...t, kind: 'mask' });

const COPY = 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }';

/** Bilinear resample to an exact size (unit scales with the width). */
export function resample(gpu: NodeGpu, src: Tex, width: number, height: number): ImageValue {
  return gpu.pass({
    label: 'mask-resample',
    size: { width, height, unit: src.unit * (width / src.width) },
    textures: { src },
    wgsl: COPY,
  });
}

/** Halve repeatedly (exact 2x2 box averages) until the long side is <= maxSide. Returns src if already small. */
export function shrinkTo(gpu: NodeGpu, src: Tex, maxSide: number): ImageValue {
  let cur: Tex = src;
  while (Math.max(cur.width, cur.height) > maxSide) {
    cur = resample(gpu, cur, Math.max(1, Math.ceil(cur.width / 2)), Math.max(1, Math.ceil(cur.height / 2)));
  }
  return asImage(cur);
}

/** Downscale so the long side is exactly <= maxSide (halving passes, then one bilinear step). Returns src when already small. */
export function fitTo(gpu: NodeGpu, src: Tex, maxSide: number): ImageValue {
  const pre = shrinkTo(gpu, src, maxSide * 2);
  const long = Math.max(pre.width, pre.height);
  if (long <= maxSide) return pre;
  const k = maxSide / long;
  return resample(gpu, pre, Math.max(1, Math.round(pre.width * k)), Math.max(1, Math.round(pre.height * k)));
}

/** Single-channel mask pass: `fx` must return vec4f(c, c, c, 1). */
export const MASK_OUT = (expr: string): string => `vec4f(vec3f(${expr}), 1.0)`;

/** Separable square min/max, radius in texels (<= 48). Keeps soft values. */
export function morphSquare(gpu: NodeGpu, mask: Tex, radius: number, dilate: boolean): MaskValue {
  const r = Math.min(48, Math.round(radius));
  if (r < 1) return asMask(mask);
  const wgsl = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = u.dir / vec2f(textureDimensions(src));
  var v = textureSampleLevel(src, smpNearest, uv, 0.0).r;
  for (var i = 1; i <= i32(u.rad); i++) {
    let a = textureSampleLevel(src, smpNearest, uv + texel * f32(i), 0.0).r;
    let b = textureSampleLevel(src, smpNearest, uv - texel * f32(i), 0.0).r;
    ${dilate ? 'v = max(v, max(a, b));' : 'v = min(v, min(a, b));'}
  }
  return vec4f(vec3f(v), 1.0);
}`;
  const h = gpu.pass({ label: 'morph-h', size: mask, textures: { src: mask }, uniforms: { dir: [1, 0], rad: r }, wgsl });
  return gpu.passMask({ label: 'morph-v', size: mask, textures: { src: h }, uniforms: { dir: [0, 1], rad: r }, wgsl });
}

/**
 * Grow (positive) or shrink (negative) a mask by `px` texels with an exact round structuring element
 * (jump flooding distance transform). Soft edges survive: dilate = max(mask, ramp), erode = min(mask, ramp).
 */
export function growMask(gpu: NodeGpu, mask: Tex, px: number): MaskValue {
  const r = Math.abs(px);
  if (r < 0.01) return asMask(mask);
  const dilate = px > 0;
  const size = { width: mask.width, height: mask.height, unit: mask.unit };
  let seeds = gpu.pass({
    label: 'jfa-init',
    size,
    format: 'rgba16float',
    textures: { src: mask },
    uniforms: { inv: dilate ? 0 : 1 },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let m = textureSampleLevel(src, smpNearest, uv, 0.0).r;
  let fgSeed = m >= 0.5;
  let bgSeed = m < 0.5;
  let isSeed = select(fgSeed, bgSeed, u.inv > 0.5);
  return select(vec4f(1.0e4, 1.0e4, 0.0, 0.0), vec4f(0.0), isSeed);
}`,
  });
  let step = 1;
  while (step < Math.ceil(r) + 1) step *= 2;
  const stepWgsl = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(src));
  let ip = vec2i(floor(px));
  var best = textureLoad(src, ip, 0).xy;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let o = vec2i(dx, dy) * i32(u.stepSize);
      let q = ip + o;
      if (q.x < 0 || q.y < 0 || q.x >= dims.x || q.y >= dims.y) { continue; }
      let v = textureLoad(src, q, 0).xy;
      if (abs(v.x) > 5000.0) { continue; }
      let cand = vec2f(o) + v;
      if (dot(cand, cand) < dot(best, best)) { best = cand; }
    }
  }
  return vec4f(best, 0.0, 0.0);
}`;
  for (let s = step; s >= 1; s = Math.floor(s / 2)) {
    seeds = gpu.pass({ label: 'jfa-step', size, format: 'rgba16float', textures: { src: seeds }, uniforms: { stepSize: s }, wgsl: stepWgsl });
    if (s === 1) {
      seeds = gpu.pass({ label: 'jfa-step', size, format: 'rgba16float', textures: { src: seeds }, uniforms: { stepSize: 1 }, wgsl: stepWgsl });
    }
  }
  return gpu.passMask({
    label: 'jfa-final',
    size,
    textures: { src: mask, seed: seeds },
    uniforms: { rad: r, dil: dilate },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let m = textureSampleLevel(src, smpNearest, uv, 0.0).r;
  let o = textureLoad(seed, vec2i(floor(px)), 0).xy;
  let known = abs(o.x) < 5000.0;
  let d = select(1.0e4, length(o), known);
  if (u.dil > 0.5) { return vec4f(vec3f(max(m, clamp(u.rad + 0.5 - d, 0.0, 1.0))), 1.0); }
  return vec4f(vec3f(min(m, clamp(d - u.rad + 0.5, 0.0, 1.0))), 1.0);
}`,
  });
}

/** Gaussian blur of a mask (texels). */
export function blurMask(gpu: NodeGpu, mask: Tex, radius: number): MaskValue {
  if (radius < 0.05) return asMask(mask);
  return asMask(gaussianBlur(gpu, asImage(mask), radius));
}

/**
 * Joint-bilateral smoothing of `value` (a mask or image, any size) guided by `guide` (full image).
 * Output has the guide's size, so it doubles as an edge-aware upsampler. Each pass averages a 7x7 tap grid
 * weighted by spatial distance and by colour similarity to the centre pixel, which snaps soft masks to colour edges.
 */
export function guidedSmooth(
  gpu: NodeGpu,
  value: Tex,
  guide: ImageValue,
  opts: { radius: number; colorSigma?: number; iterations?: number },
): MaskValue {
  const iterations = Math.max(1, opts.iterations ?? 2);
  const radius = Math.max(1, opts.radius);
  const wgsl = /* wgsl */ `
fn gcol(uv: vec2f) -> vec3f {
  let c = unpremul(textureSampleLevel(guide, smp, uv, 0.0));
  return srgbToOklab(c.rgb);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let center = gcol(uv);
  let step = u.rad / 3.0;
  let inv = 1.0 / u.size;
  var acc = 0.0;
  var tot = 0.0;
  for (var j = -3; j <= 3; j++) {
    for (var i = -3; i <= 3; i++) {
      let o = vec2f(f32(i), f32(j));
      let q = uv + o * step * inv;
      let ds = dot(o, o) / 9.0;
      let dc = gcol(q) - center;
      let w = exp(-ds * 0.7 - dot(dc, dc) / (u.csig * u.csig));
      acc += w * textureSampleLevel(val, smp, q, 0.0).r;
      tot += w;
    }
  }
  return vec4f(vec3f(acc / max(tot, 1e-6)), 1.0);
}`;
  let cur: Tex = value;
  for (let i = 0; i < iterations; i++) {
    cur = gpu.pass({
      label: 'guided-smooth',
      size: guide,
      textures: { val: cur, guide },
      uniforms: { rad: radius * (i === 0 ? 1 : 0.7), csig: opts.colorSigma ?? 0.12 },
      wgsl,
      format: 'rgba16float',
    });
  }
  return gpu.passMask({
    label: 'guided-out',
    size: guide,
    textures: { src: cur },
    wgsl: COPY,
  });
}
