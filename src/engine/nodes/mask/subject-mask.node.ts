import { defineNode } from '../../define';
import {
  dilateBin,
  erodeBin,
  kmeans,
  LAB_A_MIN,
  LAB_A_RANGE,
  MODEL_SLOTS,
  packModels,
  selectSubject,
  type Cluster,
} from '../../lib/mask-subject';
import { asImage, blurMask, fitTo, guidedSmooth, shrinkTo } from '../../lib/mask-util';
import type { ImageValue, MaskValue, NodeGpu } from '../../types';

/**
 * Automatic subject extraction.
 *
 *  1. A <=128px thumbnail is read back. Its border ring is clustered in OKLab (deterministic k-means++) into a
 *     background colour model.
 *  2. A GPU pass scores every pixel by its distance to the nearest background cluster (tolerance grows with the
 *     cluster's own spread, so noisy or gradient backgrounds work), combined with a centre prior and the image alpha.
 *  3. The thumbnail score is read back once more: connected regions are ranked (size, centrality), small islands are
 *     dropped and enclosed pockets (white highlights inside the subject) are filled. The kept subject colours and all
 *     confident background pixels then re-fit BOTH colour models (a GrabCut-style second round) and the score is recomputed.
 *  4. The final score is computed at <=512px, gated by the island/hole decisions, upsampled to full resolution with a
 *     joint-bilateral filter guided by the full-resolution image so the edge snaps to real colour edges, then sharpened
 *     and optionally softened.
 *
 * Honest limits: it separates a subject from a background that is distinguishable by colour. A subject whose colours
 * match the background, or a very busy background that is not represented in the image border, will not separate.
 */

const MAX_WORK = 512;
const THUMB = 128;

interface Models {
  bg: Cluster[];
  fg: Cluster[];
}

