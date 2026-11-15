/**
 * GPU → CPU glue for detectors: reduce a strength mask to a fixed analysis grid, read it back and
 * label connected components. The grid is ALWAYS 256 texels on the long side, whatever the input size,
 * so a 2x larger copy of an image produces (nearly) identical normalised regions.
 */
import type { ImageValue, MaskValue, NodeGpu, Region } from '../types';
import { componentsToRegions, labelComponents, type DetectOptions } from './track-core';

export const ANALYSIS_LONG = 256;

export function analysisSize(w: number, h: number): { width: number; height: number } {
  const s = ANALYSIS_LONG / Math.max(1, Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Box-filter resample to the analysis grid (area average when shrinking, linear when growing). */
export function toAnalysisGrid(gpu: NodeGpu, src: ImageValue | MaskValue): ImageValue {
  const size = analysisSize(src.width, src.height);
  const foot = Math.max(src.width / size.width, src.height / size.height);
  return gpu.pass({
    label: 'track-analysis-grid',
    size: { ...size, unit: 1 },
    textures: { src },
    uniforms: { taps: Math.min(8, Math.max(1, Math.ceil(foot))) },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let foot = dims / u.size;
  let n = i32(u.taps);
  var acc = vec4f(0.0);
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / u.taps - 0.5;
      acc += textureSampleLevel(src, smp, uv + o * foot / dims, 0.0);
    }
  }
  return acc / (u.taps * u.taps);
}`,
  });
}

/** Detect regions in a strength mask (red channel, 0.5 = on/off boundary). */
export async function regionsFromStrength(gpu: NodeGpu, strength: ImageValue | MaskValue, o: DetectOptions, label: string): Promise<Region[]> {
  const grid = toAnalysisGrid(gpu, strength);
  const data = await gpu.read(grid, false);
  const comps = labelComponents(data, grid.width, grid.height, 128);
  return componentsToRegions(comps, grid.width, grid.height, o, label);
}
