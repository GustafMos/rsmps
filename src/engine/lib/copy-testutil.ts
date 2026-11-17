/**
 * Kept so existing imports work: the one loop test helper is `t.loopCheck` in `testing.ts` (it renders every frame of a loop and compares the
 * step across the wrap, last frame -> first frame, with the ordinary steps). `seamRatio` is that call with the older argument order.
 */
import type { Harness, LoopReport } from '../testing';

export async function seamRatio(
  t: Harness,
  type: string,
  params: Record<string, unknown>,
  inputs: Parameters<Harness['loopCheck']>[2] = {},
  frames = 16,
  size = { width: 48, height: 48 },
): Promise<LoopReport> {
  return t.loopCheck(type, params, inputs, { frames, size, fps: 8 });
}
