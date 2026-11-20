/**
 * WGSL helpers available in every `gpu.pass` shader.
 * Colours in textures are sRGB-encoded and premultiplied.
 */
export const PRELUDE = /* wgsl */ `
const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

fn unpremul(c: vec4f) -> vec4f { if (c.a <= 0.00001) { return vec4f(0.0); } return vec4f(c.rgb / c.a, c.a); }
fn premul(c: vec4f) -> vec4f { return vec4f(c.rgb * c.a, c.a); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn saturate1(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn srgbToLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((max(c, vec3f(0.0)) + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}
fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn linearToOklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(l, 0.0), 1.0 / 3.0); let m_ = pow(max(m, 0.0), 1.0 / 3.0); let s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
fn oklabToLinear(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_; let m = m_ * m_ * m_; let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
fn srgbToOklab(c: vec3f) -> vec3f { return linearToOklab(srgbToLinear(c)); }
fn oklabToSrgb(c: vec3f) -> vec3f { return linearToSrgb(oklabToLinear(c)); }

fn rgbToHsv(c: vec3f) -> vec3f {
  let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, k.wz), vec4f(c.gb, k.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
fn hsvToRgb(c: vec3f) -> vec3f {
  let p = abs(fract(c.xxx + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn hash22(p: vec2f) -> vec2f { return vec2f(hash21(p), hash21(p + 17.17)); }
fn hash31(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

/**
 * Smooth value noise, 0..1.
 *
 * The corners of a noise square are numbered with whole numbers (vec2i / vec3i) and only then turned into the
 * decimal numbers the hash takes. Written as hash(floor(p) + vec(1, 0)) a graphics driver is free to merge that
 * "+ 1" into the first multiplication inside the hash (a fused multiply-add), which rounds a hair differently from
 * hashing the same corner as some other square's floor(p). The hash ends in a fract, so a hair is enough to
 * flip it from 0.999 to 0.001: one corner then has two values and a square of the noise shows a hard edge.
 * A whole-number addition cannot be merged or rounded, so every square now feeds the hash the identical number.
 */
fn latticeHash2(i: vec2i) -> f32 { return hash21(vec2f(i)); }
fn latticeHash3(i: vec3i) -> f32 { return hash31(vec3f(i)); }
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(latticeHash2(i), latticeHash2(i + vec2i(1, 0)), w.x),
             mix(latticeHash2(i + vec2i(0, 1)), latticeHash2(i + vec2i(1, 1)), w.x), w.y);
}
fn vnoise3(p: vec3f) -> f32 {
  let i = vec3i(floor(p)); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(latticeHash3(i), latticeHash3(i + vec3i(1, 0, 0)), w.x), mix(latticeHash3(i + vec3i(0, 1, 0)), latticeHash3(i + vec3i(1, 1, 0)), w.x), w.y),
    mix(mix(latticeHash3(i + vec3i(0, 0, 1)), latticeHash3(i + vec3i(1, 0, 1)), w.x), mix(latticeHash3(i + vec3i(0, 1, 1)), latticeHash3(i + vec3i(1, 1, 1)), w.x), w.y),
    w.z);
}
/**
 * Noise that loops seamlessly in time: phase 0..1 travels once around a circle,
 * so phase 0 and phase 1 give the identical field. 'speed' = how far the field evolves per loop.
 */
fn loopNoise(p: vec2f, phase: f32, speed: f32) -> f32 {
  let a = phase * TAU;
  let r = max(speed, 0.0001) / TAU;
  let n1 = vnoise3(vec3f(p, cos(a) * r));
  let n2 = vnoise3(vec3f(p + vec2f(37.2, 91.7), sin(a) * r));
  return clamp((n1 + n2) * 0.5 * 1.4 - 0.2, 0.0, 1.0);
}
`;

/**
 * Helpers that need the samplers of a full-screen pass (`smp`, `smpNearest`). Included by `gpu.pass` only,
 * so the plain PRELUDE stays usable in compute shaders.
 */
export const PASS_PRELUDE = /* wgsl */ `
/**
 * Scale-aware sampling for placing one image inside another. Enlarging keeps texels as crisp squares with
 * one-pixel anti-aliased edges (pixel art stays pixel art); shrinking blends smoothly.
 * texelsPerPixel = source texels covered by one output pixel on each axis (< 1 means enlarging).
 * ALWAYS use this instead of plain linear sampling when a node scales or repositions an image.
 */
fn sampleCrisp(t: texture_2d<f32>, uv: vec2f, texelsPerPixel: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(t));
  let p = uv * size;
  let seam = floor(p + 0.5);
  let q = seam + clamp((p - seam) / max(texelsPerPixel, vec2f(0.0001)), vec2f(-0.5), vec2f(0.5));
  return textureSampleLevel(t, smp, q / size, 0.0);
}

`;
