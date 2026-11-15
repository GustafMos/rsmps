import type { Io } from '../io/api';

/**
 * The only place the UI reaches for the io implementation. Throws a readable error when
 * WebGPU is unavailable (createIo does that).
 */
export async function bootIo(): Promise<Io> {
  const mod = await import('../io');
  const io = await mod.createIo();
  await io.plugins.restore().catch((e: unknown) => console.warn('Plugin restore failed', e));
  await io.library.restore().catch((e: unknown) => console.warn('Library restore failed', e));
  return io;
}
