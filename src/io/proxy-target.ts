import { PROXY_LEVELS } from './clock';

/** How big the picture is on the screen: its size in CSS pixels and the screen's pixel ratio. */
export interface ViewerTarget {
  /** Width of the whole picture as shown (CSS pixels), after zoom. */
  cssWidth: number;
  cssHeight: number;
  /** window.devicePixelRatio. */
  dpr: number;
}

/** A phone at pixel ratio 3 would ask for 9 times the pixels of a ratio-1 screen: two device pixels per CSS pixel look the same to the eye. */
export const MAX_DEVICE_RATIO = 2;

/**
 * The finest playback preview level worth rendering: the size the picture really has on the screen (CSS size times at most two), rounded
 * UP to the next level of PROXY_LEVELS, so the preview is never blurrier than the screen can show. 1 = full size. A picture shown at 100 %
 * or larger, or an unknown size, is not capped. Only used while playing: a paused frame is rendered at full size.
 */
export function playbackProxyCap(target: ViewerTarget | null, frame: { width: number; height: number }): number {
  if (!target || !(frame.width > 0) || !(frame.height > 0) || !(target.cssWidth > 0) || !(target.cssHeight > 0)) return 1;
  const ratio = Math.min(Math.max(1, target.dpr || 1), MAX_DEVICE_RATIO);
  const need = Math.max((target.cssWidth * ratio) / frame.width, (target.cssHeight * ratio) / frame.height);
  if (need >= 1) return 1;
  let level: number = PROXY_LEVELS[PROXY_LEVELS.length - 1];
  for (const l of PROXY_LEVELS) if (l >= need - 1e-9) level = l; // levels run from 1 down: the last one that is still >= need
  return level;
}
