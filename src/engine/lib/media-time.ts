/**
 * Clip-time mapping of Media In, shared by the picture (`render`) and the sound (`audio` kernel) so the two can never drift apart.
 * Pure: no imports. Seconds throughout.
 *
 *   local  = (transport seconds + offset) * rate             rate = fps / clip fps (1 when fps = 0 or unknown)
 *   source = a + (loop ? local wrapped into [0, span) : local clamped to [0, span))     a = in point, span = out - in
 */

export interface ClipInfo {
  /** Clip length in seconds. */
  duration: number;
  /** The clip's own frame rate (0 = unknown). */
  fps: number;
}

export interface ClipParams {
  /** In / out as fractions of the clip (either order). */
  trim: readonly [number, number] | number[];
  /** Play at this many of the clip's frames per second (0 = native). */
  fps: number;
  /** Start offset, seconds. */
  offset: number;
  loopVideo: boolean;
}

export interface ClipMap {
  /** In point, seconds into the clip. */
  a: number;
  /** Length of the trimmed span, seconds. */
  span: number;
  /** Playback speed: 12 on a 24 fps clip is 0.5. */
  rate: number;
}

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

export function clipMap(info: ClipInfo, p: ClipParams): ClipMap {
  const a = clamp01(Math.min(p.trim[0], p.trim[1])) * info.duration;
  const b = clamp01(Math.max(p.trim[0], p.trim[1])) * info.duration;
  const span = Math.max(b - a, info.fps > 0 ? 1 / info.fps : 0.001);
  const rate = p.fps > 0 && info.fps > 0 ? p.fps / info.fps : 1;
  return { a, span, rate };
}

/** Position inside the trimmed span before wrapping or clamping (negative before the start, >= span after the end). */
export const clipLocal = (m: ClipMap, p: ClipParams, seconds: number): number => (seconds + p.offset) * m.rate;

/** Seconds into the clip that is shown (and heard) at transport time `seconds`. 0 for clips with no duration. */
export function clipSourceTime(info: ClipInfo, p: ClipParams, seconds: number): number {
  if (!(info.duration > 0)) return 0;
  const m = clipMap(info, p);
  const local = clipLocal(m, p, seconds);
  return m.a + (p.loopVideo ? ((local % m.span) + m.span) % m.span : Math.min(Math.max(local, 0), m.span - 1e-4));
}
