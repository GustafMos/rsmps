import { defineNode } from '../../define';
import { runTransition, transitionParams, type TransitionSettings } from '../../lib/fx-transition';

export default defineNode({
  id: 'transition',
  title: 'Morph / Transition',
  category: 'filter',
  description:
    'Changes from picture A to picture B with a chosen style: dither dissolves (ordered, blue-noise, halftone dots, mosaic, pixelate-through), wipes (luma, iris, clock, burn, ripple), warps (zoom, melt, liquid, push, spin) and glitch cuts. Progress 0 is exactly A and 1 is exactly B. Wire an Animate, Keyframes or Sound to Numbers node into Progress to drive it. A and B can have different sizes: B is fitted to A.',
  keywords: ['transition', 'morph', 'dissolve', 'wipe', 'dither', 'blend', 'switch', 'cut', 'crossfade', 'mosaic', 'halftone', 'burn', 'glitch', 'iris', 'push', 'luma wipe', 'melt', 'between two clips'],
  inputs: {
    a: { type: 'image', required: true, label: 'A (from)' },
    b: { type: 'image', required: true, label: 'B (to)' },
    map: { type: 'image', label: 'Map (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    ...transitionParams,
    progress: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.001, label: 'Progress', hint: '0 = picture A, 1 = picture B. Wire a number here to animate it.' },
  },
  summary: (p) => `${p.mode} · ${Math.round(p.progress * 100)}%`,
  render(ctx) {
    const p = ctx.params as unknown as TransitionSettings & { progress: number };
    return { image: runTransition(ctx.gpu, ctx.in.a, ctx.in.b, ctx.in.map, p, p.progress) };
  },
});
