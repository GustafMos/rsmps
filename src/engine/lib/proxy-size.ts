/**
 * The ONE rounding rule for "this frame at a playback proxy". The engine sizes its canvas with it, the player sizes the conformed
 * frame with it (`scaleSize` in io/frame.ts) and the Render Scale node sizes its enlarge target with it, so all three agree to the texel.
 */
export interface FrameSize {
  width: number;
  height: number;
}

/** Smallest / largest proxy factor the engine accepts. */
export const PROXY_MIN = 0.05;
export const PROXY_MAX = 1;

export function clampProxy(proxy: number): number {
  return Math.min(PROXY_MAX, Math.max(PROXY_MIN, proxy));
}

/** The frame at `proxy` (factor of the full frame, 0..1): each side rounded, at least 1 texel. */
export function proxySize(frame: FrameSize, proxy: number): FrameSize {
  return { width: Math.max(1, Math.round(frame.width * proxy)), height: Math.max(1, Math.round(frame.height * proxy)) };
}
