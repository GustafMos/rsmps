/**
 * GPU push-pull interpolation ("fill the holes from the surrounding pixels").
 *
 * push: build a pyramid of (colour * validity, validity) by repeated 2x2 averaging.
 * pull: from the coarsest level up, fill invalid texels from the (bilinearly upsampled) coarser level,
 *       then relax a few Jacobi iterations over the filled texels so the result approaches the harmonic
 *       interpolation of the edge pixels (smooth, no blocky pyramid artefacts). Entirely on the GPU.
 */
import type { ImageValue, NodeGpu } from '../types';
import type { Tex } from './mask-util';

export interface PushPullOptions {
  /** Jacobi relaxation iterations per pyramid level (0 = pure push-pull). */
  relax?: number;
  /** Extra relaxation iterations on the finest levels (smooths bilinear artefacts). */
  fineRelax?: number;
  /** Directional bias: angle (radians) and amount 0..1 that favours propagation along that direction. */
  direction?: { angle: number; amount: number };
  /** Multiply validity by the source alpha (so transparent texels never contribute colour). */
  useAlpha?: boolean;
}

const AVG4 = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(src));
  let b = vec2i(floor(px)) * 2;
  let m = dims - vec2i(1);
  let a0 = textureLoad(src, min(b, m), 0);
  let a1 = textureLoad(src, min(b + vec2i(1, 0), m), 0);
  let a2 = textureLoad(src, min(b + vec2i(0, 1), m), 0);
  let a3 = textureLoad(src, min(b + vec2i(1, 1), m), 0);
  return (a0 + a1 + a2 + a3) * 0.25;
}`;

/**
 * Fill `src` where `valid` (coverage .r, 1 = trusted, 0 = hole) is low. Returns an opaque RGBA16F image
 * with straight sRGB colour; trusted texels keep their colour, holes are interpolated.
 */
export function pushPull(gpu: NodeGpu, src: ImageValue, valid: Tex, opts: PushPullOptions = {}): ImageValue {
  const relax = opts.relax ?? 2;
  const fine = opts.fineRelax ?? 4;
  const dir = opts.direction ?? { angle: 0, amount: 0 };
  const wh = 1 + dir.amount * (2 * Math.cos(dir.angle) ** 2 - 1);
  const wv = 2 - wh;

  const levels: ImageValue[] = [];
  levels.push(
    gpu.pass({
      label: 'pp-init',
      size: src,
      format: 'rgba16float',
      textures: { src, vm: valid },
      uniforms: { useA: !!opts.useAlpha },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  let s = unpremul(c);
  var w = clamp(textureSampleLevel(vm, smpNearest, uv, 0.0).r, 0.0, 1.0);
  if (u.useA > 0.5) { w *= s.a; }
  return vec4f(s.rgb * w, w);
}`,
    }),
  );
  while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1) {
    const prev = levels[levels.length - 1];
    levels.push(
      gpu.pass({
        label: 'pp-push',
        size: { width: Math.ceil(prev.width / 2), height: Math.ceil(prev.height / 2), unit: prev.unit / 2 },
        format: 'rgba16float',
        textures: { src: prev },
        wgsl: AVG4,
      }),
    );
  }

  const top = levels[levels.length - 1];
  let filled = gpu.pass({
    label: 'pp-top',
    size: top,
    format: 'rgba16float',
    textures: { src: top },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureLoad(src, vec2i(0), 0);
  if (c.a < 1e-5) { return vec4f(0.5, 0.5, 0.5, 1.0); }
  return vec4f(c.rgb / c.a, 1.0);
}`,
  });

  const pull = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let o = textureLoad(own, vec2i(floor(px)), 0);
  let cc = textureSampleLevel(coarse, smp, uv, 0.0).rgb;
  return vec4f(o.rgb + (1.0 - o.a) * cc, 1.0);
}`;
  const relaxWgsl = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(cur));
  let ip = vec2i(floor(px));
  let m = dims - vec2i(1);
  let o = textureLoad(own, ip, 0);
  if (o.a >= 0.999) { return vec4f(o.rgb, 1.0); }
  let l = textureLoad(cur, clamp(ip + vec2i(-1, 0), vec2i(0), m), 0).rgb;
  let r = textureLoad(cur, clamp(ip + vec2i(1, 0), vec2i(0), m), 0).rgb;
  let t = textureLoad(cur, clamp(ip + vec2i(0, -1), vec2i(0), m), 0).rgb;
  let d = textureLoad(cur, clamp(ip + vec2i(0, 1), vec2i(0), m), 0).rgb;
  let j = (u.wh * (l + r) + u.wv * (t + d)) / (2.0 * (u.wh + u.wv));
  return vec4f(o.rgb + (1.0 - o.a) * j, 1.0);
}`;
  for (let l = levels.length - 2; l >= 0; l--) {
    const own = levels[l];
    filled = gpu.pass({ label: 'pp-pull', size: own, format: 'rgba16float', textures: { own, coarse: filled }, wgsl: pull });
    const iters = relax + (l <= 1 ? fine : 0);
    for (let i = 0; i < iters; i++) {
      filled = gpu.pass({ label: 'pp-relax', size: own, format: 'rgba16float', textures: { own, cur: filled }, uniforms: { wh, wv }, wgsl: relaxWgsl });
    }
  }
  return filled;
}
