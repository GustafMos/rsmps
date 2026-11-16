import type { MemoryInfo } from '../../io/api';

const MB = 1048576;
export const mb = (b: number): string => (b >= 1024 * MB ? `${(b / (1024 * MB)).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);

export interface MemRow {
  label: string;
  bytes: number;
  /** Plain-language note shown as a tooltip. */
  hint?: string;
}

/**
 * The breakdown shown by the memory meter, from `Io.memory()`. GPU rows are what the GPU holds (the total is the number the meter and
 * the budget use: every texture and buffer, pooled or scratch, in use or idle). RAM rows are system memory (not GPU).
 */
export function memoryBreakdown(info: MemoryInfo): { gpu: MemRow[]; ram: MemRow[]; gpuTotal: number } {
  const cats = info.gpuByCategory ?? {};
  const sum = (pred: (k: string) => boolean) => Object.entries(cats).reduce((n, [k, v]) => (pred(k) ? n + v.bytes : n), 0);
  const total = info.gpuTotalBytes ?? info.gpuPoolBytes;
  const idle = info.gpuIdleBytes ?? 0;
  const gpu: MemRow[] = [
    { label: 'Cached node results', bytes: info.engineCacheBytes, hint: 'Pictures of nodes kept so they are not calculated again' },
    { label: 'Decoded media', bytes: info.decodedMediaBytes, hint: 'Video frames and images decoded for the nodes that read them' },
    { label: 'Textures in total', bytes: info.gpuPoolBytes + sum((k) => k === 'scratch-texture' || k === 'texture'), hint: 'Every picture on the GPU, in use or waiting to be reused' },
    { label: 'Buffers', bytes: sum((k) => k.endsWith('buffer')), hint: 'Working data of the shaders' },
    { label: 'Idle, can be given back', bytes: idle, hint: 'Reusable memory nobody holds right now; Free memory now returns it' },
  ];
  const ram: MemRow[] = [
    { label: 'Rendered frames (instant playback)', bytes: info.ramFrameCacheBytes ?? info.frameCacheBytes, hint: 'Finished frames of the viewed node, kept packed in system RAM' },
    { label: 'Heavy results moved to RAM', bytes: info.ramColdBytes ?? 0, hint: 'Expensive node results that left the GPU but can come back without being calculated again' },
  ];
  return { gpu, ram, gpuTotal: total };
}

/** One-paragraph tooltip for the meter button. */
export function memoryTooltip(info: MemoryInfo, budget: number, pressure: string): string {
  const b = memoryBreakdown(info);
  const lines = [`GPU memory: ${mb(b.gpuTotal)} of ${mb(budget)} (${pressure})`, ...b.gpu.map((r) => `  ${r.label}: ${mb(r.bytes)}`)];
  lines.push(`System RAM: ${mb(b.ram.reduce((n, r) => n + r.bytes, 0))}${info.ramBudgetBytes ? ` of ${mb(info.ramBudgetBytes)}` : ''}`, ...b.ram.map((r) => `  ${r.label}: ${mb(r.bytes)}`));
  return lines.join('\n');
}
