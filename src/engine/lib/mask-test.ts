/**
 * Test helper for the mask / layer nodes.
 *
 * Works around a kernel problem: `createHeadlessDevice()` (gpu.ts) does `mod.create([]).requestAdapter()` and never keeps
 * the GPU instance, so the first garbage collection after the device exists destroys the Dawn instance and the next GPU
 * callback (a readback) segfaults the process. Any test that allocates a few MB (large images, CPU analysis) hits it.
 * Fix in the kernel: keep the instance reachable (e.g. `globalThis.__webgpu = gpu`). Until then this helper pins it.
 */
import { harness as baseHarness, type Harness } from '../testing';

let patched = false;

async function pinGpuInstances(): Promise<void> {
  if (patched) return;
  patched = true;
  const name = 'webgpu';
  const mod = (await import(/* @vite-ignore */ name)) as { globals: Record<string, { prototype?: Record<string, unknown> }> };
  const proto = mod.globals.GPU?.prototype;
  const original = proto?.requestAdapter as ((...a: unknown[]) => unknown) | undefined;
  if (!proto || !original) return;
  const keep: unknown[] = ((globalThis as unknown as { __pinnedGpu?: unknown[] }).__pinnedGpu ??= []);
  Object.defineProperty(proto, 'requestAdapter', {
    configurable: true,
    writable: true,
    value: function (this: unknown, ...args: unknown[]) {
      keep.push(this);
      return original.apply(this, args);
    },
  });
}

export async function harness(...args: Parameters<typeof baseHarness>): Promise<Harness> {
  await pinGpuInstances();
  return baseHarness(...args);
}
