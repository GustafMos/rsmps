import { defineNode } from '../../define';
import { asImage, growMask, guidedSmooth, shrinkTo } from '../../lib/mask-util';
import type { ImageValue, MaskValue, NodeGpu } from '../../types';
import { gaussianBlur } from '../filter/blur.node';
import { fillFromValid } from './inpaint.node';

/**
 * Splits ONE image into up to four depth layers for `parallax`, with every layer's hidden parts filled in.
 *
 * Depth source (honest summary):
 *  - Reliable path: wire a depth map (white = near). Any depth estimator output works.
 *  - Heuristic path (no depth map): a cheap cue mix. "Lower in the frame is nearer" (vertical), "sharper/more detailed is
 *    nearer" (local gradient energy, blurred), "more saturated is nearer" and "brighter/darker is nearer"
 *    (signed weight). The cue map is smoothed along image edges with a joint-bilateral filter. It works for landscapes and
 *    stage-like scenes and is plain wrong for many others; tune the weights or supply a depth map.
 *
 * Layer k (1 = back ... N = front): colour = slice k, with the parts occupied by nearer slices filled in from slice k's
 * own pixels (push-pull inpaint). Alpha of layer 1 is 1; alpha of layer k>1 covers slice k and everything nearer, so that
 * when nearer layers move the revealed area shows layer k's fill rather than the wrong layer.
 * Wire: layer1 → parallax Background, layer2…N → parallax Layers in order.
 */

const MAX = 4;

function depthCues(gpu: NodeGpu, work: ImageValue, w: { vertical: number; sharp: number; sat: number; bright: number }): MaskValue {
  const grad = gpu.pass({
    label: 'depth-cues',
    size: work,
    textures: { src: work },
    wgsl: /* wgsl */ `
fn lum(uv: vec2f) -> f32 { return luma(unpremul(textureSampleLevel(src, smp, uv, 0.0)).rgb); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = 1.0 / u.size;
  let gx = lum(uv + vec2f(t.x, 0.0)) - lum(uv - vec2f(t.x, 0.0));
  let gy = lum(uv + vec2f(0.0, t.y)) - lum(uv - vec2f(0.0, t.y));
  let c = unpremul(textureSampleLevel(src, smp, uv, 0.0));
  return vec4f(clamp(length(vec2f(gx, gy)) * 4.0, 0.0, 1.0), rgbToHsv(c.rgb).y, luma(c.rgb), 1.0);
}`,
  });
  const blurred = gaussianBlur(gpu, grad, Math.max(work.width, work.height) * 0.03);
  const total = Math.abs(w.vertical) + Math.abs(w.sharp) + Math.abs(w.sat) + Math.abs(w.bright);
  return gpu.passMask({
    label: 'depth-combine',
    size: work,
    textures: { cues: blurred },
    uniforms: { w: [w.vertical, w.sharp, w.sat, w.bright], norm: total > 1e-4 ? 1 / total : 0 },
    wgsl: /* wgsl */ `
fn pick(w: f32, v: f32) -> f32 { return select(abs(w) * (1.0 - v), w * v, w >= 0.0); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(cues, smp, uv, 0.0);
  var d = uv.y;
  if (u.norm > 0.0) {
    d = (pick(u.w.x, uv.y) + pick(u.w.y, clamp(c.r * 2.5, 0.0, 1.0)) + pick(u.w.z, c.g) + pick(u.w.w, c.b)) * u.norm;
  }
  return vec4f(vec3f(clamp(d, 0.0, 1.0)), 1.0);
}`,
  });
}

