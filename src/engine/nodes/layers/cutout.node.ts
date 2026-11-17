import { defineNode } from '../../define';
import { pushPull } from '../../lib/mask-pushpull';
import { blurMask, growMask, resample, type Tex } from '../../lib/mask-util';
import type { ImageValue, NodeGpu } from '../../types';

export interface CutoutOptions {
  /** Texels to erode the matte by (kills the halo of the old background). */
  shrink: number;
  /** Texels of blur applied to the matte edge. */
  feather: number;
  /** 0..1: replace the colour of semi-transparent edge pixels with colour pulled from the solid interior. */
  decontaminate: number;
}

/** alpha = alpha x mask, with optional edge shrink, feather and colour decontamination. Exported for `split-layers`. */
export function cutoutImage(gpu: NodeGpu, image: ImageValue, mask: Tex, o: CutoutOptions): ImageValue {
  let m: Tex = mask.width === image.width && mask.height === image.height ? mask : resample(gpu, mask, image.width, image.height);
  if (o.shrink > 0.01) m = growMask(gpu, m, -o.shrink);
  if (o.feather > 0.05) m = blurMask(gpu, m, o.feather);

  let clean: ImageValue | null = null;
  if (o.decontaminate > 0.001) {
    // Trusted colour = well inside the matte; everything else is interpolated from it.
    const trusted = gpu.passMask({
      label: 'cutout-trusted',
      size: image,
      textures: { m },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(smoothstep(0.9, 0.995, textureSampleLevel(m, smpNearest, uv, 0.0).r)), 1.0); }',
    });
    clean = pushPull(gpu, image, trusted, { relax: 1, fineRelax: 3, useAlpha: true });
  }
  return gpu.pass({
    label: 'cutout',
    size: image,
    textures: { src: image, m, clean },
    uniforms: { decon: o.decontaminate },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let cov = clamp(textureSampleLevel(m, smp, uv, 0.0).r, 0.0, 1.0);
  var rgb = s.rgb;
  ${clean ? 'rgb = mix(rgb, textureSampleLevel(clean, smpNearest, uv, 0.0).rgb, u.decon * (1.0 - smoothstep(0.5, 1.0, cov)));' : ''}
  return premul(vec4f(rgb, s.a * cov));
}`,
  });
}

export default defineNode({
  id: 'cutout',
  title: 'Cutout',
  category: 'composite',
  description: 'Applies a mask as the image alpha (alpha x mask), with optional edge shrink, feather and color decontamination of the fringe.',
  keywords: ['alpha', 'matte', 'knockout', 'remove background', 'transparent', 'extract', 'apply mask'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    mask: { type: 'mask', required: true, label: 'Mask' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    invert: { type: 'bool', default: false, label: 'Invert mask' },
    shrink: { type: 'number', default: 0, min: 0, max: 50, step: 0.25, unit: 'px', label: 'Shrink edge' },
    feather: { type: 'number', default: 0, min: 0, max: 50, step: 0.25, unit: 'px', label: 'Feather' },
    decontaminate: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Decontaminate', hint: 'Replaces the color of semi-transparent edge pixels with color from the inside of the subject.' },
  },
  summary: (p) => (p.invert ? 'inverted' : 'alpha × mask'),
  render(ctx) {
    let { mask } = ctx.in;
    if (ctx.params.invert) {
      mask = ctx.gpu.passMask({
        label: 'cutout-invert',
        size: mask,
        textures: { src: mask },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(1.0 - textureSampleLevel(src, smpNearest, uv, 0.0).r), 1.0); }',
      });
    }
    return { image: cutoutImage(ctx.gpu, ctx.in.image, mask, ctx.params) };
  },
});
