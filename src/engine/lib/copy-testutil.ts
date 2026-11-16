/**
 * Test helper for loops. `t.loopCheck` cannot see a seam: the clock wraps, so its last frame IS its first. This renders every frame of a
 * short loop and compares the step across the wrap (last frame -> first frame) with the ordinary frame-to-frame steps.
 * A seamless loop has `wrap` about as small as `typical`; a pop has `wrap` many times larger.
 */
import type { Harness } from '../testing';
import type { ImageValue, MaskValue } from '../types';

export async function seamRatio(
  t: Harness,
  type: string,
  params: Record<string, unknown>,
  inputs: Record<string, ImageValue | MaskValue | number>,
  frames = 16,
  size = { width: 48, height: 48 },
): Promise<{ wrap: number; typical: number; max: number; motion: number }> {
  const project = { fps: 8, duration: frames / 8, loop: true, ...size };
  const shots: Uint8ClampedArray[] = [];
  for (let f = 0; f < frames; f++) {
    const out = await t.run(type, params, inputs, { seconds: f / 8, project });
    const key = Object.keys(out).find((k) => out[k] && typeof out[k] === 'object' && 'texture' in (out[k] as object))!;
    shots.push(await t.gpu.read(out[key] as ImageValue, false));
  }
  const d = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };
  const steps: number[] = [];
  for (let f = 0; f < frames - 1; f++) steps.push(d(shots[f], shots[f + 1]));
  const wrap = d(shots[frames - 1], shots[0]);
  return { wrap, typical: steps.reduce((a, b) => a + b, 0) / steps.length, max: Math.max(...steps), motion: d(shots[0], shots[Math.floor(frames / 2)]) };
}
