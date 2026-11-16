/**
 * The art-grid rule (docs/ENGINE.md rule 28).
 *
 * An image with `cell > 1` is a crisp (nearest) upscale of an art grid: one art pixel covers `cell` texels. A per-pixel
 * pixel-art effect (dither, quantize, palette swap, mosaic) must work on that grid, not on the source texels: it is
 * hundreds of times cheaper (error diffusion at 4K is the difference between seconds and milliseconds) and the result is
 * chunky, as intended.
 *
 * Use `withArtGrid` and nothing else:
 *
 *   const image = withArtGrid(ctx.gpu, ctx.in.image, ctx.params.pixelSize, (art, { toArt }) => effect(art, toArt(ctx.params.scale)));
 *
 * `fn` gets the art-sized image and must return an image of EXACTLY that size. The helper point-samples the input at
 * cell centres, calls `fn`, crisp-upscales the result back to the input size and keeps `cell` on it. When the image is
 * not an art-grid image (and no explicit pixel size is given) `fn` simply gets the input itself and `toArt` is the
 * identity, so the node behaves as before.
 */
import type { ImageValue, NodeGpu, NumberParam } from '../types';

/** Below this the grid is not worth resampling (one art pixel is about one texel). */
const MIN_CELL = 1.01;

/** Shared `pixelSize` param (Dither, Quantize). 'px' unit: it arrives already in texels of the incoming image. */
export const PIXEL_SIZE_PARAM: NumberParam = {
  type: 'number',
  default: 0,
  min: 0,
  max: 256,
  softMax: 32,
  step: 1,
  integer: true,
  unit: 'px',
  label: 'Pixel size',
  hint: '0 = automatic: follow the incoming image (after a masked Pixelate the work happens on its pixel grid). Above 0 = work on a grid of this many unit pixels per art pixel, even on a full-resolution image. Chunky AND much faster, because the effect runs on the small grid and is scaled back up.',
};

/** The grid cell (texels per art pixel) in force: an explicit pixel size wins, otherwise the one the image carries. */
export function gridCell(image: { cell?: number }, pixelSizeTexels = 0): number {
  const c = pixelSizeTexels > 0 ? pixelSizeTexels : (image.cell ?? 1);
  return Number.isFinite(c) && c >= MIN_CELL ? c : 1;
}

/** Nearest-neighbour resize of `image` to `size` (crisp, no blur), with no `cell` stamped. */
export function crispResize(gpu: NodeGpu, image: ImageValue, size: { width: number; height: number; unit: number }): ImageValue {
  return gpu.pass({
    label: 'art-grid-resize',
    size,
    textures: { src: image },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return textureSampleLevel(src, smpNearest, uv, 0.0);
}`,
  });
}

/** Crisp-upscale an art grid to `size` and stamp `cell` on it. */
export function upscaleArtGrid(gpu: NodeGpu, art: ImageValue, size: { width: number; height: number; unit: number }, cell: number): ImageValue {
  const up = crispResize(gpu, art, size);
  return cell >= MIN_CELL ? { ...up, cell } : up;
}

export interface ArtGridInfo {
  /** Texels of the input per art pixel (1 when the node is not working on a grid). */
  cell: number;
  /** True when `fn` runs on a reduced grid. */
  active: boolean;
  /** Convert a length in texels of the INPUT image (what 'px' params arrive as) to texels of the grid image. */
  toArt(texels: number): number;
}

/**
 * Run `fn` on the art grid of `image`. `pixelSizeTexels` = the node's `pixelSize` param (already converted to texels; 0 = follow the image).
 */
export function withArtGrid(gpu: NodeGpu, image: ImageValue, pixelSizeTexels: number, fn: (art: ImageValue, info: ArtGridInfo) => ImageValue): ImageValue {
  const cell = gridCell(image, pixelSizeTexels);
  if (cell <= 1) return fn(image, { cell: 1, active: false, toArt: (t) => t });

  const width = Math.max(1, Math.round(image.width / cell));
  const height = Math.max(1, Math.round(image.height / cell));
  const grid = { width, height, unit: image.unit / cell };
  // Point-sample at the cell centres (the pass's uv of art pixel i is its centre).
  const art = crispResize(gpu, image, grid);
  const result = fn(art, { cell, active: true, toArt: (t) => t / cell });
  if (result.width !== width || result.height !== height) {
    throw new Error(`art grid: the effect returned ${result.width}x${result.height} but the grid is ${width}x${height}`);
  }
  const up = upscaleArtGrid(gpu, result, { width: image.width, height: image.height, unit: image.unit }, cell);
  if (result !== art) gpu.recycle(result);
  gpu.recycle(art);
  return up;
}
