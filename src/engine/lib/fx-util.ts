import type { NodeGpu, PaletteValue, TimeInfo } from '../types';

/** Upload a palette as an Nx1 lookup texture (sRGB floats). Read in WGSL with textureLoad(pal, vec2i(i, 0), 0). */
export function paletteTexture(gpu: NodeGpu, colors: PaletteValue['colors']): { texture: GPUTexture } {
  const data = new Float32Array(colors.length * 4);
  colors.forEach((c, i) => data.set([c[0], c[1], c[2], 1], i * 4));
  return gpu.dataTexture(data, colors.length, 1);
}

/**
 * Looping frame index for per-frame randomness (grain, jitter): quantised to the project's frame count
 * and wrapped, so the last frame is followed by frame 0 with no seam. `hold` repeats a value for N frames.
 * Reading it marks the node time-dependent.
 */
export function loopFrame(time: TimeInfo, hold = 1): number {
  const total = Math.max(1, Math.round(time.duration * time.fps));
  const f = Math.floor(time.phase * total + 1e-6) % total;
  const h = Math.max(1, Math.round(hold));
  return f - (f % h);
}

/**
 * WGSL: Sobel gradient of a texture. Returns vec2(luma gradient, alpha gradient), each ~0..1 for a full-scale step.
 * `o` is the tap offset in uv units. Works on premultiplied images so transparent sprites yield alpha edges.
 */
export const SOBEL_WGSL = /* wgsl */ `
fn tapLA(t: texture_2d<f32>, uv: vec2f) -> vec2f {
  let s = textureSampleLevel(t, smp, uv, 0.0);
  return vec2f(luma(s.rgb), s.a);
}
fn sobel2(t: texture_2d<f32>, uv: vec2f, o: vec2f) -> vec2f {
  let a = tapLA(t, uv + vec2f(-o.x, -o.y)); let b = tapLA(t, uv + vec2f(0.0, -o.y)); let c = tapLA(t, uv + vec2f(o.x, -o.y));
  let d = tapLA(t, uv + vec2f(-o.x, 0.0));                                          let f = tapLA(t, uv + vec2f(o.x, 0.0));
  let g = tapLA(t, uv + vec2f(-o.x, o.y));  let h = tapLA(t, uv + vec2f(0.0, o.y));  let i = tapLA(t, uv + vec2f(o.x, o.y));
  let gx = (c + 2.0 * f + i) - (a + 2.0 * d + g);
  let gy = (g + 2.0 * h + i) - (a + 2.0 * b + c);
  return vec2f(length(vec2f(gx.x, gy.x)), length(vec2f(gx.y, gy.y))) * 0.25;
}`;
