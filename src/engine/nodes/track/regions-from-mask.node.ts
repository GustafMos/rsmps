import { defineNode } from '../../define';
import { DETECT_PARAMS } from '../../lib/track-core';
import { regionsFromStrength } from '../../lib/track-detect';

export default defineNode({
  id: 'regions-from-mask',
  title: 'Regions From Mask',
  category: 'track',
  description:
    'Turns any mask into regions: every separate white island becomes a region with a box. This makes every mask node (subject, color key, painted mask...) a detector you can track and decorate.',
  keywords: ['mask', 'regions', 'detect', 'blobs', 'islands', 'connected', 'components', 'boxes', 'subject'],
  cpu: true,
  guide: {
    does: 'Turns every separate white area of a mask into a region (a box you can track and decorate).',
    steps: [
      'Wire any mask into Mask (white parts): a subject cut-out, a color key, a painted mask.',
      'Wire Regions into Track, then into Effects On Regions or Region Overlay.',
    ],
    needs: [
      { input: 'mask', hint: 'The mask whose white areas become regions.' },
    ],
    seeAlso: ['track', 'region-fx', 'detect-blobs'],
  },
  inputs: { mask: { type: 'mask', required: true, label: 'Mask (white parts)' } },
  outputs: { regions: { type: 'regions', label: 'Regions' } },
  params: {
    threshold: { type: 'number', default: 0.5, min: 0.01, max: 0.99, step: 0.01, label: 'Threshold', hint: 'Mask values above this count as inside.' },
    label: { type: 'string', default: 'mask', label: 'Label' },
    ...DETECT_PARAMS,
  },
  summary: (p) => `mask > ${p.threshold}`,
  async render(ctx) {
    const p = ctx.params;
    // Re-centre the chosen threshold on 0.5, which is where the analysis cuts.
    const m = ctx.in.mask;
    const strength = ctx.gpu.pass({
      label: 'regions-from-mask',
      size: m,
      textures: { src: m },
      uniforms: { thr: p.threshold },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let v = textureSampleLevel(src, smp, uv, 0.0).r; let s = clamp(0.5 + (v - u.thr) * 8.0, 0.0, 1.0); return vec4f(s, s, s, 1.0); }',
    });
    return { regions: { kind: 'regions', items: await regionsFromStrength(ctx.gpu, strength, p, p.label) } };
  },
});
