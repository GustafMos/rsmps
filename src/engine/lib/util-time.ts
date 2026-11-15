import type { ImageValue, NodeGpu } from '../types';

/** Positive modulo (JS % keeps the sign of the dividend). */
export function mod(a: number, b: number): number {
  if (!(b > 0)) return a;
  return ((a % b) + b) % b;
}

/** Wrap a time into [0, duration) on the project's frame grid, so a trail or blend loops with the project. */
export function wrapSeconds(seconds: number, duration: number, fps: number): number {
  const total = Math.max(1, Math.round(duration * fps));
  return mod(Math.round(seconds * fps), total) / fps;
}

/**
 * Blend several same-sized images. 'average' = weighted average (running mean in 16-bit float),
 * 'lighten' = brightest wins after fading each image by its weight (trails).
 * The first image defines size and unit.
 */
export function blendImages(gpu: NodeGpu, images: ImageValue[], weights: number[], mode: 'average' | 'lighten'): ImageValue {
  const used = images.map((img, i) => ({ img, w: weights[i] })).filter((e, i) => i === 0 || e.w > 0);
  let acc = used[0].img;
  let total = used[0].w;
  for (let i = 1; i < used.length; i++) {
    const { img, w } = used[i];
    const last = i === used.length - 1;
    const k = mode === 'average' ? w / (total + w) : w;
    total += w;
    acc = gpu.pass({
      label: 'blend-images',
      size: images[0],
      textures: { ta: acc, tb: img },
      uniforms: { k },
      format: last ? 'rgba8unorm' : 'rgba16float',
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(ta, smpNearest, uv, 0.0);
  let b = textureSampleLevel(tb, smp, uv, 0.0);
  ${mode === 'average' ? 'return mix(a, b, u.k);' : 'return max(a, b * u.k);'}
}`,
    });
  }
  return acc;
}
