import { defineNode } from '../../define';
import { pushPull } from '../../lib/mask-pushpull';
import { blurMask, growMask, morphSquare, resample, type Tex } from '../../lib/mask-util';
import type { ImageValue, MaskValue, NodeGpu } from '../../types';

export interface FillOptions {
  /** 0..1: Jacobi relaxation on top of the push-pull (smoother, slower). */
  smoothness: number;
  /** 0..1: how much real grain from the surroundings is put back into the filled area. */
  texture: number;
  /** Optional directional bias (radians, 0 = horizontal) and strength 0..1. */
  direction?: { angle: number; amount: number };
  /** Also interpolate the alpha channel (so holes in transparent cut-outs get filled too). Default true. */
  fillAlpha?: boolean;
  /** Coverage used to composite the fill over the source (default: 1 - valid). Lets callers feather the seam. */
  holeCoverage?: Tex;
}

/**
 * Fill every texel where `valid` (coverage, 1 = trusted pixel) is low from the trusted pixels around it.
 *
 *  1. push-pull pyramid + relaxation (lib/mask-pushpull): the hole becomes a smooth interpolation between its edge pixels;
 *  2. grain: the high-frequency residual (image minus a 3x3 blur) of trusted pixels is copied into the hole in coherent
 *     patches taken from random nearby trusted locations, so the fill is not plastic;
 *  3. composite by hole coverage.
 *
 * Shared by `inpaint`, `split-layers` and `depth-slice`.
 */
export function fillFromValid(gpu: NodeGpu, image: ImageValue, valid: Tex, opts: FillOptions): ImageValue {
  const vm = valid.width === image.width && valid.height === image.height ? valid : resample(gpu, valid, image.width, image.height);
  const s = Math.min(1, Math.max(0, opts.smoothness));
  const dir = opts.direction ? { angle: opts.direction.angle, amount: opts.direction.amount } : undefined;
  const filled = pushPull(gpu, image, vm, { relax: Math.round(1 + 3 * s), fineRelax: Math.round(2 + 14 * s), direction: dir, useAlpha: true });

  let alphaFill: ImageValue | null = null;
  if (opts.fillAlpha !== false) {
    const alphaImg = gpu.pass({
      label: 'fill-alpha',
      size: image,
      textures: { src: image },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let a = textureSampleLevel(src, smpNearest, uv, 0.0).a; return vec4f(a, a, a, 1.0); }',
    });
    alphaFill = pushPull(gpu, alphaImg, vm, { relax: 0, fineRelax: 1 });
  }

  const grain = opts.texture > 0.001;
  const valid2 = grain ? morphSquare(gpu, vm, 2, false) : null;
  const resid = grain
    ? gpu.pass({
        label: 'fill-residual',
        size: image,
        format: 'rgba16float',
        textures: { src: image },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = 1.0 / u.size;
  var acc = vec3f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      acc += unpremul(textureSampleLevel(src, smpNearest, uv + vec2f(f32(i), f32(j)) * t, 0.0)).rgb;
    }
  }
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0)).rgb;
  // Soft-limit: real grain is small; strong edges (grass blades, outlines) must not be copied around as "texture".
  let r = c - acc / 9.0;
  return vec4f(clamp(r, vec3f(-0.045), vec3f(0.045)), 1.0);
}`,
      })
    : null;

  return gpu.pass({
    label: 'fill-composite',
    size: image,
    textures: { src: image, filled, valid: vm, valid2, resid, alphaFill, cover: opts.holeCoverage ?? null },
    uniforms: { tex: opts.texture, cell: Math.max(4, 8 * image.unit) },
    wgsl: /* wgsl */ `
