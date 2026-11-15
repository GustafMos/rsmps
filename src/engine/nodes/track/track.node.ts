/**
 * Track — gives regions an identity that survives from frame to frame.
 *
 * HOW IT WORKS (and the honest limitation): nodes are stateless, so this node cannot remember last frame.
 * Instead, for every frame it renders it pulls the incoming regions at the frames BEFORE this one (from a
 * "starting point" up to now), matches them forward frame by frame (nearest predicted centre / overlap,
 * greedy, same label), and gives every object that starts a chain an id derived deterministically from where
 * and when it first appeared. Same inputs always give the same ids, so playback, scrubbing and export agree.
 *
 * LIMITATIONS
 *  - Ids are stable inside the look-back window, not globally. The starting point is the last multiple of
 *    "Keep ids for (frames)" minus the "Look-back window"; an object that lives longer than that gets a new id
 *    when the window moves (every `history` frames). Raise "Keep ids for" to cover the whole clip for exports;
 *    the cost is one regions evaluation per window frame (cached, but not free).
 *  - Objects that touch, cross at similar speeds, or vanish for longer than "Hold" frames can swap or lose ids.
 *  - In a looping project the window wraps around the loop, so ids are consistent across the loop seam.
 */
import { defineNode } from '../../define';
import { validRegions } from '../../lib/track-core';
import { runTracker } from '../../lib/track-tracker';
import { wrapSeconds } from '../../lib/util-time';
import type { Region } from '../../types';

export default defineNode({
  id: 'track',
  title: 'Track',
  category: 'track',
  description:
    'Gives every detected region a stable id that follows it from frame to frame, with optional smoothing and hold-over when a detection blinks out. Ids are stable within a look-back window, not globally.',
  keywords: ['track', 'id', 'follow', 'identity', 'smooth', 'stabilise', 'stabilize', 'hold'],
  cpu: true,
  inputs: { regions: { type: 'regions', required: true, label: 'Regions' } },
  outputs: { regions: { type: 'regions', label: 'Tracked regions' } },
  params: {
    memory: { type: 'number', default: 8, min: 1, max: 60, step: 1, integer: true, label: 'Look-back window (frames)', hint: 'Extra frames looked at before the start of the id window, so matching and smoothing are warmed up.' },
    history: { type: 'number', default: 120, min: 0, max: 2000, step: 10, integer: true, label: 'Keep ids for (frames)', hint: 'How long an object keeps the same id. Longer is steadier but evaluates more frames per render.' },
    maxMove: { type: 'number', default: 0.12, min: 0.005, max: 1, step: 0.005, unit: 'norm', label: 'Biggest move per frame', hint: 'Fraction of the frame an object may travel between frames and still be the same object.' },
    smooth: { type: 'number', default: 0.35, min: 0, max: 0.95, step: 0.05, label: 'Smoothing', hint: '0 follows the detections exactly; higher values calm jitter but lag a little.' },
    hold: { type: 'number', default: 4, min: 0, max: 60, step: 1, integer: true, label: 'Hold for (frames)', hint: 'Keep showing a region this long after its detection disappears, fading its score.' },
    matchLabels: { type: 'bool', default: true, label: 'Only match same label' },
  },
  summary: (p) => `smooth ${p.smooth} · hold ${p.hold}f`,
  async render(ctx) {
    const p = ctx.params;
    const { frame, fps, duration, loop } = ctx.time;
    const total = Math.max(1, Math.round(duration * fps));
    const span = Math.max(p.history, p.memory, 1);
    let start = Math.floor(frame / span) * span - p.memory;
    if (!loop) start = Math.max(0, start);
    const seq: Region[][] = [];
    for (let g = start; g <= frame; g++) {
      const seconds = loop ? wrapSeconds(g / fps, duration, fps) : Math.max(0, g) / fps;
      const v = g === frame ? ctx.in.regions : await ctx.pull('regions', { seconds });
      seq.push(validRegions(v?.items));
    }
    const items = runTracker(seq, start, {
      maxMove: p.maxMove,
      smooth: p.smooth,
      hold: p.hold,
      matchLabels: p.matchLabels,
      loopFrames: loop ? total : 0,
    });
    return { regions: { kind: 'regions', items } };
  },
});
