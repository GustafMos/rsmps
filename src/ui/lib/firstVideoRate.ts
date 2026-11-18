import { DEFAULT_PROJECT, type GraphDoc } from '../../engine/types';

/** What the rule needs to know about a media file. */
export interface RateInfo {
  kind: string;
  fps: number;
}

/** The first video file held by any Media In of the graph (current batch order), or null. */
function firstVideo(g: GraphDoc, info: (assetId: string) => RateInfo | undefined): RateInfo | null {
  for (const n of g.nodes) {
    if (n.type !== 'media-in' || !Array.isArray(n.params.assets)) continue;
    for (const id of n.params.assets) {
      const a = typeof id === 'string' ? info(id) : undefined;
      if (a?.kind === 'video') return a;
    }
  }
  return null;
}

/**
 * The frame rate a project should take when its FIRST video arrives, or null to leave it alone.
 *
 * A new project plays at 24 fps. A 25 or 30 fps clip in it drops or repeats a frame every second until the rate is set by
 * hand, every time. So: when an edit brings the first video into a graph that had none, and the project still has the
 * untouched default rate, the project takes the clip's rate (whole frames per second, as the FPS field holds: 29.97 is 30).
 * A rate the user set, a project that already has a video, and an edit that changes the rate itself are never touched.
 */
export function rateForFirstVideo(prev: GraphDoc, next: GraphDoc, info: (assetId: string) => RateInfo | undefined): number | null {
  if (prev.project.fps !== DEFAULT_PROJECT.fps || next.project.fps !== DEFAULT_PROJECT.fps) return null;
  if (firstVideo(prev, info)) return null;
  const clip = firstVideo(next, info);
  if (!clip || !Number.isFinite(clip.fps) || clip.fps <= 0) return null;
  const fps = Math.min(120, Math.max(1, Math.round(clip.fps)));
  return fps === DEFAULT_PROJECT.fps ? null : fps;
}
