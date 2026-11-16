/**
 * Web worker that runs one scan job at a time (see job.ts): { id, source, name, index, options, previewSide }
 * -> { id, result, photoWidth, photoHeight, preview, decodeError? } | { id, error, code? }.
 * The photo is decoded here (createImageBitmap + OffscreenCanvas) and the cut frames, the rectified page and the preview go
 * back as transferables (moved, not copied).
 */
import { replyTransferables, runScanJob, type ScanJobRequest } from './job';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ScanJobRequest & { id: number }>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e) => {
  const { id, ...request } = e.data;
  try {
    const reply = await runScanJob(request);
    ctx.postMessage({ id, ...reply }, replyTransferables(reply));
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string })?.code });
  }
};
