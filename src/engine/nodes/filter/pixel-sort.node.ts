import { defineNode } from '../../define';
import { assertTextureSize } from '../../lib/pixel-gpu';
import type { ImageValue } from '../../types';

const KEYS = ['brightness', 'hue', 'saturation', 'red', 'green', 'blue'];
const SPANS = ['brightness', 'edges', 'random', 'mask'];
const CHUNK = 2048; // longest line sorted in one piece; longer lines are cut into chunks (the cut is a span boundary)

/**
 * HOW IT SORTS (all on the GPU, exact, no matter how long the span is):
 *  1. An init pass decides for every pixel of a line whether it starts a new span (span detection), and writes a
 *     record (span start, sort key, original index) to a float texture.
 *  2. Pointer jumping (11 passes) turns "start of my span, or my neighbour's" into the true start of every span.
 *  3. A bitonic sorting network (66 passes for 2048 pixels) sorts every line by (span start, key). Because span
 *     starts increase along the line, pixels never leave their span, and inside a span they end up ordered by key.
 *     Pixels outside any span are their own span of length one, so they stay where they are.
 *  4. A gather pass reads each pixel's colour from its original index.
 * About 80 passes per frame, each over lineLength x lines texels. Smear mode skips the sorting network.
 */
export default defineNode({
  id: 'pixel-sort',
  title: 'Pixel Sort',
  category: 'filter',
  description:
    'The glitch classic: runs ("spans") of pixels are sorted along the row, column or any angle into smooth streaks, or smeared into drips. Spans can come from a brightness window, edges, random lengths or a mask. Sorting is exact however long the span is.',
  keywords: ['glitch', 'sort', 'streak', 'datamosh', 'asdf', 'melt', 'drip', 'smear', 'threshold', 'stretch', 'pixel stretch'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    spanMask: { type: 'mask', label: 'Span mask (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    direction: {
      type: 'enum',
      default: 'horizontal',
      label: 'Sort along',
      options: [
        { value: 'horizontal', label: 'Rows (left to right)' },
        { value: 'vertical', label: 'Columns (top to bottom)' },
      ],
    },
    angle: { type: 'number', default: 0, min: -90, max: 90, step: 1, unit: 'deg', label: 'Tilt the direction', hint: 'Sort along a tilted line instead. The picture is resampled (nearest) for non-zero angles.' },
    mode: {
      type: 'enum',
      default: 'sort',
      label: 'Effect',
      options: [
        { value: 'sort', label: 'Sort the pixels' },
        { value: 'smear', label: 'Smear (drip the span start forward)' },
        { value: 'smear-back', label: 'Smear (drip the span end backward)' },
      ],
    },
    spans: {
      type: 'enum',
      default: 'brightness',
      label: 'Spans from',
      group: 'Spans',
      options: [
        { value: 'brightness', label: 'Brightness window' },
        { value: 'edges', label: 'Edges (split at sharp changes)' },
        { value: 'random', label: 'Random lengths' },
        { value: 'mask', label: 'The span mask input' },
      ],
    },
    low: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.005, label: 'Window: from brightness', group: 'Spans', visibleIf: (p) => p.spans === 'brightness' },
    high: { type: 'number', default: 0.85, min: 0, max: 1, step: 0.005, label: 'Window: up to brightness', group: 'Spans', visibleIf: (p) => p.spans === 'brightness' },
    invertWindow: { type: 'bool', default: false, label: 'Use everything outside the window', group: 'Spans', visibleIf: (p) => p.spans === 'brightness' },
    edgeThreshold: { type: 'number', default: 0.18, min: 0.01, max: 1, step: 0.005, label: 'Edge strength that splits a span', group: 'Spans', visibleIf: (p) => p.spans === 'edges' },
    spanLength: { type: 'number', default: 120, min: 2, max: 2000, softMax: 800, step: 1, unit: 'px', label: 'Average span length', group: 'Spans', visibleIf: (p) => p.spans === 'random' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Spans', visibleIf: (p) => p.spans === 'random' },
    key: {
      type: 'enum',
      default: 'brightness',
      label: 'Sort by',
      group: 'Order',
      options: [
        { value: 'brightness', label: 'Brightness' },
        { value: 'hue', label: 'Hue' },
        { value: 'saturation', label: 'Saturation' },
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
      ],
      visibleIf: (p) => p.mode === 'sort',
    },
    reverse: { type: 'bool', default: false, label: 'Reverse order', group: 'Order', visibleIf: (p) => p.mode === 'sort' },
    sweepCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Sweep the window (per loop)', group: 'Animation', hint: 'The brightness window slides up and down this many times per loop. 0 = still.', visibleIf: (p) => p.spans === 'brightness' },
    sweepAmount: { type: 'number', default: 0.3, min: 0, max: 0.6, step: 0.01, label: 'Sweep distance', group: 'Animation', visibleIf: (p) => p.spans === 'brightness' && (p.sweepCycles as number) > 0 },
  },
  summary: (p) => `${p.mode} · ${p.spans}${p.angle ? ` · ${p.angle}°` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const tilt = p.angle !== 0;
    const rad = (p.angle * Math.PI) / 180;
    const vertical = p.direction === 'vertical';
    const sweep = p.spans === 'brightness' && p.sweepCycles > 0 ? p.sweepAmount * Math.cos(ctx.time.phase * Math.PI * 2 * Math.round(p.sweepCycles)) : 0;
    const low = Math.max(0, Math.min(1, p.low + sweep));
    const high = Math.max(low, Math.min(1, p.high + sweep));

    // 0. optional tilt: resample into a rotated canvas so the sort direction is a row
    let base: ImageValue = src;
    let mask: ImageValue | { texture: GPUTexture } | null = ctx.in.spanMask ?? null;
    const rot = (img: ImageValue | { texture: GPUTexture }, w: number, h: number, a: number, fromSize: { width: number; height: number }) =>
      gpu.pass({
        label: 'pixel-sort-rotate',
        size: { width: w, height: h, unit: src.unit },
        textures: { tex: img },
        uniforms: { a, dims: [fromSize.width, fromSize.height] },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = px - u.size * 0.5;
  let c = cos(u.a); let s = sin(u.a);
  let q = vec2f(c * d.x - s * d.y, s * d.x + c * d.y) + u.dims * 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= u.dims.x || q.y >= u.dims.y) { return vec4f(0.0); }
  return textureSampleLevel(tex, smpNearest, q / u.dims, 0.0);
}`,
      });
    let w = src.width;
    let h = src.height;
    if (tilt) {
      const d = Math.ceil(Math.hypot(src.width, src.height));
      w = d;
      h = d;
      base = rot(src, d, d, rad, src);
      if (mask) mask = rot(mask, d, d, rad, src);
    }
    const axisLen = vertical && !tilt ? h : w;
    const lineCount = vertical && !tilt ? w : h;
    const chunks = Math.ceil(axisLen / CHUNK);
    const lines = lineCount * chunks;
    assertTextureSize(gpu, CHUNK, lines, 'Pixel Sort');
    const vert = vertical && !tilt;
    const flip = p.mode === 'smear-back';
    const spanIdx = SPANS.indexOf(p.spans);
    const hasMask = spanIdx === 3 && !!mask;
    const common = `
fn srcCoord(idx: i32, line: i32) -> vec2i {
  let chunk = line % i32(u.chunks);
  let row = line / i32(u.chunks);
  var pos = chunk * ${CHUNK} + idx;
  if (u.flip > 0.5) { pos = i32(u.len) - 1 - pos; }
  return select(vec2i(pos, row), vec2i(row, pos), u.vert > 0.5);
}
fn inRange(idx: i32, line: i32) -> bool {
  let chunk = line % i32(u.chunks);
  return chunk * ${CHUNK} + idx < i32(u.len);
}
fn load(idx: i32, line: i32) -> vec4f { return textureLoad(src, srcCoord(idx, line), 0); }
fn lumaOf(c: vec4f) -> f32 { return luma(unpremul(c).rgb); }
fn keyOf(c: vec4f) -> f32 {
  let s = unpremul(c);
  var k = luma(s.rgb);
  switch (i32(u.key)) {
    case 1: { k = rgbToHsv(s.rgb).x; }
    case 2: { k = rgbToHsv(s.rgb).y; }
    case 3: { k = s.r; }
    case 4: { k = s.g; }
    case 5: { k = s.b; }
    default: {}
  }
  return select(k, 1.0 - k, u.reverse > 0.5);
}`;
    const uniforms = { chunks, len: axisLen, vert, flip, key: Math.max(0, KEYS.indexOf(p.key)), reverse: p.reverse, spanMode: spanIdx, low, high, invert: p.invertWindow, edge: p.edgeThreshold, avg: Math.max(2, p.spanLength), seed: p.seed * 3.7 };
    const size = { width: CHUNK, height: lines, unit: 1 };

    // 1. records: (span start candidate, key, original index)
    let rec = gpu.pass({
      label: 'pixel-sort-init',
      size,
      format: 'rgba16float',
      textures: { src: base, spanMask: hasMask ? mask : null },
      uniforms,
      wgsl: /* wgsl */ `${common}
fn sortable(idx: i32, line: i32) -> bool {
  let c = load(idx, line);
  if (c.a < 0.01) { return false; }
  if (u.spanMode > 2.5) {
    ${hasMask ? 'return textureLoad(spanMask, srcCoord(idx, line), 0).r > 0.5;' : 'return true;'}
  }
  if (u.spanMode > 0.5) { return true; }
  let l = lumaOf(c);
  return (l >= u.low && l <= u.high) != (u.invert > 0.5);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let idx = i32(floor(px.x));
  let line = i32(floor(px.y));
  if (!inRange(idx, line)) { return vec4f(f32(idx), 0.0, f32(idx), 0.0); }
  let c = load(idx, line);
  var start = idx == 0 || !sortable(idx, line) || !sortable(idx - 1, line);
  if (!start && u.spanMode > 0.5 && u.spanMode < 1.5) {
    start = abs(lumaOf(c) - lumaOf(load(idx - 1, line))) > u.edge;
  }
  if (!start && u.spanMode > 1.5 && u.spanMode < 2.5) {
    start = hash21(vec2f(f32(idx) + u.seed, f32(line) * 1.37 + u.seed)) < 1.0 / u.avg;
  }
  let r = select(f32(idx - 1), f32(idx), start);
  let k = select(0.0, keyOf(c), sortable(idx, line));
  return vec4f(r, k, f32(idx), 1.0);
}`,
    });

    // 2. pointer jumping: every pixel learns the start of its span (11 doublings cover 2048)
    for (let i = 0; i < 11; i++) {
      const prev = rec;
      rec = gpu.pass({
        label: 'pixel-sort-jump',
        size,
        format: 'rgba16float',
        textures: { rec },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let me = textureLoad(rec, vec2i(floor(px)), 0);
  let r = max(i32(me.r + 0.5), 0);
  let jump = textureLoad(rec, vec2i(r, i32(floor(px.y))), 0);
  return vec4f(jump.r, me.g, me.b, me.a);
}`,
      });
      gpu.recycle(prev); // ping-pong: without this all 78 passes of the network stay alive until the render ends (5 GB at 4K)
    }

    // 3. bitonic sorting network over (start, key, index)
    if (p.mode === 'sort') {
      for (let k = 2; k <= CHUNK; k *= 2) {
        for (let j = k / 2; j >= 1; j = Math.floor(j / 2)) {
          const prev = rec;
          rec = gpu.pass({
            label: 'pixel-sort-bitonic',
            size,
            format: 'rgba16float',
            textures: { rec },
            uniforms: { k, j },
            wgsl: /* wgsl */ `
fn less(a: vec4f, b: vec4f) -> bool {
  if (a.r != b.r) { return a.r < b.r; }
  if (a.g != b.g) { return a.g < b.g; }
  return a.b < b.b;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let i = i32(floor(px.x));
  let line = i32(floor(px.y));
  let l = i ^ i32(u.j);
  let a = textureLoad(rec, vec2i(i, line), 0);
  let b = textureLoad(rec, vec2i(l, line), 0);
  let up = (i & i32(u.k)) == 0;
  let lower = i < l;
  let wantMin = lower == up;
  let aLess = less(a, b);
  var r = a;
  if (wantMin) { if (!aLess) { r = b; } } else { if (aLess) { r = b; } }
  return r;
}`,
          });
          gpu.recycle(prev);
        }
      }
    }

    // 4. gather the colours back (sorted: from the original index; smear: from the span start)
    const sorted = gpu.pass({
      label: 'pixel-sort-gather',
      size: { width: w, height: h, unit: src.unit },
      textures: { src: base, rec },
      uniforms: { ...uniforms, smear: p.mode !== 'sort' },
      wgsl: /* wgsl */ `${common}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let xy = vec2i(floor(px));
  let pos0 = select(xy.x, xy.y, u.vert > 0.5);
  let row = select(xy.y, xy.x, u.vert > 0.5);
  let pos = select(pos0, i32(u.len) - 1 - pos0, u.flip > 0.5);
  let chunk = pos / ${CHUNK};
  let idx = pos - chunk * ${CHUNK};
  let line = row * i32(u.chunks) + chunk;
  let e = textureLoad(rec, vec2i(idx, line), 0);
  var fromIdx = i32(e.b + 0.5);
  if (u.smear > 0.5) { fromIdx = i32(e.r + 0.5); }
  return load(fromIdx, line);
}`,
    });

    gpu.recycle(rec);
    if (tilt) {
      gpu.recycle(base);
      if (mask) gpu.recycle(mask as { texture: GPUTexture });
    }
    if (!tilt) return { image: sorted };
    // 5. rotate back
    const image = gpu.pass({
      label: 'pixel-sort-unrotate',
      size: src,
      textures: { tex: sorted },
      uniforms: { a: -rad, dims: [w, h] },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = px - u.size * 0.5;
  let c = cos(u.a); let s = sin(u.a);
  let q = vec2f(c * d.x - s * d.y, s * d.x + c * d.y) + u.dims * 0.5;
  return textureSampleLevel(tex, smpNearest, q / u.dims, 0.0);
}`,
    });
    return { image };
  },
});
