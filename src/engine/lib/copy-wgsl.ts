/**
 * Shared WGSL + helpers for the "many copies of one picture" nodes (array, scatter, infinite-zoom, kaleidoscope).
 * Everything is analytic: the shader inverse-maps an output pixel into the copies that can reach it, so the cost does not grow
 * with the number of copies.
 */
import { GEN_HASH_WGSL } from './gen-common';

/** Number of time slices an Array can bind at once (distinct textures in the one pass). */
export const MAX_SLICES = 8;

export const COPY_COMMON_WGSL = /* wgsl */ `
${GEN_HASH_WGSL}
fn pmodi(a: i32, b: i32) -> i32 { let m = max(b, 1); return ((a % m) + m) % m; }
fn pmodf(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }
/** Undo a clockwise rotation by the angle whose cos / sin are given (screen y points down). */
fn unrot(d: vec2f, cs: f32, sn: f32) -> vec2f { return vec2f(d.x * cs + d.y * sn, -d.x * sn + d.y * cs); }
fn hueShift(rgb: vec3f, turns: f32) -> vec3f {
  if (turns == 0.0) { return rgb; }
  var h = rgbToHsv(rgb);
  h.x = fract(h.x + turns);
  return hsvToRgb(h);
}
/** Minification-safe fetch: 4 taps when the copy is shown smaller than the source; otherwise crisp (pixel art) or, when the shader uniform smoothTex is 1, plain bilinear (logos / photos enlarged by a non-whole factor). */
fn sampleCopy(t: texture_2d<f32>, uv: vec2f, tpp: f32) -> vec4f {
  if (tpp > 1.25) {
    let o = vec2f(0.25 * tpp) / vec2f(textureDimensions(t));
    return 0.25 * (textureSampleLevel(t, smp, uv + vec2f(-o.x, -o.y), 0.0) + textureSampleLevel(t, smp, uv + vec2f(o.x, -o.y), 0.0) +
                   textureSampleLevel(t, smp, uv + vec2f(-o.x, o.y), 0.0) + textureSampleLevel(t, smp, uv + vec2f(o.x, o.y), 0.0));
  }
  if (u.smoothTex > 0.5) { return textureSampleLevel(t, smp, uv, 0.0); }
  return sampleCrisp(t, uv, vec2f(tpp));
}
`;

/** Straight RGBA colour param -> vec4 uniform. */
export const rgba4 = (c: readonly number[]): [number, number, number, number] => [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1];

/** Degrees to radians. */
export const rad = (d: number): number => (d * Math.PI) / 180;
