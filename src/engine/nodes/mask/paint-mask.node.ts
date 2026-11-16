import { defineNode } from '../../define';
import { guidedSmooth, asImage, shrinkTo, resample } from '../../lib/mask-util';
import type { ImageValue, MaskValue, NodeGpu } from '../../types';

/**
 * Hand-painted mask.
 *
 * The `strokes` param is JSON (the UI's brush tool writes it):
 *
 *   [
 *     { "points": [[0.31, 0.40], [0.35, 0.44], ...],   // normalised 0..1 (x right, y down), at least one point
 *       "radius": 0.04,                                // brush radius as a fraction of the SHORTER image side
 *       "add": true },                                 // true = paint (default), false = erase
 *     ...
 *   ]
 *
 * (An object `{ "strokes": [...] }` is accepted too.) Strokes are applied in order. Rendering is on the GPU:
 * segments are packed into a small texture and rasterised as capsules, 128 per pass.
 *
 * "Grow to edges": with an image wired in, painted regions expand over connected pixels whose colour is within
 * `tolerance` (OKLab distance) of the colour under the paint, up to `reach` pixels (a GPU region-growing flood fill),
 * so a rough scribble selects a whole object or sky without tracing its outline.
 */

interface Stroke {
  points: [number, number][];
  radius: number;
  add: boolean;
}

const SEGMENTS_PER_PASS = 128;
const MAX_SEGMENTS = 24000;

export function parseStrokes(raw: unknown): Stroke[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { strokes?: unknown }).strokes) ? (raw as { strokes: unknown[] }).strokes : [];
  const out: Stroke[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { points?: unknown; radius?: unknown; add?: unknown };
    if (!Array.isArray(o.points)) continue;
    const points = o.points
      .filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [p[0], p[1]] as [number, number]);
    if (!points.length) continue;
    out.push({ points, radius: Number.isFinite(o.radius) ? Math.max(0, o.radius as number) : 0.03, add: o.add !== false });
  }
  return out;
}

/** 16-bit fixed point in two bytes, range -0.5..1.5 (strokes may leave the frame). */
function q16(v: number, out: Uint8Array, at: number): void {
  const q = Math.max(0, Math.min(65535, Math.round(((v + 0.5) / 2) * 65535)));
  out[at] = q >> 8;
  out[at + 1] = q & 255;
}

interface Segment {
  a: [number, number];
  b: [number, number];
  r: number;
  add: boolean;
}

function toSegments(strokes: Stroke[], w: number, h: number): Segment[] {
  const segs: Segment[] = [];
  const side = Math.min(w, h);
  for (const s of strokes) {
    const rpx = s.radius * side;
    const minStep = Math.max(0.75, rpx * 0.3);
    let prev = s.points[0];
    if (s.points.length === 1) segs.push({ a: prev, b: prev, r: s.radius, add: s.add });
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i];
      const last = i === s.points.length - 1;
      if (!last && Math.hypot((p[0] - prev[0]) * w, (p[1] - prev[1]) * h) < minStep) continue;
      segs.push({ a: prev, b: p, r: s.radius, add: s.add });
      prev = p;
    }
  }
  return segs.length > MAX_SEGMENTS ? segs.filter((_, i) => i % Math.ceil(segs.length / MAX_SEGMENTS) === 0) : segs;
}

