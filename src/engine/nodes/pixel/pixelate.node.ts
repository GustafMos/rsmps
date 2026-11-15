import { defineNode } from '../../define';
import type { ImageValue } from '../../types';
import { gaussianBlur } from '../filter/blur.node';

const MAX_SIDE = 4096;

/** Art-grid size for the chosen mode. Depends only on the params and the source aspect, never on its resolution. */
export function artSize(mode: string, value: number, blockTexels: number, srcW: number, srcH: number): { width: number; height: number } {
  let w = srcW;
  let h = srcH;
  const v = Math.max(1, value);
  switch (mode) {
    case 'fixed-height':
      h = v;
      w = (srcW / srcH) * v;
      break;
    case 'fixed-width':
      w = v;
      h = (srcH / srcW) * v;
      break;
    case 'short-side': {
      const k = v / Math.min(srcW, srcH);
      w = srcW * k;
      h = srcH * k;
      break;
    }
    case 'block-size':
      w = srcW / Math.max(1, blockTexels);
      h = srcH / Math.max(1, blockTexels);
      break;
  }
  return {
    width: Math.max(1, Math.min(MAX_SIDE, Math.round(w))),
    height: Math.max(1, Math.min(MAX_SIDE, Math.round(h))),
  };
}

/**
 * Downsample to an art grid. The output is the small art-resolution image with `unit: 1`, so every
 * downstream length is in art pixels.
 *
 * Plain mode: each art pixel is the area average of its source cell.
 * Edge-aware mode (a GPU re-implementation of the old sampler, simplified):
 *   1. an edge map (colour + alpha gradient, measured at a distance proportional to the cell so it does
 *      not depend on the source resolution);
 *   2. per cell, search a 5x5 set of window shifts (up to `alignment` x 0.42 cell) for the window that
 *      crosses the fewest edges, with a small pull towards the centre;
 *   3. smooth the shift field so neighbouring cells move coherently;
 *   4. sample each cell at its shifted window: the area average blended with the dominant local colour
 *      (found by clustering a 3x3/5x5 sample grid), which keeps flat regions flat and edges crisp.
 * The old sampler used non-maximum suppression and a percentile threshold; here the threshold is a
 * smooth gradient cutoff, which gives comparable results without a histogram pass.
 */
