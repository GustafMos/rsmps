import type { Harness } from '../testing';
import type { ImageValue } from '../types';

/**
 * Resolution-independence check: runs `type` on a picture at 1x (unit 1) and at 2x (unit 2),
 * downsamples the 2x result and returns the mean absolute difference (0..255) between the two.
 */
export async function resolutionDiff(
  t: Harness,
  type: string,
  params: Record<string, unknown>,
  make: (w: number, h: number, x: (v: number) => number) => (px: number, py: number) => [number, number, number, number],
  size = 32,
): Promise<number> {
  const small = t.fromFn(size, size, make(size, size, (v) => v), 1);
  const big = t.fromFn(size * 2, size * 2, make(size * 2, size * 2, (v) => v), 2);
  const a = await t.pixels(((await t.run(type, params, { image: small })).image ?? null) as ImageValue);
  const b = await t.pixels(((await t.run(type, params, { image: big })).image ?? null) as ImageValue);
  let sum = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++) {
        let m = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) m += b.at(x * 2 + dx, y * 2 + dy)[c];
        sum += Math.abs(a.at(x, y)[c] - m / 4);
      }
  return sum / (size * size * 4);
}

/** Smooth test picture that scales with its size: diagonal gradient with a bright disc. */
export const scalable =
  (w: number, h: number) =>
  (x: number, y: number): [number, number, number, number] => {
    const u = x / w;
    const v = y / h;
    const disc = Math.hypot(u - 0.5, v - 0.5) < 0.2;
    const g = Math.round(((u + v) / 2) * 200);
    return disc ? [230, 90, 40, 255] : [g, g, Math.min(255, g + 30), 255];
  };