${grain ? `
fn grainAt(p: vec2f) -> vec3f {
  let cell = floor(p / u.cell);
  for (var k = 0; k < 12; k++) {
    let h = hash22(cell + vec2f(f32(k) * 7.31, 3.7));
    let ang = h.x * TAU;
    let dist = (6.0 + 5.0 * pow(1.55, f32(k))) * (0.6 + 0.8 * h.y) * (u.cell / 8.0);
    let q = p + vec2f(cos(ang), sin(ang)) * dist;
    if (q.x < 2.0 || q.y < 2.0 || q.x > u.size.x - 3.0 || q.y > u.size.y - 3.0) { continue; }
    let uq = q / u.size;
    if (textureSampleLevel(valid2, smpNearest, uq, 0.0).r > 0.99) { return textureSampleLevel(resid, smpNearest, uq, 0.0).rgb; }
  }
  return vec3f(0.0);
}` : ''}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let sc = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  ${opts.holeCoverage ? 'let hole = clamp(textureSampleLevel(cover, smp, uv, 0.0).r, 0.0, 1.0);' : 'let hole = 1.0 - clamp(textureSampleLevel(valid, smpNearest, uv, 0.0).r, 0.0, 1.0);'}
  var fc = textureSampleLevel(filled, smpNearest, uv, 0.0).rgb;
  ${grain ? 'fc += u.tex * grainAt(px);' : ''}
  fc = clamp(fc, vec3f(0.0), vec3f(1.0));
  let col = mix(sc.rgb, fc, hole);
  ${alphaFill ? 'let a = mix(sc.a, textureSampleLevel(alphaFill, smpNearest, uv, 0.0).r, hole);' : 'let a = sc.a;'}
  return premul(vec4f(col, a));
}`,
  });
}

export interface InpaintOptions extends FillOptions {
  /** Texels the mask is grown by before filling, so halos of the removed subject are not smeared in. */
  grow: number;
  /** Texels of blur applied to the seam coverage when blending the fill in. */
  feather: number;
}

/** Remove the masked region of `image` and fill it from the surroundings. Mask: 1 = remove. */
export function inpaintImage(gpu: NodeGpu, image: ImageValue, mask: Tex, o: InpaintOptions): ImageValue {
  const m = mask.width === image.width && mask.height === image.height ? mask : resample(gpu, mask, image.width, image.height);
  const hole: MaskValue = o.grow > 0.01 ? growMask(gpu, m, o.grow) : { ...m, kind: 'mask' };
  const valid = gpu.passMask({
    label: 'inpaint-valid',
    size: image,
    textures: { src: hole },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(1.0 - smoothstep(0.25, 0.5, textureSampleLevel(src, smpNearest, uv, 0.0).r)), 1.0); }',
  });
  const cover = o.feather > 0.05 ? blurMask(gpu, hole, o.feather) : undefined;
  return fillFromValid(gpu, image, valid, { ...o, holeCoverage: cover });
}

export default defineNode({
  id: 'inpaint',
  title: 'Inpaint',
  category: 'composite',
  description:
    'Removes the masked area and fills it by interpolating between the surrounding edge pixels (GPU push-pull with relaxation), then puts matching grain back so the fill is not plastic.',
  keywords: ['fill', 'remove object', 'content aware', 'heal', 'background', 'cutout fill', 'interpolate edges'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    mask: { type: 'mask', required: true, label: 'Area to remove' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    grow: { type: 'number', default: 3, min: 0, max: 200, step: 0.5, unit: 'px', label: 'Grow mask', hint: 'Expands the mask first so halos and soft edges of the removed object are not smeared into the fill.' },
    feather: { type: 'number', default: 1.5, min: 0, max: 100, step: 0.5, unit: 'px', label: 'Seam feather' },
    smoothness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Smoothness', hint: 'Higher relaxes the fill towards a smooth interpolation of the edge pixels.' },
    texture: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Texture', hint: 'Re-adds grain/noise copied from the surroundings.' },
    direction: { type: 'number', default: 0, min: -90, max: 90, step: 1, unit: 'deg', label: 'Bias angle', visibleIf: (p) => (p.bias as number) > 0 },
    bias: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Directional bias', hint: 'Stretches the fill along the angle (0 = horizontal) instead of spreading evenly.' },
  },
  summary: (p) => `grow ${p.grow} px`,
  render(ctx) {
    const p = ctx.params;
    const image = inpaintImage(ctx.gpu, ctx.in.image, ctx.in.mask, {
      grow: p.grow,
      feather: p.feather,
      smoothness: p.smoothness,
      texture: p.texture,
      direction: p.bias > 0 ? { angle: (p.direction * Math.PI) / 180, amount: p.bias } : undefined,
    });
    return { image };
  },
});