export default defineNode({
  id: 'pixelate',
  title: 'Pixelate',
  category: 'pixel',
  description:
    'Downsamples to a pixel-art grid. The grid size comes from the parameters, so photos of any resolution land on the same art resolution. Edge-aware mode keeps outlines on cell borders.',
  keywords: ['downsample', 'resolution', 'art grid', 'sprite', 'low res', 'edge aware', 'block'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'fixed-height',
      label: 'Size mode',
      group: 'Grid',
      options: [
        { value: 'fixed-height', label: 'Fixed height' },
        { value: 'fixed-width', label: 'Fixed width' },
        { value: 'short-side', label: 'Short side' },
        { value: 'block-size', label: 'Block size' },
      ],
    },
    value: {
      type: 'number',
      default: 180,
      min: 2,
      max: 2048,
      step: 1,
      integer: true,
      label: 'Art pixels',
      hint: 'Number of art pixels along the chosen side. The same on every input resolution.',
      group: 'Grid',
      visibleIf: (p) => p.mode !== 'block-size',
    },
    blockSize: {
      type: 'number',
      default: 6,
      min: 1,
      max: 256,
      step: 0.5,
      unit: 'px',
      label: 'Block size',
      hint: 'Source pixels per art pixel. Follows the media scale, so mixed resolutions still match.',
      group: 'Grid',
      visibleIf: (p) => p.mode === 'block-size',
    },
    preBlur: {
      type: 'number',
      default: 0.35,
      min: 0,
      max: 2,
      step: 0.01,
      label: 'Pre-blur',
      hint: 'Blur before sampling, in art pixels. Calms noise and texture.',
      group: 'Grid',
    },
    edgeAware: { type: 'bool', default: true, label: 'Edge-aware', group: 'Edges' },
    alignment: {
      type: 'number',
      default: 0.68,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Alignment',
      hint: 'How far a cell may slide to avoid cutting through an edge.',
      group: 'Edges',
      visibleIf: (p) => p.edgeAware === true,
    },
    edgeThreshold: {
      type: 'number',
      default: 0.52,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Edge sensitivity',
      hint: '0 = only the strongest edges, 1 = fine detail too.',
      group: 'Edges',
      visibleIf: (p) => p.edgeAware === true,
    },
    smoothing: {
      type: 'number',
      default: 2,
      min: 0,
      max: 4,
      step: 1,
      integer: true,
      label: 'Grid smoothing',
      hint: 'Smoothing passes on the cell shifts. More = a calmer, more regular grid.',
      group: 'Edges',
      visibleIf: (p) => p.edgeAware === true,
    },
    colorBlend: {
      type: 'number',
      default: 0.7,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Dominant colour',
      hint: '0 = average of the cell, 1 = the most common colour in the cell (crisper).',
      group: 'Colour',
    },
    sharpen: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Sharpen', group: 'Colour' },
    alphaCutoff: {
      type: 'number',
      default: 0.02,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Alpha cut-off',
      hint: 'Pixels with less coverage than this become fully transparent.',
      group: 'Colour',
    },
  },
  summary: (p) => (p.mode === 'block-size' ? `blocks of ${p.blockSize} px` : `${p.mode.replace('fixed-', '').replace('-', ' ')} ${p.value}`),
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    const { width: W, height: H } = artSize(p.mode, p.value, p.blockSize, src.width, src.height);
    const cellW = src.width / W;
    const cellH = src.height / H;
    const cell = (cellW + cellH) / 2;
    const gpu = ctx.gpu;
    const out = { width: W, height: H, unit: 1 };

    // 0. pre-blur: sigma = preBlur art pixels (gaussianBlur takes radius = 2 sigma).
    const base: ImageValue = p.preBlur > 0.001 && cell > 1.05 ? gaussianBlur(gpu, src, p.preBlur * cell * 2) : src;

    // 1-3. Edge-aware window shifts.
    let shifts: ImageValue | null = null;
    if (p.edgeAware && p.alignment > 0.001 && cell >= 1.5) {
      let sub = 4;
      while (sub > 1 && (W * sub > MAX_SIDE || H * sub > MAX_SIDE)) sub /= 2;
      const sens = p.edgeThreshold;
      const cutoff = 0.3 + (0.05 - 0.3) * sens;
      const edges = gpu.pass({
        label: 'pixelate-edges',
        size: { width: W * sub, height: H * sub },
        textures: { src: base },
        uniforms: { d: [(0.35 * cellW) / base.width, (0.35 * cellH) / base.height], cutoff },
        wgsl: /* wgsl */ `
fn at(uv: vec2f, o: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv + o * u.d, 0.0); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let gx = (at(uv, vec2f(1, -1)) + 2.0 * at(uv, vec2f(1, 0)) + at(uv, vec2f(1, 1))) - (at(uv, vec2f(-1, -1)) + 2.0 * at(uv, vec2f(-1, 0)) + at(uv, vec2f(-1, 1)));
  let gy = (at(uv, vec2f(-1, 1)) + 2.0 * at(uv, vec2f(0, 1)) + at(uv, vec2f(1, 1))) - (at(uv, vec2f(-1, -1)) + 2.0 * at(uv, vec2f(0, -1)) + at(uv, vec2f(1, -1)));
  let mag = sqrt(dot(gx, gx) + dot(gy, gy)) / 4.0;
  let e = smoothstep(u.cutoff * 0.7, u.cutoff * 1.3, mag);
  return vec4f(e, e, e, 1.0);
}`,
      });
      let field = gpu.pass({
        label: 'pixelate-shift',
        size: { width: W, height: H },
        textures: { edge: edges },
        format: 'rgba16float',
        uniforms: { align: p.alignment, sub },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let n = i32(u.sub);
  var best = vec2f(0.0);
  var bestScore = 1e9;
  for (var sy = -2; sy <= 2; sy++) {
    for (var sx = -2; sx <= 2; sx++) {
      let off = vec2f(f32(sx), f32(sy)) * 0.21 * u.align;
      var sum = 0.0;
      for (var j = 0; j < n; j++) {
        for (var i = 0; i < n; i++) {
          let q = px + off + ((vec2f(f32(i), f32(j)) + 0.5) / f32(n) - 0.5) * 0.98;
          sum += textureSampleLevel(edge, smpNearest, q / u.size, 0.0).r;
        }
      }
      let score = sum / f32(n * n) + 0.055 * dot(off, off);
      if (score < bestScore) { bestScore = score; best = off; }
    }
  }
  return vec4f(best, 0.0, 1.0);
}`,
      });
      for (let i = 0; i < p.smoothing; i++) {
        field = gpu.pass({
          label: 'pixelate-smooth',
          size: { width: W, height: H },
          textures: { src: field },
          format: 'rgba16float',
          wgsl: /* wgsl */ `
fn at(x: i32, y: i32) -> vec2f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(vec2i(x, y), vec2i(0), d - vec2i(1)), 0).rg;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let v = at(x, y) * 4.0
    + (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 2.0
    + at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1);
  return vec4f(v / 16.0, 0.0, 1.0);
}`,
        });
      }
      shifts = field;
    }

    // 4. Sample every cell.
    const useDominant = p.colorBlend > 0.01 && cell > 1.2;
    const taps = (n: number) => Math.max(2, Math.min(12, Math.ceil(n)));
    let image = gpu.pass({
      label: 'pixelate',
      size: out,
      textures: { src: base, shifts },
      uniforms: {
        srcSize: [base.width, base.height],
        nx: taps(cellW * 0.98),
        ny: taps(cellH * 0.98),
        grid: cell > 8 ? 5 : 3,
        blend: useDominant ? p.colorBlend : 0,
        cutoff: p.alphaCutoff,
      },
      wgsl: /* wgsl */ `
fn tapAt(p: vec2f) -> vec4f { return textureSampleLevel(src, smp, p / u.srcSize, 0.0); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let cellSz = u.srcSize / u.size;
  var o = vec2f(0.0);
  ${shifts ? 'o = textureLoad(shifts, vec2i(floor(px)), 0).rg;' : ''}
  let centre = (px + o) * cellSz;
  let span = cellSz * 0.98;
  let nx = i32(u.nx);
  let ny = i32(u.ny);
  var acc = vec4f(0.0);
  for (var j = 0; j < ny; j++) {
    for (var i = 0; i < nx; i++) {
      acc += tapAt(centre + ((vec2f(f32(i), f32(j)) + 0.5) / vec2f(f32(nx), f32(ny)) - 0.5) * span);
    }
  }
  acc = acc / f32(nx * ny);
  var colour = vec3f(0.0);
  if (acc.a > 0.0001) { colour = acc.rgb / acc.a; }

  if (u.blend > 0.0) {
    var cols: array<vec3f, 25>;
    var count = 0;
    let m = i32(u.grid);
    for (var j = 0; j < m; j++) {
      for (var i = 0; i < m; i++) {
        let s = tapAt(centre + ((vec2f(f32(i), f32(j)) + 0.5) / f32(m) - 0.5) * span);
        if (s.a > 0.06) { cols[count] = s.rgb / s.a; count++; }
      }
    }
    var bestN = 0;
    var bestI = 0;
    for (var a = 0; a < count; a++) {
      var n = 0;
      for (var b = 0; b < count; b++) {
        let d = cols[a] - cols[b];
        if (dot(d, d) < 0.01) { n++; }
      }
      if (n > bestN) { bestN = n; bestI = a; }
    }
    if (count > 0) {
      var sum = vec3f(0.0);
      var k = 0.0;
      for (var b = 0; b < count; b++) {
        let d = cols[bestI] - cols[b];
        if (dot(d, d) < 0.01) { sum += cols[b]; k += 1.0; }
      }
      colour = mix(colour, sum / k, u.blend);
    }
  }
  var a = acc.a;
  if (a < u.cutoff) { a = 0.0; }
  return premul(vec4f(clamp(colour, vec3f(0.0), vec3f(1.0)), a));
}`,
    });

    // 5. Light unsharp mask on the art image.
    if (p.sharpen > 0.001) {
      image = gpu.pass({
        label: 'pixelate-sharpen',
        size: out,
        textures: { src: image },
        uniforms: { amount: p.sharpen },
        wgsl: /* wgsl */ `
fn at(x: i32, y: i32) -> vec4f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(vec2i(x, y), vec2i(0), d - vec2i(1)), 0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let c = at(x, y);
  if (c.a <= 0.0001) { return c; }
  let blur = (at(x, y) * 4.0 + (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 2.0
    + at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 16.0;
  let s = unpremul(c);
  let sb = unpremul(blur);
  return premul(vec4f(clamp(s.rgb + (s.rgb - sb.rgb) * u.amount, vec3f(0.0), vec3f(1.0)), c.a));
}`,
      });
    }
    return { image };
  },
});
