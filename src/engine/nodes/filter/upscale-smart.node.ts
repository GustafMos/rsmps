import { defineNode } from '../../define';
import { assertTextureSize } from '../../lib/pixel-gpu';
import type { ImageValue, NodeGpu } from '../../types';

/**
 * Scale2x / Scale3x (AdvMAME), the public-domain rule-based pixel-art enlargers, applied exactly as published.
 * Pixels are compared by exact colour; edges between two colours get diagonals smoothed, everything else is copied.
 */
function scaleN(gpu: NodeGpu, src: ImageValue, n: 2 | 3): ImageValue {
  return gpu.pass({
    label: `scale${n}x`,
    size: { width: src.width * n, height: src.height * n, unit: src.unit * n },
    textures: { src },
    uniforms: { n },
    wgsl: /* wgsl */ `
fn px4(p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(p, vec2i(0), d - vec2i(1)), 0);
}
fn eq(a: vec4f, b: vec4f) -> bool { return all(a == b); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let o = vec2i(floor(px));
  let n = i32(u.n);
  let c = o / n;
  let sub = o - c * n;
  let E = px4(c);
  let B = px4(c + vec2i(0, -1));
  let D = px4(c + vec2i(-1, 0));
  let F = px4(c + vec2i(1, 0));
  let H = px4(c + vec2i(0, 1));
  if (n == 2) {
    var r = E;
    if (sub.x == 0 && sub.y == 0) { if (eq(D, B) && !eq(B, F) && !eq(D, H)) { r = D; } }
    if (sub.x == 1 && sub.y == 0) { if (eq(B, F) && !eq(B, D) && !eq(F, H)) { r = F; } }
    if (sub.x == 0 && sub.y == 1) { if (eq(D, H) && !eq(D, B) && !eq(H, F)) { r = D; } }
    if (sub.x == 1 && sub.y == 1) { if (eq(H, F) && !eq(D, H) && !eq(B, F)) { r = F; } }
    return r;
  }
  let A = px4(c + vec2i(-1, -1));
  let C = px4(c + vec2i(1, -1));
  let G = px4(c + vec2i(-1, 1));
  let I = px4(c + vec2i(1, 1));
  let k = sub.y * 3 + sub.x;
  var r = E;
  switch (k) {
    case 0: { if (eq(D, B) && !eq(B, F) && !eq(D, H)) { r = D; } }
    case 1: { if ((eq(D, B) && !eq(B, F) && !eq(D, H) && !eq(E, C)) || (eq(B, F) && !eq(B, D) && !eq(F, H) && !eq(E, A))) { r = B; } }
    case 2: { if (eq(B, F) && !eq(B, D) && !eq(F, H)) { r = F; } }
    case 3: { if ((eq(D, B) && !eq(B, F) && !eq(D, H) && !eq(E, G)) || (eq(D, H) && !eq(D, B) && !eq(H, F) && !eq(E, A))) { r = D; } }
    case 5: { if ((eq(B, F) && !eq(B, D) && !eq(F, H) && !eq(E, I)) || (eq(H, F) && !eq(D, H) && !eq(B, F) && !eq(E, C))) { r = F; } }
    case 6: { if (eq(D, H) && !eq(D, B) && !eq(H, F)) { r = D; } }
    case 7: { if ((eq(D, H) && !eq(D, B) && !eq(H, F) && !eq(E, I)) || (eq(H, F) && !eq(D, H) && !eq(B, F) && !eq(E, G))) { r = H; } }
    case 8: { if (eq(H, F) && !eq(D, H) && !eq(B, F)) { r = F; } }
    default: {}
  }
  return r;
}`,
  });
}

