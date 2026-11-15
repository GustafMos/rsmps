/**
 * Always-on GPU error watch. A WebGPU pass that hits an error (out of memory, invalid texture) is silently dropped and the
 * target keeps whatever it held before: a WRONG picture without any warning. This turns the first uncaptured GPU error into a
 * readable message that exports and the player surface.
 */
export class GpuWatch {
  /** First error since the last `take()`. */
  first: string | null = null;
  private listeners = new Set<(message: string) => void>();

  attach(device: GPUDevice): void {
    device.addEventListener?.('uncapturederror', (e) => {
      const err = (e as GPUUncapturedErrorEvent).error;
      const message = `${err?.constructor?.name === 'GPUOutOfMemoryError' ? 'The GPU ran out of memory' : 'GPU error'}: ${err?.message ?? 'unknown'}`;
      console.error('WebGPU error:', message);
      this.first ??= message;
      for (const l of [...this.listeners]) l(message);
    });
  }

  /** Read and clear the first error. */
  take(): string | null {
    const m = this.first;
    this.first = null;
    return m;
  }

  onError(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Human message for an error-scope result. */
export function scopeMessage(kind: 'out-of-memory' | 'validation', err: { message: string } | null): string | null {
  if (!err) return null;
  return kind === 'out-of-memory' ? `The GPU ran out of memory: ${err.message}` : `GPU validation error: ${err.message}`;
}
