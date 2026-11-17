import { describe, expect, it } from 'vitest';
import { testGpu } from '../../engine/testing';
import { compressDxt, decompressDxt, dxtFrameBytes, psnr, type DxtFormat } from './dxt';
import { createHapGpuCompressor } from './hap-gpu';
import { makePicture } from './test-helpers';

// Premultiply like the engine does so the GPU path sees what it sees in the app.
async function upload(w: number, h: number, straight: Uint8Array) {
  const gpu = await testGpu();
  return { gpu, img: gpu.upload(straight, w, h, 1, true) };
}

describe('HAP GPU compression', () => {
  const W = 80;
  const H = 52;
  for (const fmt of ['Hap1', 'Hap5', 'HapY'] as DxtFormat[]) {
    for (const kind of ['gradient', 'noise', 'edges', 'alpha', 'pixelart'] as const) {
      it(`${fmt} ${kind}: bit-identical to the CPU path with refine 0`, async () => {
        const src = makePicture(kind, W, H, 5);
        const { gpu, img } = await upload(W, H, src);
        // What the engine actually holds, read back the way the exporter does.
        // Only HAP Alpha carries alpha (straight colour); HAP and HAP Q drop it, so they keep the premultiplied colour (the picture over black).
        const seen = new Uint8Array(fmt === 'Hap5' ? await gpu.read(img, true) : await gpu.readRaw(img));
        const comp = createHapGpuCompressor(gpu, W, H, fmt);
        const g = await comp.compress(img);
        const cpu = new Uint8Array(dxtFrameBytes(W, H, fmt));
        compressDxt(seen, W, H, fmt, cpu, { refine: 0 });
        expect(Buffer.from(g).equals(Buffer.from(cpu))).toBe(true);
        comp.dispose();
        if (kind === 'gradient') expect(psnr(src, decompressDxt(g, W, H, fmt))).toBeGreaterThan(30);
      });
    }
  }

  it('handles sizes that are not a multiple of 4 (edge replication) and reuses its buffers across frames', async () => {
    const w = 45;
    const h = 27;
    const gpu = await testGpu();
    const comp = createHapGpuCompressor(gpu, w, h, 'Hap5');
    for (const kind of ['gradient', 'alpha'] as const) {
      const src = makePicture(kind, w, h, 2);
      const img = gpu.upload(src, w, h, 1, true);
      const seen = new Uint8Array(await gpu.read(img, true));
      const g = new Uint8Array(await comp.compress(img));
      const cpu = new Uint8Array(dxtFrameBytes(w, h, 'Hap5'));
      compressDxt(seen, w, h, 'Hap5', cpu, { refine: 0 });
      expect(Buffer.from(g).equals(Buffer.from(cpu))).toBe(true);
    }
    comp.dispose();
  });
});
