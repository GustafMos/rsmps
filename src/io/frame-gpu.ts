import type { Gpu } from '../engine/gpu/gpu';
import type { ImageValue, MaskValue } from '../engine/types';
import { conformRect, type ConformAnchor, type ConformMode, type Size } from './frame';

/**
 * Fit an image into a frame: scale, crop or pad on the GPU. Enlarging is nearest-crisp (`sampleCrisp`),
 * shrinking is smooth. Returns the input itself when nothing needs to change. The result is NOT retained:
 * retain it right away if it must outlive the current task.
 */
export function conformImage(
  gpu: Gpu,
  img: ImageValue | MaskValue,
  dst: Size,
  mode: Exclude<ConformMode, 'auto'>,
  anchor: ConformAnchor,
): ImageValue | MaskValue {
  const rect = conformRect(img, dst, mode, anchor);
  if (!rect) return img;
  const out = gpu.pass({
    label: 'conform',
    size: { width: dst.width, height: dst.height, unit: img.unit * (rect.w / img.width) },
    textures: { src: img },
    uniforms: { rect: [rect.x, rect.y, rect.w, rect.h] },
    wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let l = (px - u.rect.xy) / u.rect.zw;
  if (l.x < 0.0 || l.x > 1.0 || l.y < 0.0 || l.y > 1.0) { return vec4f(0.0); }
  let tpp = vec2f(textureDimensions(src)) / u.rect.zw;
  return sampleCrisp(src, l, tpp);
}`,
  });
  return { ...out, kind: img.kind } as ImageValue | MaskValue;
}