/** Separable resampling on exact source texels. kernel: 0 = Catmull-Rom (bicubic), 1 = Lanczos3. */
function resample(gpu: NodeGpu, src: ImageValue, w: number, h: number, kernel: number): ImageValue {
  const unit = src.unit * (w / src.width);
  const wgsl = /* wgsl */ `
fn kern(x: f32) -> f32 {
  let a = abs(x);
  if (u.kernel < 0.5) {
    if (a < 1.0) { return 1.5 * a * a * a - 2.5 * a * a + 1.0; }
    if (a < 2.0) { return -0.5 * a * a * a + 2.5 * a * a - 4.0 * a + 2.0; }
    return 0.0;
  }
  if (a < 0.00001) { return 1.0; }
  if (a >= 3.0) { return 0.0; }
  let pa = PI * a;
  return 3.0 * sin(pa) * sin(pa / 3.0) / (pa * pa);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let horizontal = u.axis < 0.5;
  let ratio = select(dims.y / u.size.y, dims.x / u.size.x, horizontal);
  let scale = max(ratio, 1.0);                         // widen the kernel when shrinking
  let pos = select(px.y, px.x, horizontal);
  let centre = (pos) * ratio - 0.5 + (ratio - 1.0) * 0.5 * 0.0;
  let support = select(2.0, 3.0, u.kernel > 0.5) * scale;
  let first = i32(floor(centre - support)) + 1;
  let last = i32(floor(centre + support));
  let limit = select(i32(dims.y), i32(dims.x), horizontal) - 1;
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = first; i <= last; i++) {
    let w = kern((f32(i) - centre) / scale);
    let ci = clamp(i, 0, limit);
    let coord = select(vec2i(i32(floor(px.x)), ci), vec2i(ci, i32(floor(px.y))), horizontal);
    acc += textureLoad(src, coord, 0) * w;
    wsum += w;
  }
  var o = acc / max(wsum, 0.0001);
  o = vec4f(clamp(o.rgb, vec3f(0.0), vec3f(1.0)), clamp(o.a, 0.0, 1.0));
  return o;
}`;
  // horizontal first (width changes), then vertical
  const mid = gpu.pass({ label: 'resample-h', size: { width: w, height: src.height, unit: src.unit }, format: 'rgba16float', textures: { src }, uniforms: { kernel, axis: 0 }, wgsl });
  const out = gpu.pass({ label: 'resample-v', size: { width: w, height: h, unit }, textures: { src: mid }, uniforms: { kernel, axis: 1 }, wgsl });
  return out;
}

/** Whole-number scale chain made of 2x and 3x steps, as close below `factor` as possible. */
function chain(factor: number): (2 | 3)[] {
  const steps: (2 | 3)[] = [];
  let total = 1;
  while (total * 3 <= factor && factor % (total * 3) === 0) { steps.push(3); total *= 3; }
  while (total * 2 <= factor) { steps.push(2); total *= 2; }
  while (total * 3 <= factor) { steps.push(3); total *= 3; }
  return steps;
}

