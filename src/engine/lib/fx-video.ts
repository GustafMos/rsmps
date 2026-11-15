import type { ImageValue, SocketValueMap, TimeInfo } from '../types';
import { wrapSeconds } from './util-time';

/** The part of a render context the time helpers need. */
export interface TimeCtx {
  time: TimeInfo;
  pull(input: never, at: { seconds: number }): Promise<unknown>;
}

/**
 * Pull an input `frames` frames away from the current one (negative = earlier). When the project loops the
 * time wraps around the loop, so trails and delays join up at the seam. Reading the clock makes the node
 * time-dependent, which is exactly what a temporal effect needs.
 */
export async function pullFrames(ctx: TimeCtx, input: string, frames: number): Promise<ImageValue | null> {
  const t = ctx.time;
  let seconds = t.seconds + frames / t.fps;
  if (t.loop) seconds = wrapSeconds(seconds, t.duration, t.fps);
  else seconds = Math.max(0, seconds);
  const v = (await ctx.pull(input as never, { seconds })) as SocketValueMap[keyof SocketValueMap] | null;
  return v && typeof v === 'object' && 'texture' in v ? (v as ImageValue) : null;
}

/** WGSL: RGB <-> YIQ (NTSC). Work on gamma-encoded values like a real composite signal. */
export const YIQ_WGSL = /* wgsl */ `
fn rgbToYiq(c: vec3f) -> vec3f {
  return vec3f(
    0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
    0.596 * c.r - 0.274 * c.g - 0.322 * c.b,
    0.211 * c.r - 0.523 * c.g + 0.312 * c.b);
}
fn yiqToRgb(c: vec3f) -> vec3f {
  return vec3f(
    c.x + 0.956 * c.y + 0.621 * c.z,
    c.x - 0.272 * c.y - 0.647 * c.z,
    c.x - 1.106 * c.y + 1.703 * c.z);
}`;

/** Soft highlight roll-off used where a display would clip: linear up to 0.8, then smoothly approaches 1. */
export const SOFTCLIP_WGSL = /* wgsl */ `
fn softClip(x: vec3f) -> vec3f {
  let k = 0.8;
  let over = max(x - vec3f(k), vec3f(0.0));
  return select(x, vec3f(k) + (1.0 - k) * tanh(over / (1.0 - k)), x > vec3f(k));
}`;