function scorePass(gpu: NodeGpu, src: ImageValue, m: Models, tol: number, centreBias: number): MaskValue {
  const models = gpu.dataTexture(packModels(m.bg, m.fg), MODEL_SLOTS, 2);
  return gpu.passMask({
    label: 'subject-score',
    size: src,
    textures: { src, models },
    uniforms: { nb: Math.min(MODEL_SLOTS, m.bg.length), nf: Math.min(MODEL_SLOTS, m.fg.length), tol, cb: centreBias },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smp, uv, 0.0));
  let lab = srgbToOklab(c.rgb);
  var dB = 10.0;
  var dF = 10.0;
  for (var i = 0; i < 16; i++) {
    if (f32(i) < u.nb) {
      let m = textureLoad(models, vec2i(i, 0), 0);
      dB = min(dB, length(lab - m.xyz) / (u.tol + min(2.2 * m.w, 0.06)));
    }
    if (f32(i) < u.nf) {
      let m = textureLoad(models, vec2i(i, 1), 0);
      dF = min(dF, length(lab - m.xyz) / (u.tol + min(2.2 * m.w, 0.06)));
    }
  }
  var s = smoothstep(0.8, 1.5, dB);
  if (u.nf > 0.5) {
    let r = dB * dB / (dB * dB + dF * dF + 1e-4);
    s *= clamp(r * 1.4, 0.0, 1.0);
  }
  let e = length((uv - 0.5) * 2.0);
  s *= 1.0 - u.cb * smoothstep(0.7, 1.25, e);
  s *= c.a;
  return vec4f(vec3f(s), 1.0);
}`,
  });
}

export default defineNode({
  id: 'subject-mask',
  title: 'Subject Mask',
  category: 'mask',
  description:
    'Finds the main subject automatically by learning the background colours from the image border, refining the result with the subject colours and snapping the edge to the image. Output: mask (1 = subject).',
  keywords: ['extract', 'remove background', 'saliency', 'cutout', 'segment', 'foreground', 'feature extraction', 'matte'],
  cpu: true,
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Subject' } },
  params: {
    sensitivity: { type: 'number', default: 0.65, min: 0, max: 1, step: 0.01, label: 'Sensitivity', hint: 'Higher separates colours that are closer to the background.' },
    centerBias: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Centre bias', hint: 'Favour the middle of the frame over the edges.' },
    cleanup: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Remove islands', hint: 'Drops separate regions smaller than this share of the main one.' },
    regions: {
      type: 'enum',
      default: 'subject',
      options: [
        { value: 'subject', label: 'Main subject + nearby parts' },
        { value: 'largest', label: 'Largest region only' },
        { value: 'all', label: 'All large regions' },
      ],
      label: 'Keep',
    },
    fillHoles: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Fill holes', hint: 'Fills enclosed background-coloured pockets inside the subject (highlights, eyes).' },
    edgeSnap: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Edge snap', hint: 'How strongly the edge follows colour edges in the full-resolution image.' },
    softness: { type: 'number', default: 0.5, min: 0, max: 100, step: 0.1, unit: 'px', label: 'Edge softness' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  summary: (p) => `sens ${p.sensitivity.toFixed(2)}`,
  async render(ctx) {
    const { gpu } = ctx;
    const p = ctx.params;
    const img = ctx.in.image;
    const tol = 0.12 - 0.09 * p.sensitivity;

    // --- 1. analysis on a thumbnail -----------------------------------------------------------------------------
    const thumb = fitTo(gpu, img, THUMB);
    // OKLab is computed on the GPU and read back as bytes (L, a, b, alpha): the CPU side only does integer work.
    const labTex = gpu.pass({
      label: 'subject-lab',
      size: thumb,
      textures: { src: thumb },
      uniforms: { amin: LAB_A_MIN, arange: LAB_A_RANGE },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let l = srgbToOklab(c.rgb);
  return vec4f(l.x, (l.y - u.amin) / u.arange, (l.z - u.amin) / u.arange, c.a);
}`,
    });
    const px = await gpu.read(labTex, false);
    const tw = thumb.width;
    const th = thumb.height;
    const n = tw * th;
    const opaque = (i: number) => px[i * 4 + 3] >= 128;
    const ringW = Math.max(1, ((Math.min(tw, th) * 4 + 50) / 100) | 0);
    const gather = (pred: (i: number, x: number, y: number) => boolean): Uint8Array => {
      const out = new Uint8Array(n * 3);
      let m = 0;
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++) {
          const i = y * tw + x;
          if (opaque(i) && pred(i, x, y)) {
            out[m++] = px[i * 4];
            out[m++] = px[i * 4 + 1];
            out[m++] = px[i * 4 + 2];
          }
        }
      return out.subarray(0, m);
    };
    const inRing = (_i: number, x: number, y: number) => x < ringW || y < ringW || x >= tw - ringW || y >= th - ringW;
    const ringPts = gather(inRing);
    const models: Models = { bg: ringPts.length >= 18 ? kmeans(ringPts, 16, 1.5) : [], fg: [] };

    const selOpts = { minRatio: p.cleanup * 0.3, mode: p.regions as 'all' | 'subject' | 'largest', holeFraction: p.fillHoles };
    let sel = null as ReturnType<typeof selectSubject> | null;
    for (let round = 0; round < 2; round++) {
      const sc = await gpu.read(scorePass(gpu, thumb, models, tol, p.centerBias), false);
      const score = new Uint8Array(n);
      for (let i = 0; i < n; i++) score[i] = sc[i * 4];
      sel = selectSubject(score, tw, th, selOpts);
      if (round === 0) {
        if (sel.area < 6 || sel.area * 100 > 92 * n) break;
        // Learn the subject colours from the confident core (the background model stays the border-only one: re-learning
        // it from far-away pixels lets bright distractors, which often share colours with the subject, swallow it).
        const core = erodeBin(sel.fg, tw, th, sel.area > 150 ? 1 : 0);
        const fgPts = gather((i) => core[i] === 1 || sel!.holes[i] === 1);
        if (fgPts.length >= 18) models.fg = kmeans(fgPts, 10, 2, 11);
      }
    }

    // --- 2. work-resolution score, gated by the region decisions --------------------------------------------------
    const work = shrinkTo(gpu, img, MAX_WORK);
    const raw = scorePass(gpu, work, models, tol, p.centerBias);

    let gated: MaskValue = raw;
    if (sel && sel.area > 0) {
      const roi = dilateBin(sel.fg, tw, th, 2);
      const fill = dilateBin(sel.holes, tw, th, 1);
      const zone = dilateBin(sel.fg, tw, th, 1);
      const bytes = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) bytes.set([roi[i] ? 255 : 0, fill[i] ? 255 : 0, zone[i] ? 255 : 0, 255], i * 4);
      const gate = gpu.upload(bytes, tw, th, 1, false);
      gated = gpu.passMask({
        label: 'subject-gate',
        size: raw,
        textures: { score: raw, gate },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let g = textureSampleLevel(gate, smp, uv, 0.0);
  let s = textureSampleLevel(score, smpNearest, uv, 0.0).r;
  let strong = s * smoothstep(0.15, 0.7, g.r);
  let weak = smoothstep(0.15, 0.4, s) * smoothstep(0.3, 0.8, g.b);
  return vec4f(vec3f(max(max(strong, weak), smoothstep(0.3, 0.7, g.g))), 1.0);
}`,
      });
    } else if (sel && sel.area === 0) {
      gated = gpu.passMask({ label: 'subject-empty', size: raw, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }' });
    }

    // --- 3. edge-aware upsample + snap, sharpen, soften -----------------------------------------------------------------
    const factor = Math.max(img.width / work.width, 1);
    let mask: MaskValue = gated;
    if (p.edgeSnap > 0.001) {
      const radius = Math.max(3, (factor * 1.5 + 1.5) * (0.5 + p.edgeSnap));
      mask = guidedSmooth(gpu, gated, asImage(img), { radius, iterations: p.edgeSnap > 0.5 ? 3 : 2, colorSigma: 0.14 });
    } else if (factor > 1) {
      mask = { ...gpu.pass({ label: 'subject-up', size: img, textures: { src: gated }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }' }), kind: 'mask' };
    }
    const sharp = gpu.passMask({
      label: 'subject-sharpen',
      size: mask,
      textures: { src: mask },
      uniforms: { inv: p.invert, soft: p.edgeSnap > 0.001 ? 1 : 0 },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var v = textureSampleLevel(src, smpNearest, uv, 0.0).r;
  if (u.soft > 0.5) { v = smoothstep(0.3, 0.7, v); }
  if (u.inv > 0.5) { v = 1.0 - v; }
  return vec4f(vec3f(v), 1.0);
}`,
    });
    return { mask: blurMask(gpu, sharp, p.softness) };
  },
});
