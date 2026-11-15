/**
 * Shared WGSL for sampling an image with an edge mode and exact texel access.
 * Edge modes: 0 transparent, 1 clamp, 2 wrap (repeat), 3 mirror.
 * Include EDGE_WGSL in a shader; call `edgeSample(tex, texelPos, mode, linear)` where
 * `texelPos` is in texel coordinates (0..width, 0..height, texel centres at +0.5).
 */
export const EDGE_MODES = [
  { value: 'transparent', label: 'Transparent' },
  { value: 'clamp', label: 'Stretch edge pixels' },
  { value: 'wrap', label: 'Repeat' },
  { value: 'mirror', label: 'Mirror' },
] as const;

export function edgeModeIndex(value: string): number {
  const i = EDGE_MODES.findIndex((m) => m.value === value);
  return i < 0 ? 0 : i;
}

export const EDGE_WGSL = /* wgsl */ `
fn edgeFetch(tex: texture_2d<f32>, p: vec2i, mode: i32) -> vec4f {
  let d = vec2i(textureDimensions(tex));
  var q = p;
  if (mode == 0) {
    if (p.x < 0 || p.y < 0 || p.x >= d.x || p.y >= d.y) { return vec4f(0.0); }
  } else if (mode == 1) {
    q = clamp(p, vec2i(0), d - vec2i(1));
  } else if (mode == 2) {
    q = ((p % d) + d) % d;
  } else {
    let per = d * 2;
    let m = ((p % per) + per) % per;
    q = vec2i(select(m.x, per.x - 1 - m.x, m.x >= d.x), select(m.y, per.y - 1 - m.y, m.y >= d.y));
  }
  return textureLoad(tex, q, 0);
}
fn edgeNearest(tex: texture_2d<f32>, s: vec2f, mode: i32) -> vec4f {
  return edgeFetch(tex, vec2i(floor(s)), mode);
}
fn edgeLinear(tex: texture_2d<f32>, s: vec2f, mode: i32) -> vec4f {
  let f = s - 0.5;
  let b = floor(f);
  let w = f - b;
  let i = vec2i(b);
  let a0 = mix(edgeFetch(tex, i, mode), edgeFetch(tex, i + vec2i(1, 0), mode), w.x);
  let a1 = mix(edgeFetch(tex, i + vec2i(0, 1), mode), edgeFetch(tex, i + vec2i(1, 1), mode), w.x);
  return mix(a0, a1, w.y);
}
fn edgeSample(tex: texture_2d<f32>, s: vec2f, mode: i32, linear: bool) -> vec4f {
  if (linear) { return edgeLinear(tex, s, mode); }
  return edgeNearest(tex, s, mode);
}
`;

/** Straight sRGB colour → premultiplied components for a uniform. */
export function premulColor(c: readonly number[]): [number, number, number, number] {
  const a = c[3] ?? 1;
  return [c[0] * a, c[1] * a, c[2] * a, a];
}