/** Rasterise strokes into a mask of the given size. Exported for reuse. */
export function paintStrokes(gpu: NodeGpu, size: { width: number; height: number; unit: number }, strokes: Stroke[], softness: number): MaskValue {
  let acc = gpu.passMask({ label: 'paint-clear', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }' });
  const segs = toSegments(strokes, size.width, size.height);
  for (let start = 0; start < segs.length; start += SEGMENTS_PER_PASS) {
    const chunk = segs.slice(start, start + SEGMENTS_PER_PASS);
    const bytes = new Uint8Array(chunk.length * 3 * 4);
    chunk.forEach((s, i) => {
      const o = i * 12;
      q16(s.a[0], bytes, o);
      q16(s.a[1], bytes, o + 2);
      q16(s.b[0], bytes, o + 4);
      q16(s.b[1], bytes, o + 6);
      const rq = Math.max(0, Math.min(65535, Math.round(s.r * 65535)));
      bytes[o + 8] = rq >> 8;
      bytes[o + 9] = rq & 255;
      bytes[o + 10] = s.add ? 255 : 0;
      bytes[o + 11] = 255;
    });
    const segTex = gpu.upload(bytes, chunk.length * 3, 1, 1, false);
    acc = gpu.passMask({
      label: 'paint-strokes',
      size,
      textures: { prev: acc, segs: segTex },
      uniforms: { count: chunk.length, soft: Math.max(softness, 1) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var m = textureLoad(prev, vec2i(floor(px)), 0).r;
  let side = min(u.size.x, u.size.y);
  for (var i = 0; i < i32(u.count); i++) {
    let t0 = textureLoad(segs, vec2i(i * 3, 0), 0);
    let t1 = textureLoad(segs, vec2i(i * 3 + 1, 0), 0);
    let t2 = textureLoad(segs, vec2i(i * 3 + 2, 0), 0);
    let a = vec2f(round(t0.x * 255.0) * 256.0 + round(t0.y * 255.0), round(t0.z * 255.0) * 256.0 + round(t0.w * 255.0)) / 65535.0 * 2.0 - 0.5;
    let b = vec2f(round(t1.x * 255.0) * 256.0 + round(t1.y * 255.0), round(t1.z * 255.0) * 256.0 + round(t1.w * 255.0)) / 65535.0 * 2.0 - 0.5;
    let r = (round(t2.x * 255.0) * 256.0 + round(t2.y * 255.0)) / 65535.0 * side;
    let pa = a * u.size;
    let pb = b * u.size;
    let ba = pb - pa;
    let h = clamp(dot(px - pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    let d = length(px - pa - ba * h);
    let c = clamp((r - d) / u.soft + 0.5, 0.0, 1.0);
    if (t2.z > 0.5) { m = max(m, c); } else { m = min(m, 1.0 - c); }
  }
  return vec4f(vec3f(m), 1.0);
}`,
    });
  }
  return acc;
}

/** Iterative GPU region growing (see file header). `reach` and the work size are in work-resolution texels. */
function growRegions(gpu: NodeGpu, painted: MaskValue, img: ImageValue, tolerance: number, reachFull: number): MaskValue {
  const work = shrinkTo(gpu, img, 512);
  const scale = work.width / img.width;
  const iterations = Math.min(300, Math.max(1, Math.round(reachFull * scale)));
  const paintedWork = resample(gpu, painted, work.width, work.height);
  let state = gpu.pass({
    label: 'grow-init',
    size: work,
    format: 'rgba16float',
    textures: { src: work, paint: paintedWork },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let on = textureSampleLevel(paint, smpNearest, uv, 0.0).r > 0.5;
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  return select(vec4f(0.0), vec4f(c.rgb, 1.0), on);
}`,
  });
  const step = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let ip = vec2i(floor(px));
  let dims = vec2i(textureDimensions(st));
  let own = textureLoad(st, ip, 0);
  if (own.a > 0.5) { return own; }
  let me = srgbToOklab(unpremul(textureLoad(src, ip, 0)).rgb);
  var best = 1e9;
  var seed = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let q = ip + vec2i(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= dims.x || q.y >= dims.y) { continue; }
      let n = textureLoad(st, q, 0);
      if (n.a < 0.5) { continue; }
      let d = length(me - srgbToOklab(n.rgb));
      if (d < best) { best = d; seed = n.rgb; }
    }
  }
  if (best <= u.tol) { return vec4f(seed, 1.0); }
  return vec4f(0.0);
}`;
  for (let i = 0; i < iterations; i++) {
    state = gpu.pass({ label: 'grow-step', size: work, format: 'rgba16float', textures: { st: state, src: work }, uniforms: { tol: tolerance }, wgsl: step });
  }
  const cover = gpu.passMask({
    label: 'grow-cover',
    size: work,
    textures: { st: state },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(textureLoad(st, vec2i(floor(px)), 0).a), 1.0); }',
  });
  // Upsample with edge snapping against the full-resolution image, then keep everything that was painted.
  const snapped = guidedSmooth(gpu, cover, asImage(img), { radius: Math.max(3, (1 / scale) * 1.5 + 1.5), iterations: 2, colorSigma: 0.1 });
  return gpu.passMask({
    label: 'grow-merge',
    size: painted,
    textures: { grown: snapped, painted },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let g = smoothstep(0.35, 0.65, textureSampleLevel(grown, smp, uv, 0.0).r);
  return vec4f(vec3f(max(g, textureSampleLevel(painted, smpNearest, uv, 0.0).r)), 1.0);
}`,
  });
}

export default defineNode({
  id: 'paint-mask',
  title: 'Paint Mask',
  category: 'mask',
  description: 'A mask painted with brush strokes (edited by the brush tool). Optionally grows the strokes over similar colours in the image.',
  keywords: ['brush', 'draw', 'scribble', 'select', 'magic wand', 'region grow', 'manual'],
  inputs: { image: { type: 'image', label: 'Image (size / grow guide)' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    strokes: { type: 'json', default: [], label: 'Strokes', hint: '[{ points: [[x,y]...] (0..1), radius (fraction of the short side), add: boolean }]' },
    softness: { type: 'number', default: 1, min: 0, max: 200, step: 0.5, unit: 'px', label: 'Brush softness' },
    grow: { type: 'bool', default: false, label: 'Grow to edges', hint: 'Needs an image. Expands the painted area over similar colours.' },
    tolerance: { type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005, label: 'Color tolerance', visibleIf: (p) => p.grow === true },
    reach: { type: 'number', default: 150, min: 1, max: 1500, step: 1, unit: 'px', label: 'Max reach', visibleIf: (p) => p.grow === true },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `${parseStrokes(p.strokes).length} strokes${p.grow ? ' · grow' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const ref = ctx.in.image ?? ctx.canvas;
    const size = { width: ref.width, height: ref.height, unit: ref.unit };
    const strokes = parseStrokes(p.strokes);
    let mask = paintStrokes(ctx.gpu, size, strokes, p.softness);
    if (p.grow && ctx.in.image && strokes.some((s) => s.add)) mask = growRegions(ctx.gpu, mask, ctx.in.image, p.tolerance, p.reach);
    if (p.invert) {
      mask = ctx.gpu.passMask({
        label: 'paint-invert',
        size,
        textures: { src: mask },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(1.0 - textureSampleLevel(src, smpNearest, uv, 0.0).r), 1.0); }',
      });
    }
    return { mask };
  },
});