export default defineNode({
  id: 'upscale-smart',
  title: 'Smart Upscale',
  category: 'filter',
  description:
    'Enlarges a picture with a method that suits it: crisp pixels, smooth photo-style interpolation (Lanczos or bicubic), an edge-sharpened mode for drawings and line art, or the Scale2x/Scale3x pixel-art rules. Choose a factor or an exact output height.',
  keywords: ['enlarge', 'resize', 'scale', 'upsample', 'lanczos', 'bicubic', 'scale2x', 'scale3x', 'epx', 'pixel art', 'line art', 'nearest', 'resolution', 'sharp', 'upscale'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'lanczos',
      label: 'Method',
      options: [
        { value: 'nearest', label: 'Nearest' },
        { value: 'bicubic', label: 'Bicubic' },
        { value: 'lanczos', label: 'Lanczos' },
        { value: 'lineart', label: 'Edge-sharpened' },
        { value: 'scale2x', label: 'Scale2x / Scale3x' },
      ],
    },
    by: {
      type: 'enum',
      default: 'factor',
      label: 'Size by',
      options: [
        { value: 'factor', label: 'Factor' },
        { value: 'height', label: 'Output height' },
      ],
    },
    factor: { type: 'number', default: 2, min: 1, max: 16, softMax: 8, step: 0.25, label: 'Factor', visibleIf: (p) => p.by === 'factor', hint: 'Scale2x/Scale3x chain whole 2x and 3x steps (4x = 2x twice) and finish with nearest to the exact size.' },
    height: { type: 'number', default: 1080, min: 1, max: 16384, softMax: 4320, step: 1, integer: true, label: 'Output height', visibleIf: (p) => p.by === 'height', hint: 'Literal pixels of the output, like Resize. The width follows the aspect ratio.' },
    crisp: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge crispness', group: 'Edge-sharpened', visibleIf: (p) => p.mode === 'lineart' },
    edgeRadius: { type: 'number', default: 1.2, min: 0.5, max: 6, softMax: 4, step: 0.1, label: 'Edge reach', group: 'Edge-sharpened', visibleIf: (p) => p.mode === 'lineart', hint: 'In source pixels.' },
  },
  summary: (p) => `${p.mode} · ${p.by === 'factor' ? `×${p.factor}` : `${p.height} px tall`}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    let w: number;
    let h: number;
    if (p.by === 'height') {
      h = Math.max(1, Math.round(p.height));
      w = Math.max(1, Math.round((src.width * h) / src.height));
    } else {
      w = Math.max(1, Math.round(src.width * p.factor));
      h = Math.max(1, Math.round(src.height * p.factor));
    }
    assertTextureSize(gpu, w, h, 'Upscale');
    if (w === src.width && h === src.height) return { image: src };
    const nearest = (img: ImageValue) =>
      gpu.pass({
        label: 'upscale-nearest',
        size: { width: w, height: h, unit: src.unit * (w / src.width) },
        textures: { src: img },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }',
      });

    switch (p.mode) {
      case 'nearest':
        return { image: nearest(src) };
      case 'scale2x': {
        const ratio = Math.min(w / src.width, h / src.height);
        const steps = ratio >= 2 ? chain(Math.floor(ratio + 1e-6)) : [];
        let img = src;
        for (const s of steps) img = scaleN(gpu, img, s);
        return { image: img.width === w && img.height === h ? img : nearest(img) };
      }
      case 'bicubic':
        return { image: resample(gpu, src, w, h, 0) };
      case 'lanczos':
        return { image: resample(gpu, src, w, h, 1) };
      default: {
        // drawings: Lanczos, then a shock-filter step that pulls each pixel toward the nearer of the local darkest / lightest value
        const big = resample(gpu, src, w, h, 1);
        const reach = Math.max(1, p.edgeRadius * (w / src.width));
        const image = gpu.pass({
          label: 'lineart-snap',
          size: big,
          textures: { src: big },
          uniforms: { reach, crisp: p.crisp },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  let t = 1.0 / u.size;
  var lo = c; var hi = c;
  for (var j = -2; j <= 2; j++) { for (var i = -2; i <= 2; i++) {
    let s = textureSampleLevel(src, smp, uv + vec2f(f32(i), f32(j)) * u.reach * 0.5 * t, 0.0);
    if (luma(s.rgb + vec3f(1.0 - s.a)) < luma(lo.rgb + vec3f(1.0 - lo.a))) { lo = s; }
    if (luma(s.rgb + vec3f(1.0 - s.a)) > luma(hi.rgb + vec3f(1.0 - hi.a))) { hi = s; }
  } }
  let l = luma(c.rgb + vec3f(1.0 - c.a));
  let ll = luma(lo.rgb + vec3f(1.0 - lo.a));
  let lh = luma(hi.rgb + vec3f(1.0 - hi.a));
  let mid = 0.5 * (ll + lh);
  let range = max(lh - ll, 0.0001);
  let k = smoothstep(0.5 - 0.5 * (1.0 - u.crisp) - 0.02, 0.5 + 0.5 * (1.0 - u.crisp) + 0.02, (l - ll) / range);
  let snapped = mix(lo, hi, k);
  return mix(c, snapped, u.crisp * smoothstep(0.04, 0.2, range));
}`,
        });
        return { image };
      }
    }
  },
});