/** Depth thresholds from a 64px thumbnail of the depth map (integer histogram). Returns N-1 thresholds in 0..1 plus slice fractions. */
async function thresholds(gpu: NodeGpu, depth: MaskValue, n: number, balanced: boolean): Promise<{ thr: number[]; fraction: number[] }> {
  const thumb = shrinkTo(gpu, depth, 64);
  const px = await gpu.read(thumb, false);
  const hist = new Int32Array(256);
  const total = thumb.width * thumb.height;
  for (let i = 0; i < total; i++) hist[px[i * 4]]++;
  const cum = new Int32Array(256);
  let run = 0;
  for (let i = 0; i < 256; i++) cum[i] = run += hist[i];
  const quantile = (q: number) => {
    const target = Math.round(q * total);
    for (let i = 0; i < 256; i++) if (cum[i] >= target) return i;
    return 255;
  };
  const thr: number[] = [];
  if (balanced) {
    for (let k = 1; k < n; k++) thr.push((quantile(k / n) + 0.5) / 256);
  } else {
    const lo = quantile(0.02);
    const hi = quantile(0.98);
    for (let k = 1; k < n; k++) thr.push((lo + ((hi - lo) * k) / n + 0.5) / 256);
  }
  // Keep thresholds strictly increasing (flat depth maps).
  for (let k = 1; k < thr.length; k++) if (thr[k] < thr[k - 1] + 0.004) thr[k] = thr[k - 1] + 0.004;
  const fraction: number[] = [];
  for (let k = 0; k < n; k++) {
    const lo = k === 0 ? 0 : Math.floor(thr[k - 1] * 256);
    const hi = k === n - 1 ? 256 : Math.floor(thr[k] * 256);
    let c = 0;
    for (let i = lo; i < hi; i++) c += hist[i];
    fraction.push(c / total);
  }
  return { thr, fraction };
}

