/**
 * GPU side of the palette nodes: upload a palette as a lookup texture and WGSL helpers that find the
 * nearest palette colour. Used by quantize, dither and palette-swap.
 *
 * Texture layout (rgba16float, N×2):
 *   row 0: sRGB colour (rgb) + lightness key (a, OKLab L: sorts candidates dark → light)
 *   row 1: the colour in the matching space (OKLab / linear RGB / sRGB)
 *
 * A shader using PALETTE_WGSL must bind the texture as `pal` and declare uniforms
 * `palCount` and `colorSpace` (0 = OKLab, 1 = linear RGB, 2 = sRGB).
 */
import type { NodeGpu } from '../types';
import { srgbToOklab, toSpace, type DitherSpace, type Rgb } from './pixel-color';

export const MAX_PALETTE = 1024;

export const SPACE_OPTIONS = [
  { value: 'oklab', label: 'OKLab' },
  { value: 'linear', label: 'Linear RGB' },
  { value: 'srgb', label: 'RGB' },
] as const;

export const SPACE_INDEX: Record<DitherSpace, number> = { oklab: 0, linear: 1, srgb: 2 };

export function clampPalette(colors: readonly Rgb[]): Rgb[] {
  return colors.slice(0, MAX_PALETTE).map((c) => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])] as Rgb);
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function paletteTexture(gpu: NodeGpu, colors: readonly Rgb[], space: DitherSpace): { texture: GPUTexture } {
  const pal = clampPalette(colors);
  const n = Math.max(1, pal.length);
  const data = new Float32Array(n * 2 * 4);
  pal.forEach((c, i) => {
    const s = toSpace(c, space);
    data.set([c[0], c[1], c[2], srgbToOklab(c)[0]], i * 4);
    data.set([s[0], s[1], s[2], 0], (n + i) * 4);
  });
  return gpu.dataTexture(data, n, 2);
}

/**
 * Threshold matrix as a texture (value in the red channel). The matrix is tiled up to at least 32 texels per
 * side (a whole number of periods), which keeps texture shapes uniform and the lookup a plain modulo.
 */
export function matrixTexture(gpu: NodeGpu, width: number, height: number, values: Float32Array): { texture: GPUTexture; width: number; height: number } {
  const w = width * Math.ceil(32 / width);
  const h = height * Math.ceil(32 / height);
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[(y * w + x) * 4] = values[(y % height) * width + (x % width)];
  }
  return { ...gpu.dataTexture(data, w, h), width: w, height: h };
}

export const PALETTE_WGSL = /* wgsl */ `
fn toSpace(c: vec3f) -> vec3f {
  let space = i32(u.colorSpace);
  if (space == 0) { return srgbToOklab(c); }
  if (space == 1) { return srgbToLinear(c); }
  return c;
}
fn spaceDist(a: vec3f, b: vec3f) -> f32 {
  let d = a - b;
  if (i32(u.colorSpace) == 0) { return d.x * d.x + 1.6 * (d.y * d.y + d.z * d.z); }
  return 0.3 * d.x * d.x + 0.59 * d.y * d.y + 0.11 * d.z * d.z;
}
fn palSrgb(i: i32) -> vec3f { return textureLoad(pal, vec2i(i, 0), 0).rgb; }
fn palKey(i: i32) -> f32 { return textureLoad(pal, vec2i(i, 0), 0).a; }
fn palSpace(i: i32) -> vec3f { return textureLoad(pal, vec2i(i, 1), 0).rgb; }
fn nearestIdx(c: vec3f) -> i32 {
  var best = 0;
  var bestD = 1e30;
  let n = i32(u.palCount);
  for (var i = 0; i < n; i++) {
    let d = spaceDist(c, palSpace(i));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
`;


/** Largest texture the pixel nodes will create: 64 megapixels (256 MB at RGBA8). */
export const MAX_PIXELS = 64_000_000;

/** Throws a readable error instead of creating a texture the device cannot hold or that would exhaust memory. */
export function assertTextureSize(gpu: NodeGpu, width: number, height: number, what: string): void {
  const limit = gpu.device.limits.maxTextureDimension2D;
  if (width > limit || height > limit) {
    throw new Error(`${what}: ${width}x${height} is larger than this device supports (${limit} px per side). Use a smaller value.`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`${what}: ${width}x${height} is ${Math.round((width * height) / 1e6)} megapixels, over the ${MAX_PIXELS / 1e6} MP limit. Use a smaller value.`);
  }
}
