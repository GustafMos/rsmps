import { expect, it } from 'vitest';
import type { MemoryInfo } from '../../io/api';
import { memoryBreakdown, memoryTooltip } from './memoryRows';

const MB = 1048576;
const info: MemoryInfo = {
  engineCacheBytes: 100 * MB,
  gpuPoolBytes: 300 * MB,
  frameCacheBytes: 50 * MB,
  decodedMediaBytes: 60 * MB,
  gpuTotalBytes: 330 * MB,
  gpuIdleBytes: 40 * MB,
  gpuByCategory: { 'pooled-texture': { count: 9, bytes: 300 * MB, peakBytes: 0 }, 'scratch-texture': { count: 1, bytes: 10 * MB, peakBytes: 0 }, 'uniform-buffer': { count: 2, bytes: 1 * MB, peakBytes: 0 }, 'scratch-buffer': { count: 2, bytes: 4 * MB, peakBytes: 0 } },
  ramBudgetBytes: 1536 * MB,
  ramFrameCacheBytes: 80 * MB,
  ramColdBytes: 20 * MB,
};

it('uses the GPU totals (textures + buffers, idle) and the RAM tier, not the old pool-only numbers', () => {
  const b = memoryBreakdown(info);
  expect(b.gpuTotal).toBe(330 * MB);
  expect(b.gpu.find((r) => r.label === 'Textures in total')?.bytes).toBe(310 * MB);
  expect(b.gpu.find((r) => r.label === 'Buffers')?.bytes).toBe(5 * MB);
  expect(b.gpu.find((r) => r.label.startsWith('Idle'))?.bytes).toBe(40 * MB);
  expect(b.ram.map((r) => r.bytes)).toEqual([80 * MB, 20 * MB]);
  expect(memoryTooltip(info, 768 * MB, 'ok')).toContain('330 MB of 768 MB');
  expect(memoryTooltip(info, 768 * MB, 'ok')).toContain('100 MB of 1.5 GB');
});
