import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import type { Gpu } from '../../engine/gpu/gpu';
import { testGpu } from '../../engine/testing';
import { renderGraphBatch } from '../render';
import { builtinRegistry, chain, readRaw, tempDir } from './testkit';

const registry = builtinRegistry();
let gpu: Gpu;
beforeAll(async () => {
  gpu = await testGpu();
}, 60_000);

/** shape -> [render-scale] -> Output, exported through the normal CLI path (no changes to the exporter or CLI were needed for the node). */
async function exportShape(scale: number | null) {
  const steps: { type: string; params?: Record<string, unknown> }[] = [{ type: 'shape', params: { kind: 'ellipse', width: 0.5, height: 0.6, fill: [1, 0, 0, 1] } }];
  if (scale !== null) steps.push({ type: 'render-scale', params: { scale } });
  const c = chain(registry, steps, { width: 96, height: 54 }, { kind: 'image', name: 'frame' });
  const out = tempDir();
  const sum = await renderGraphBatch({ graph: c.graph, registry, outDir: out, sequenceFps: 12, gpu });
  expect(sum.errors).toEqual([]);
  return readRaw(join(out, 'frame.png'));
}

it('an Output fed by Render Scale 25 % exports at the full frame size, with the soft low-res look', async () => {
  const plain = await exportShape(null);
  const scaled = await exportShape(25);
  expect([scaled.width, scaled.height]).toEqual([96, 54]);
  expect([plain.width, plain.height]).toEqual([96, 54]);
  // hard edge in the plain render, smeared over several texels in the 25 % render
  const mid = (img: typeof plain) => {
    let partial = 0;
    for (let x = 0; x < img.width; x++) {
      const a = img.at(x, 27)[3];
      if (a > 20 && a < 235) partial++;
    }
    return partial;
  };
  expect(mid(scaled)).toBeGreaterThan(mid(plain) + 2);
  expect(Buffer.compare(plain.data, scaled.data)).not.toBe(0);
});
