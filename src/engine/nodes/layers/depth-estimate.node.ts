import { defineNode } from '../../define';
import { DEPTH_PARAMS, renderDepthHeuristic, type DepthHeuristicCtx, type DepthHeuristicParams } from '../../lib/depth-heuristic';

/**
 * Depth from Picture: an instant, no-download GUESS of how far away every part of a picture is, built from cheap visual cues.
 * Output convention (lib/depth.ts): white = near, black = far, r = g = b in 0..1, rgba16float. Not a measurement: a layered
 * depth that makes Picture to Splats / Lens Blur / Depth Slice / Image to 3D relief look plausible. The optional AI Depth node
 * (`depth-ai`) plugs into the same sockets and uses this very estimate as its stand-in until its model has run.
 *
 * The pipeline, the cue presets and the parameter schema live in `lib/depth-heuristic.ts` (shared with AI Depth).
 */
export default defineNode({
  id: 'depth-estimate',
  title: 'Depth from Picture',
  category: 'composite',
  description:
    'Guesses how far away every part of a picture is from cheap visual cues (lower in frame is nearer, sharp is nearer, the subject is nearer, haze is farther, motion, brightness, color) and makes a depth map: white = near, black = far. Instant, nothing to download. It is a layered GUESS, not a measurement: good enough to give Picture to Splats, Lens Blur, Depth Slice or Image to 3D relief believable depth from one photo. For depth from a neural model, use AI Depth (optional download, runs on your own GPU).',
  keywords: ['depth map', 'z depth', 'estimate', '2.5d', 'parallax', 'monocular', 'guess', 'distance', 'depth', 'photo to 3d', 'near far', 'relief', 'midas', 'depth anything'],
  cpu: true,
  inputs: {
    image: { type: 'image', required: true, label: 'Picture' },
    subjectMask: { type: 'mask', label: 'Subject mask' },
    nearer: { type: 'mask', label: 'Nearer paint' },
    farther: { type: 'mask', label: 'Farther paint' },
    flow: { type: 'image', label: 'Flow' },
  },
  outputs: { depth: { type: 'image', label: 'Depth' }, preview: { type: 'image', label: 'Preview' } },
  optionalOutputs: ['preview'],
  params: DEPTH_PARAMS,
  summary: (p, wired) => `${p.preset !== 'custom' ? p.preset : 'custom cues'}${wired?.has('flow') && p.motion > 0 ? ' + motion' : ''}`,
  async render(ctx) {
    return renderDepthHeuristic(ctx as unknown as DepthHeuristicCtx, ctx.params as unknown as DepthHeuristicParams);
  },
});