export default defineNode({
  id: 'depth-slice',
  title: 'Depth Slice',
  category: 'composite',
  description:
    'Splits one image into 2-4 depth layers with their hidden parts filled in, ready for Parallax. Uses a depth map when connected, otherwise a simple cue heuristic (position, sharpness, saturation, brightness).',
  keywords: ['parallax', 'depth map', 'layers', '2.5d', 'split', 'z', 'separate', 'single image'],
  cpu: true,
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    depth: { type: 'image', label: 'Depth map (white = near)' },
  },
  outputs: {
    layer1: { type: 'image', label: 'Layer 1 (back)' },
    layer2: { type: 'image', label: 'Layer 2' },
    layer3: { type: 'image', label: 'Layer 3' },
    layer4: { type: 'image', label: 'Layer 4 (front)' },
    depth: { type: 'mask', label: 'Depth' },
  },
  params: {
    layers: { type: 'number', default: 3, min: 2, max: MAX, step: 1, integer: true, label: 'Layers' },
    distribution: {
      type: 'enum',
      default: 'balanced',
      options: [
        { value: 'balanced', label: 'Balanced (equal area)' },
        { value: 'even', label: 'Even depth ranges' },
      ],
      label: 'Split by',
    },
    invertDepth: { type: 'bool', default: false, label: 'Invert depth', hint: 'Use when the connected map has black = near.' },
    vertical: { type: 'number', default: 1, min: -1, max: 1, step: 0.01, label: 'Lower = nearer', group: 'Heuristic' },
    sharpness: { type: 'number', default: 0.3, min: -1, max: 1, step: 0.01, label: 'Detailed = nearer', group: 'Heuristic' },
    saturation: { type: 'number', default: 0.25, min: -1, max: 1, step: 0.01, label: 'Saturated = nearer', group: 'Heuristic' },
    brightness: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Brighter = nearer', group: 'Heuristic', hint: 'Negative: darker is nearer (hazy distance).' },
    softness: { type: 'number', default: 0.02, min: 0, max: 0.2, step: 0.005, label: 'Boundary softness', hint: 'Depth range over which neighbouring slices cross-fade.' },
    grow: { type: 'number', default: 3, min: 0, max: 100, step: 0.5, unit: 'px', label: 'Grow holes', hint: 'How far past a nearer slice the fill starts.' },
    smoothness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Fill smoothness' },
    texture: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Fill texture' },
  },
  summary: (p) => `${p.layers} layers`,
  async render(ctx) {
    const { gpu } = ctx;
    const img = ctx.in.image;
    const p = ctx.params;
    const n = Math.max(2, Math.min(MAX, Math.round(p.layers)));
    const work = shrinkTo(gpu, img, 512);

    // --- depth map at work resolution, then edge-aware upsample to full resolution -------------------------------
    let raw: MaskValue;
    if (ctx.in.depth) {
      raw = gpu.passMask({
        label: 'depth-input',
        size: work,
        textures: { d: ctx.in.depth },
        uniforms: { inv: p.invertDepth },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(d, smp, uv, 0.0));
  var v = luma(c.rgb);
  if (u.inv > 0.5) { v = 1.0 - v; }
  return vec4f(vec3f(v), 1.0);
}`,
      });
    } else {
      raw = depthCues(gpu, work, { vertical: p.vertical, sharp: p.sharpness, sat: p.saturation, bright: p.brightness });
    }
    const factor = Math.max(1, img.width / work.width);
    const depth = guidedSmooth(gpu, raw, asImage(img), {
      radius: Math.max(3, factor * 1.5 + 2),
      iterations: ctx.in.depth ? 1 : 2,
      colorSigma: 0.12,
    });

    // --- thresholds (small readback) ----------------------------------------------------------------------------------
    const { thr, fraction } = await thresholds(gpu, depth, n, p.distribution === 'balanced');
    const bound = (k: number) => (k <= 0 ? -1 : k >= n ? 2 : thr[k - 1]);
    const s = Math.max(p.softness, 0.002);
    const step = (b: number): MaskValue =>
      gpu.passMask({
        label: 'depth-step',
        size: img,
        textures: { d: depth },
        uniforms: { b, s },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(smoothstep(u.b - u.s, u.b + u.s, textureSampleLevel(d, smp, uv, 0.0).r)), 1.0); }',
      });
    const aboveBound: MaskValue[] = []; // aboveBound[k] = nearer than boundary k (k = 1..n-1)
    for (let k = 1; k < n; k++) aboveBound[k] = step(bound(k));

    const out: Record<string, ImageValue | MaskValue | null> = { depth, layer1: null, layer2: null, layer3: null, layer4: null };
    for (let k = 1; k <= n; k++) {
      // alpha: layer 1 opaque; layer k keeps slice k and everything nearer.
      const alpha = k === 1 ? null : aboveBound[k - 1];
      if (k === n) {
        // Front layer: nothing nearer to fill; just slice n with soft alpha.
        out[`layer${k}`] = applyAlpha(gpu, img, alpha!);
        continue;
      }
      const hole = p.grow > 0.01 ? growMask(gpu, aboveBound[k], p.grow) : aboveBound[k];
      // Trusted pixels: inside slice k (if it has any area), outside the grown nearer region.
      const useSlice = fraction[k - 1] > 0.005;
      const valid = gpu.passMask({
        label: 'depth-valid',
        size: img,
        textures: { hole, lower: k === 1 ? null : aboveBound[k - 1] },
        uniforms: { slice: useSlice },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var v = 1.0 - textureSampleLevel(hole, smp, uv, 0.0).r;
  ${k === 1 ? '' : 'if (u.slice > 0.5) { v *= textureSampleLevel(lower, smp, uv, 0.0).r; }'}
  return vec4f(vec3f(v), 1.0);
}`,
      });
      const filled = fillFromValid(gpu, img, valid, { smoothness: p.smoothness, texture: p.texture, fillAlpha: false });
      out[`layer${k}`] = alpha ? applyAlpha(gpu, filled, alpha) : filled;
    }
    return out as never;
  },
});

/** image x mask (premultiplied scale). */
function applyAlpha(gpu: NodeGpu, image: ImageValue, mask: MaskValue): ImageValue {
  return gpu.pass({
    label: 'depth-alpha',
    size: image,
    textures: { src: image, m: mask },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0) * textureSampleLevel(m, smp, uv, 0.0).r; }',
  });
}
