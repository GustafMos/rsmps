import { defineNode } from '../../define';
import { analyseSubject, subjectScore } from '../../lib/mask-subject-gpu';
import { asImage, blurMask, guidedSmooth, shrinkTo } from '../../lib/mask-util';
import type { MaskValue } from '../../types';

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
    centerBias: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Center bias', hint: 'Favour the middle of the frame over the edges.' },
    cleanup: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Remove islands', hint: 'Drops separate regions smaller than this share of the main one.' },
    regions: {
      type: 'enum',
      default: 'subject',
      options: [
        { value: 'subject', label: 'Main + nearby' },
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
    // --- 1. analysis on a thumbnail (shared with Depth from Picture: lib/mask-subject-gpu.ts) --------------------------
    const analysis = await analyseSubject(gpu, img, { sensitivity: p.sensitivity, centerBias: p.centerBias, cleanup: p.cleanup, regions: p.regions as 'all' | 'subject' | 'largest', fillHoles: p.fillHoles });

    // --- 2. work-resolution score, gated by the region decisions --------------------------------------------------
    const work = shrinkTo(gpu, img, MAX_WORK);
    const gated: MaskValue = subjectScore(gpu, work, analysis, true);

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
