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
 *
 * PROCESS MODE ("Analyse clip"): the limitation above goes away once the user runs the node's process. The job pulls the regions of
 * every frame of the clip once, runs the tracker over the WHOLE clip in one pass (ids are global, from frame 0) and stores the tracked
 * regions of every frame. Afterwards the node serves them straight from the store: the detection upstream is not evaluated at all
 * (the input is `lazy`), tracking is instant, and an export gives exactly what the viewer showed. Until then (and while stale) the
 * windowed tracker above is the stand-in ('preview'), so nothing changes for projects that never run it.
 */
import { defineNode } from '../../define';
import { validRegions } from '../../lib/track-core';
import { runTracker, runTrackerAll } from '../../lib/track-tracker';
import { stableStringify } from '../../lib/stable-json';
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
  inputs: { regions: { type: 'regions', required: true, lazy: true, label: 'Regions' } },
  outputs: { regions: { type: 'regions', label: 'Tracked regions' } },
  params: {
    memory: { type: 'number', default: 8, min: 1, max: 60, step: 1, integer: true, label: 'Look-back', hint: 'Extra frames looked at before the start of the id window, so matching and smoothing are warmed up.' },
    history: { type: 'number', default: 120, min: 0, max: 2000, step: 10, integer: true, label: 'Keep ids', hint: 'How long an object keeps the same id. Longer is steadier but evaluates more frames per render.' },
    maxMove: { type: 'number', default: 0.12, min: 0.005, max: 1, step: 0.005, unit: 'norm', label: 'Max move', hint: 'Fraction of the frame an object may travel between frames and still be the same object.' },
    smooth: { type: 'number', default: 0.35, min: 0, max: 0.95, step: 0.05, label: 'Smoothing', hint: '0 follows the detections exactly; higher values calm jitter but lag a little.' },
    hold: { type: 'number', default: 4, min: 0, max: 60, step: 1, integer: true, label: 'Hold', hint: 'Keep showing a region this long after its detection disappears, fading its score.' },
    matchLabels: { type: 'bool', default: true, label: 'Match labels', hint: 'Only match detections with the same label.' },
  },
  summary: (p) => `smooth ${p.smooth} · hold ${p.hold}f`,
  process: {
    title: 'Analyse clip',
    description: 'Detect and track through the whole clip once. Afterwards tracking is instant and identical in the export.',
    standIn: 'preview',
    required: 'once-run',
    gpu: false,
    signature: (p, sigs) => `${stableStringify({ maxMove: p.maxMove, smooth: p.smooth, hold: p.hold, matchLabels: p.matchLabels })}|${sigs.regions}`,
    estimate: (_p, project) => ({ frames: Math.max(1, Math.round(project.duration * project.fps)), note: 'one detection per frame, then a single tracking pass' }),
    async run(job) {
      const p = job.params;
      const total = job.frames;
      const seq: Region[][] = [];
      for (let f = 0; f < total; f++) {
        await job.yield();
        const pulled = await job.pull('regions', { frame: f, quality: 'final' });
        try {
          const err = [...pulled.errors.values()][0];
          if (err) throw new Error(err);
          seq.push(validRegions((pulled.value as { items?: Region[] } | null)?.items));
        } finally {
          pulled.release();
        }
        job.progress((f + 1) / (total + 1), `Detecting frame ${f + 1} of ${total}`, { frame: f + 1, frames: total });
      }
      job.progress(total / (total + 1), 'Tracking');
      const regions = runTrackerAll(seq, 0, { maxMove: p.maxMove, smooth: p.smooth, hold: p.hold, matchLabels: p.matchLabels, loopFrames: job.loop ? total : 0 });
      job.store.json('tracks', { frames: total, regions });
      return { meta: { frames: total, item: job.item.index } };
    },
  },
  async render(ctx) {
    const p = ctx.params;
    const { frame, fps, duration, loop } = ctx.time;
    const total = Math.max(1, Math.round(duration * fps));
    const ps = ctx.process;
    if (ps?.servable && ps.result) {
      const done = await ps.json<{ frames: number; regions: Region[][] }>('tracks');
      if (done && done.regions.length > 0 && (ps.result.meta.item === undefined || ps.result.meta.item === ctx.item.index)) {
        const n = done.regions.length;
        const idx = loop ? ((frame % n) + n) % n : Math.min(n - 1, Math.max(0, frame));
        return { regions: { kind: 'regions', items: done.regions[idx] ?? [] } };
      }
    }
    const span = Math.max(p.history, p.memory, 1);
    let start = Math.floor(frame / span) * span - p.memory;
    if (!loop) start = Math.max(0, start);
    const seq: Region[][] = [];
    for (let g = start; g <= frame; g++) {
      const seconds = loop ? wrapSeconds(g / fps, duration, fps) : Math.max(0, g) / fps;
      const v = await ctx.pull('regions', { seconds });
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
