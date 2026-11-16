/**
 * Runs the scan of several photos at once and reports their progress. The runner (a worker pool, or the sequential main-thread
 * path) decides what really runs in parallel; this only starts everything in list order, keeps the results at their list
 * position whatever order they finish in, isolates failures per photo, and turns a cancel into one AbortError. Pure.
 */
import type { ScanProgressEvent } from '../../api';
import { PoolAbortError } from './pool';

export type BatchOutcome<T> = { ok: true; value: T } | { ok: false; error: Error };

export interface BatchOptions<T> {
  names: string[];
  /** Start photo `i`; call `started()` when it leaves the queue and begins to run. Rejecting fails only that photo. */
  run: (index: number, started: () => void) => Promise<T>;
  /** Reported as the number of photos scanned at the same time. */
  concurrency: number;
  onProgress?: (event: ScanProgressEvent) => void;
  signal?: AbortSignal;
}

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';

/** Outcomes by photo index (never by completion order). Rejects with an AbortError when `signal` aborted. */
export async function scanBatch<T>(o: BatchOptions<T>): Promise<BatchOutcome<T>[]> {
  const total = o.names.length;
  let completed = 0;
  const emit = (index: number, state: ScanProgressEvent['state'], error?: string) => {
    try {
      o.onProgress?.({ index, fileName: o.names[index], state, ...(error !== undefined ? { error } : {}), completed, total, concurrency: o.concurrency });
    } catch {
      /* a broken listener must not break the scan */
    }
  };
  for (let i = 0; i < total; i++) emit(i, 'queued');
  const outcomes = await Promise.all(
    o.names.map(async (_, i): Promise<BatchOutcome<T>> => {
      try {
        const value = await o.run(i, () => emit(i, 'scanning'));
        completed++;
        emit(i, 'done');
        return { ok: true, value };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (isAbort(error)) {
          emit(i, 'cancelled');
          return { ok: false, error };
        }
        completed++;
        emit(i, 'failed', error.message);
        return { ok: false, error };
      }
    }),
  );
  if (o.signal?.aborted) throw new PoolAbortError();
  return outcomes;
}
